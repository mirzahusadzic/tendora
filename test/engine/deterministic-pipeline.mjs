/** Retired model interpretations cannot alter original AMRs or supply current proofs. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createProject,
  editConcept,
  openProject,
  saveProject,
} from '../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import { readEngineArtifact } from '../../src/project/storage/engine-runs.mjs';
import { sourceCatalog } from '../../src/project/authoring/sources.mjs';
import { currentPartialParts } from '../../src/project/authoring/partial.mjs';
import { contributionRevision } from '../../src/project/authoring/development.mjs';
import { inputFromProject } from '../../src/engine/input.mjs';
import { runEngine } from '../../src/engine/run.mjs';
import { retainPartialContribution } from '../../src/engine/partial.mjs';
import { corpusRows } from '../../src/tui/concepts/corpus.mjs';
import {
  projectOutlineIndex,
  developmentOutline,
} from '../../src/tui/concepts/project-outline.mjs';
import { inquirySections } from '../../src/tui/engine/view.mjs';

await mkdir('evaluations/test-runs', { recursive: true });
const directory = await mkdtemp(resolve('evaluations/test-runs/deterministic-'));
const previousFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('Retained reasoning must not contact any model');
};
try {
  let project = await createProject(directory, 'Gate', 'Gate');
  const scope = project.data.placements[0].id;
  const sourceText = 'Mira opens a gate.';
  const question = 'Does Mira open a gate?';
  project = await saveProject(
    project,
    editConcept(project.data, project.data.concepts[0].id, 'Gate', [sourceText]),
  );
  await retainAcquisitions(
    project,
    [
      {
        text: sourceText,
        penman: '(o / open-01 :ARG0 (p / person :name (n / name :op1 "Mira")) :ARG1 (g / gate))',
      },
      {
        text: question,
        penman:
          '(o / open-01 :ARG0 (p / person :name (n / name :op1 "Mira")) :ARG1 (g / gate) :polarity (u / amr-unknown))',
      },
    ].map((entry) => ({ ...entry, origin: { kind: 'frozen-test-ingress' } })),
  );
  const original = await inputFromProject(project, { scopePlacementId: scope, question });
  const initial = await runEngine(project, { input: original, trace: false });
  assert.equal(initial.status, 'supported');
  assert.deepEqual(
    initial.answer.answers.map((answer) => answer.text),
    ['Yes'],
  );
  const originalMaterial = await readEngineArtifact(project, initial.resultRef);
  // Conflicting and stale generations remain readable history after reload.
  const legacy = [
    {
      kind: 'vocabulary',
      id: 'old-vocabulary',
      scopePlacementId: scope,
      sources: [],
      vocabulary: {},
    },
    {
      kind: 'source',
      id: 'old-source',
      text: sourceText,
      vocabularyId: 'old-vocabulary',
      scopePlacementId: scope,
      graph: { top: 'x', nodes: [{ id: 'x', concept: 'false-answer' }], edges: [] },
    },
    {
      kind: 'question',
      id: 'old-question',
      text: question,
      scopePlacementId: scope,
      vocabularyId: 'old-vocabulary',
      status: 'accepted',
    },
  ];
  project = await saveProject(project, { ...project.data, semanticReadings: legacy });
  project = await openProject(directory);
  const input = await inputFromProject(project, { scopePlacementId: scope, question });
  const run = await runEngine(project, { input, trace: false, acquireMissing: true });
  assert.equal(run.status, 'supported');
  assert.deepEqual(
    run.answer.answers.map((answer) => answer.text),
    initial.answer.answers.map((answer) => answer.text),
  );
  assert(run.calls.every((call) => call.client === 'PENMAN'));
  assert.equal(run.semantic, undefined);
  assert(!run.stages.some((stage) => stage.id.startsWith('semantic')));
  const material = await readEngineArtifact(project, run.resultRef);
  assert.deepEqual(
    material.inputs.map((entry) => entry.graph),
    originalMaterial.inputs.map((entry) => entry.graph),
  );
  assert.deepEqual((await openProject(directory)).data.semanticReadings, legacy);
  assert(!corpusRows(project.data, []).some((row) => row.kind === 'Language reading'));
  await assert.rejects(runEngine(project, { input, acquireSemantic: true }), /removed/);
  await assert.rejects(runEngine(project, { input, questionAlignment: true }), /removed/);

  const retired = { ...run, semantic: { status: 'retained' } };
  const outline = developmentOutline(projectOutlineIndex(project.data, [retired], project.digest));
  const item = outline.find((entry) => entry.latestRun?.id === run.id);
  assert(item);
  assert.equal(item.currentRun, null);
  assert(
    JSON.stringify(inquirySections(retired, input, material)).includes(
      'retired interpretation pipeline',
    ),
  );
  assert.throws(
    () => retainPartialContribution(project, input, { ...material, semantic: retired.semantic }),
    /retired/,
  );
  const catalog = sourceCatalog(project.data);
  const sourceInput = material.inputs.find((entry) => entry.kind === 'source');
  const questionInput = material.inputs.find((entry) => entry.kind === 'question');
  const contribution = {
    id: 'gate-contribution',
    scopePlacementId: scope,
    question: { text: question, graph: questionInput.graph },
    partial: {
      questionRevision: contributionRevision(questionInput.graph),
      readings: [
        {
          placementId: catalog[0].nodeId,
          sentenceId: catalog[0].sentenceId,
          revision: catalog[0].revision,
          graph: sourceInput.graph,
          penman: sourceInput.penman,
        },
      ],
      parts: [
        {
          root: sourceInput.graph.top,
          edgeIds: sourceInput.graph.edges.map((edge) => edge.id),
          sources: [catalog[0]],
        },
      ],
    },
  };
  assert(
    currentPartialParts(project.data, contribution).some((part) => part.current),
    'A replayable retained reading supplies current support',
  );
  const generatedSource = structuredClone(contribution);
  generatedSource.partial.readings[0].semanticReadingId = 'old-source';
  assert(currentPartialParts(project.data, generatedSource).every((part) => !part.current));
  const generatedQuestion = structuredClone(contribution);
  generatedQuestion.partial.assessment = { semanticReading: { id: 'old-question' } };
  assert(currentPartialParts(project.data, generatedQuestion).every((part) => !part.current));
  console.log(
    'ok deterministic Ask preserves original AMRs, ignores retired readings, rejects generation and archives old proofs',
  );
} finally {
  globalThis.fetch = previousFetch;
  await rm(directory, { recursive: true, force: true });
}
