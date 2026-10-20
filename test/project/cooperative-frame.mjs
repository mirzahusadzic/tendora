/** Legacy continuation capture and purpose-only persistence without live models. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, saveProject, openProject } from '../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import {
  addAsk,
  currentAsk,
  newInvestigation,
  readInvestigation,
  saveInvestigation,
  reviseIntention,
} from '../../src/project/inquiries/investigation.mjs';
import { captureProjectInquiry } from '../../src/project/inquiries/inquiry.mjs';
import {
  buildInquiryFrame,
  finalizedContinuationFrame,
  purposeOnlyCarry,
} from '../../src/project/inquiries/frame.mjs';
import { authoredContinuation, evidenceOpenings } from '../../src/recording/continuation.mjs';
import { authorInterpretation } from '../../src/recording/interpretation.mjs';
import { graphRevision } from '../../src/recording/revisions.mjs';
import { indexRecording } from '../../src/tui/recordings/view.mjs';
import { frozenParser } from '../support/development-acquisition.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/cooperative-project-'));
const fixture = JSON.parse(
  await readFile(new URL('../support/qa-development-acquisitions.json', import.meta.url)),
);
const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = frozenParser(requests);
try {
  let project = await createProject(directory, 'Cooperative project', 'Workshop');
  const data = structuredClone(project.data);
  data.concepts[0].passages = ['Sam repairs bicycles.'];
  project = await saveProject(project, data);
  await retainAcquisitions(
    project,
    [
      ['Sam repairs bicycles.', '(r / repair-01 :ARG0 (s / Sam) :ARG1 (b / bicycle))'],
      ['Who repairs bicycles?', '(r / repair-01 :ARG0 (u / amr-unknown) :ARG1 (b / bicycle))'],
      ['What does Sam repair?', '(r / repair-01 :ARG0 (s / Sam) :ARG1 (u / amr-unknown))'],
    ].map(([text, penman]) => ({
      text,
      penman,
      acquisition: fixture.entries.find((entry) => entry.text === text)?.acquisition,
      origin: { kind: 'cooperative-project-regression' },
    })),
  );

  const firstInput = {
    projectId: project.data.id,
    projectRevision: project.digest,
    scopePlacementId: project.data.placements[0].id,
    sources: [
      {
        id: 'source',
        kind: 'source',
        placementId: project.data.placements[0].id,
        sentenceId: 'source/sentence',
        revision: project.digest,
        text: 'Sam repairs bicycles.',
      },
    ],
    cases: [],
    caseSelection: null,
    question: { text: 'Who repairs bicycles?', kind: 'question' },
  };
  const firstRun = await captureProjectInquiry(
    project,
    firstInput.scopePlacementId,
    firstInput.question.text,
    () => {},
    undefined,
    { acquireMissing: false, trace: false },
  );
  assert.equal(firstRun.recording.inquiry.text, 'Who repairs bicycles?');

  {
    const ix = indexRecording(firstRun.recording),
      occurrence = firstRun.recording.occurrences.find((item) => item.sourceId),
      selection = { nodeId: occurrence.nodeId, occurrenceId: occurrence.id },
      parentQuery = firstRun.recording.graphs.find(
        (graph) => graph.id === firstRun.recording.inquiry.graphId,
      ),
      proposal = authorInterpretation(ix, {
        occurrenceId: occurrence.id,
        queryEdits: [
          { kind: 'add-node', id: 'accepted-qualifier', concept: 'accepted' },
          {
            kind: 'add-edge',
            id: 'accepted-qualifier-edge',
            from: parentQuery.top,
            role: ':mod',
            to: 'accepted-qualifier',
          },
        ],
      }),
      decision = { id: 'accepted-interpretation', decision: 'accepted', proposal },
      opening = evidenceOpenings(ix, selection, [decision]).find((item) => item.kind === 'query'),
      continuation = authoredContinuation(ix, selection, firstRun.path, opening, [decision], {
        action: 'continue-opening',
        rationale: 'Continue from the accepted reading.',
      });
    assert(opening, 'The accepted interpretation exposes a query opening');
    assert(continuation.interpretedGraphs, 'The continuation retains the accepted reading');
    assert.notEqual(
      graphRevision(continuation.interpretedGraphs.query),
      graphRevision(parentQuery),
      'The accepted reading is distinct from the parent parser graph',
    );
    const source = firstRun.recording.sources[0],
      sourceGraph = firstRun.recording.graphs.find((graph) => graph.id === source.graphId),
      finalized = finalizedContinuationFrame(project, continuation, {
        reasoning: {
          inputs: [
            {
              kind: 'question',
              text: continuation.question,
              graph: continuation.interpretedGraphs.query,
            },
            {
              kind: 'source',
              id: source.id,
              placementId: source.nodeId,
              sentenceId: source.sentenceId,
              revision: source.revision,
              graph: sourceGraph,
              text: source.text,
            },
          ],
        },
        engineProjectDigest: firstRun.recording.project?.digest ?? project.digest,
        scopePlacementId: firstInput.scopePlacementId,
      });
    assert.equal(finalized.version, 3);
    assert.equal(finalized.carry.origin.frameRevision, continuation.originFrame.id);
    assert.equal(finalized.carry.origin.opening.id, opening.id);
  }

  for (const version of [1, 2]) {
    const queryGraph = firstRun.recording.graphs.find(
      (graph) => graph.id === firstRun.recording.inquiry.graphId,
    );
    const legacy = {
      schema: 'tendora.continuation',
      version,
      author: 'participant',
      contextUse: 'review-only',
      assumption: null,
      parent: {
        path: firstRun.path,
        revision: 'legacy-parent-revision',
        project: firstRun.recording.project,
        question: 'Who repairs bicycles?',
        nodeId: firstRun.recording.nodes[0].id,
        occurrenceId: 'legacy-parent-occurrence',
        route: [
          { nodeId: firstRun.recording.nodes[0].id, label: firstRun.recording.nodes[0].label },
        ],
        source: firstRun.recording.sources[0],
        sourceGraph: firstRun.recording.graphs.find(
          (graph) => graph.id === firstRun.recording.sources[0].graphId,
        ),
        queryGraph,
      },
      opening: {
        id: 'question',
        kind: 'question',
        label: 'Who repairs bicycles?',
      },
      history: [
        {
          question: 'Who repairs bicycles?',
          path: firstRun.path,
          revision: 'legacy-parent-revision',
          scopePlacementId: firstInput.scopePlacementId,
          scopeLabel: 'Workshop',
        },
      ],
    };
    if (version === 1) {
      delete legacy.history;
      legacy.opening = {
        id: queryGraph.edges[0].id,
        kind: 'query',
        label: 'repair relationship',
        edge: queryGraph.edges[0],
      };
    } else {
      legacy.question = 'What does Sam repair?';
      legacy.scopePlacementId = firstInput.scopePlacementId;
      legacy.history[0].revision = 'legacy-parent-revision';
    }
    const result = await captureProjectInquiry(
      project,
      firstInput.scopePlacementId,
      'What does Sam repair?',
      () => {},
      undefined,
      {
        acquireMissing: false,
        trace: false,
        continuation: legacy,
        ask: {
          investigationId: 'legacy-investigation',
          askId: `legacy-ask-${version}`,
          revision: 1,
          question: 'What does Sam repair?',
          intention: { id: 'purpose', text: 'Who repairs bicycles?' },
          origin: { path: firstRun.path, recordingRevision: 'legacy-parent-revision' },
        },
      },
    );
    assert.equal(result.recording.continuation.version, version);
    assert(!result.recording.continuation.originFrame, 'Legacy records are not rewritten as v3');
    assert.equal(result.recording.inquiry.text, 'What does Sam repair?');
  }

  const completed = await openProject(directory);
  let investigation = newInvestigation(completed, 'Who repairs bicycles?');
  investigation = addAsk(investigation, {
    question: 'Who repairs bicycles?',
    scopePlacementId: completed.data.placements[0].id,
  });
  const ask = currentAsk(investigation);
  const questionRevision = graphRevision({
    top: 'r',
    nodes: [{ id: 'r', concept: 'repair-01' }],
    edges: [],
  });
  ask.checkedFrame = buildInquiryFrame(completed, {
    question: ask.question,
    scopePlacementId: ask.scopePlacementId,
    intention: investigation.intentions.at(-1),
    questionRevision,
  });
  ask.frame = ask.checkedFrame;
  ask.intention = investigation.intentions.at(-1);
  const revised = reviseIntention(investigation, 'Explain repair authority.', {
    path: firstRun.path,
    recordingRevision: 'legacy-parent-revision',
  });
  const nextAsk = currentAsk(revised);
  nextAsk.intentionId = revised.intentions.at(-1).id;
  const current = buildInquiryFrame(completed, {
    question: nextAsk.question,
    scopePlacementId: nextAsk.scopePlacementId,
    intention: revised.intentions.at(-1),
    questionRevision: ask.checkedFrame.question.revision,
  });
  const purpose = purposeOnlyCarry(
    { ...nextAsk, origin: ask.origin },
    ask.checkedFrame,
    revised.intentions.at(-1),
    'Purpose only.',
    current,
  );
  assert.equal(purpose.carry.status, 'checked');
  assert.equal(purpose.carry.support, 'unchanged');
  const saved = await saveInvestigation(completed, revised);
  assert.equal(currentAsk(saved.data).intentionId, revised.intentions.at(-1).id);
  const reloaded = await readInvestigation(completed, saved.data.id);
  assert.equal(reloaded.data.intentions.at(-1).text, 'Explain repair authority.');

  console.log(
    'ok cooperative project: legacy v1/v2 capture remains readable; purpose-only edits retain an unchanged checked assessment',
  );
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
