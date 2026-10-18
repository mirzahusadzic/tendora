/** Frozen language, persistent owners, selective retraction and cold attributed replay. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createProject,
  editConcept,
  openProject,
  saveProject,
} from '../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import { inputFromProject } from '../../src/engine/input.mjs';
import { prepareInquiry } from '../../src/engine/preparation.mjs';
import { checkAnswer } from '../../src/engine/answer.mjs';
import {
  retainPartialContribution,
  recheckPartialContribution,
} from '../../src/engine/partial.mjs';
import {
  currentPartialContribution,
  currentPartialParts,
} from '../../src/project/authoring/partial.mjs';
import { addMaterial, withdrawContributionPart } from '../../src/engine/develop.mjs';

const question = 'Does a person repair a bicycle in a workshop with a tool?';
const independent = 'What does a person repair?';
const firstText = 'A person repairs a bicycle.';
const secondText = 'Another person repairs a bicycle.';
const branchText = 'A person repairs a bicycle in a workshop.';
const negativeText = 'A person does not repair a bicycle.';
const conditionalText = 'If a bicycle is ready, a person repairs it.';
const premiseText = 'A bicycle is ready.';
const captures = [
  [
    question,
    '(r / repair-01 :polarity (u / amr-unknown) :ARG0 (p / person) :ARG1 (b / bicycle) :location (w / workshop) :instrument (t / tool))',
  ],
  [independent, '(r / repair-01 :ARG0 (p / person) :ARG1 (u / amr-unknown))'],
  [firstText, '(r / repair-01 :ARG0 (p / person) :ARG1 (b / bicycle))'],
  [secondText, '(r / repair-01 :ARG0 (p / person) :ARG1 (b / bicycle))'],
  [branchText, '(r / repair-01 :ARG0 (p / person) :ARG1 (b / bicycle) :location (w / workshop))'],
  [negativeText, '(r / repair-01 :polarity - :ARG0 (p / person) :ARG1 (b / bicycle))'],
  [
    conditionalText,
    '(r / repair-01 :ARG0 (p / person) :ARG1 (b / bicycle) :condition (s / ready-01 :ARG1 b))',
  ],
  [premiseText, '(s / ready-01 :ARG1 (b / bicycle))'],
];
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/partial-replay-'));
const fetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('Partial replay must never request a model');
};
try {
  let project = await createProject(directory, 'Replay', 'Workshop');
  const scope = project.data.placements[0].id;
  const concept = project.data.concepts[0].id;
  await retainAcquisitions(
    project,
    captures.map(([text, penman]) => ({ text, penman, origin: { kind: 'frozen-synthetic' } })),
  );
  const edit = async (texts) => {
    project = await saveProject(project, editConcept(project.data, concept, 'Workshop', texts));
  };
  const ask = async (text = question, options) => {
    const input = await inputFromProject(project, { scopePlacementId: scope, question: text });
    const { records } = await prepareInquiry(input);
    const result = { inputs: records };
    return { input, result, answer: checkAnswer(project, input, result, options) };
  };
  const save = async (result) => {
    project = await saveProject(project, result.data);
    return result.contribution;
  };
  await edit([firstText, secondText]);
  const initial = await ask();
  assert.equal(initial.answer.partial.parts.length, 2);
  let c = await save(retainPartialContribution(project, initial.input, initial.result));
  const id = c.id;
  const parts = c.partial.parts.map((part) => part.id).sort();
  const openings = c.partial.aporias.map((opening) => opening.id).sort();
  assert.equal(openings.length, 2);
  const assertShape = (partial) => {
    for (const item of [...partial.parts, ...partial.aporias]) {
      assert(item.id);
      assert(item.anchor.nodeId || item.anchor.edgeId);
      assert.equal(item.scope.placementId, scope);
      assert(Array.isArray(item.bindings));
      assert(Array.isArray(item.dependencies));
      assert(Array.isArray(item.candidateConnections));
      assert(item.evidenceHistory.length);
      assert(item.questionRevision);
    }
    for (const part of partial.parts.filter((part) => part.current)) {
      assert(part.supports.length);
      assert(
        part.supports.every(
          (proof) =>
            proof.derivation &&
            proof.witnesses.length &&
            proof.dependencies.every((d) => d.revision && d.graphRevision),
        ),
      );
    }
  };
  assertShape(c.partial);
  const historyIds = c.partial.parts.map((part) => part.evidenceHistory.at(-1).id).sort();
  project = await openProject(directory);
  c = project.data.contributions.find((entry) => entry.id === id);
  let replay = currentPartialContribution(project.data, c);
  assertShape(replay);
  assert.deepEqual(
    replay.parts
      .filter((part) => part.current)
      .map((part) => part.id)
      .sort(),
    parts,
  );
  assert.deepEqual(replay.parts.map((part) => part.evidenceHistory.at(-1).id).sort(), historyIds);
  assert(replay.parts.every((part) => part.evidenceHistory.length === 1));
  await edit([secondText, firstText]);
  const reordered = await ask();
  assert.deepEqual(
    reordered.answer.partial.contributions[0].partial.parts
      .filter((part) => part.current)
      .map((part) => part.id)
      .sort(),
    parts,
  );
  c = await save(recheckPartialContribution(project, id, reordered.input, reordered.result));
  assert(
    c.partial.parts.every((part) => part.evidenceHistory.length === 1),
    'Reordering does not manufacture evidence events',
  );
  await rm(join(directory, 'engine'), { force: true, recursive: true });
  project = await openProject(directory);
  c = project.data.contributions.find((entry) => entry.id === id);
  assert.deepEqual(
    currentPartialParts(project.data, c)
      .filter((part) => part.current)
      .map((part) => part.id)
      .sort(),
    parts,
  );
  const revisit = await ask(independent);
  const related = revisit.answer.openings.find((opening) => opening.contributionId === id);
  assert(
    related?.partial,
    'An independent question returns the owned, freshly assessed contribution',
  );
  assert.deepEqual(related.partial.aporias.map((opening) => opening.id).sort(), openings);
  assert(related.partial.parts.every((part) => part.current));

  const location = c.partial.aporias.find((opening) => opening.role === ':location');
  const branch = await addMaterial(
    project,
    {
      text: branchText,
      scopePlacementId: scope,
      anchor: {
        contributionId: id,
        partId: 'question',
        nodeId: location.anchor.to,
        revision: c.partial.questionRevision,
      },
    },
    { offline: true },
  );
  const child = await save(branch);
  const elaborated = await ask();
  c = await save(recheckPartialContribution(project, id, elaborated.input, elaborated.result));
  assertShape(c.partial);
  assert.equal(
    c.partial.parts.filter((part) => part.current).length,
    3,
    'Independent event occurrences stay separate',
  );
  assert.equal(c.partial.aporias.find((opening) => opening.id === location.id).state, 'supported');
  assert.equal(c.partial.openings.filter((opening) => opening.role === ':instrument').length, 1);
  assert(parts.every((id) => c.partial.parts.some((part) => part.id === id && part.current)));
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, child.id, child.responses[0].id),
  );
  c = await save(recheckPartialContribution(project, id));
  assert.deepEqual(
    c.partial.parts
      .filter((part) => part.current)
      .map((part) => part.id)
      .sort(),
    parts,
  );
  assert.equal(c.partial.aporias.find((opening) => opening.id === location.id).state, 'open');
  assert(
    c.partial.parts
      .find((part) => !parts.includes(part.id))
      .evidenceHistory.some((entry) => entry.proofs?.[0]?.derivation),
  );

  await edit([firstText]);
  c = await save(recheckPartialContribution(project, id));
  assert.equal(c.partial.parts.filter((part) => part.current).length, 1);
  const survivingId = c.partial.parts.find((part) => part.current).id;
  await edit([negativeText]);
  replay = currentPartialContribution(project.data, c);
  assert(
    !replay.parts.some((part) => part.current),
    'Changed source context never promotes an old positive proof',
  );
  assert(
    replay.replay.missingReadings.length,
    'A revised source needs its own acquisition, not the saved graph',
  );
  const negative = await ask();
  c = await save(recheckPartialContribution(project, id, negative.input, negative.result));
  assert(!c.partial.parts.some((part) => part.current));
  assert(c.partial.parts.some((part) => part.id === survivingId));
  await edit([]);
  project = await openProject(directory);
  c = await save(recheckPartialContribution(project, id));
  assert(c.partial.parts.every((part) => !part.current));
  assert.equal(c.partial.aporias.find((opening) => opening.id === location.id).state, 'open');
  assert.deepEqual(c.responses, [], 'A retained question never becomes a source assertion');

  await edit([firstText, conditionalText, premiseText]);
  const conditional = await ask();
  assert(
    conditional.answer.partial.parts.some((part) => part.ruleIds.length),
    'AMR conditions generate the rule used by partial proofs',
  );
  c = await save(recheckPartialContribution(project, id, conditional.input, conditional.result));
  const ruleParts = c.partial.parts
    .filter((part) => part.current && part.ruleIds.length)
    .map((part) => part.id);
  const directParts = c.partial.parts
    .filter((part) => part.current && !part.ruleIds.length)
    .map((part) => part.id);
  assert(ruleParts.length);
  await edit([premiseText, firstText, conditionalText]);
  const ruleReorder = await ask();
  c = await save(recheckPartialContribution(project, id, ruleReorder.input, ruleReorder.result));
  assert.deepEqual(
    c.partial.parts.filter((part) => part.current && part.ruleIds.length).map((part) => part.id),
    ruleParts,
  );
  await edit([firstText, premiseText]);
  c = await save(recheckPartialContribution(project, id));
  assert(
    c.partial.parts.filter((part) => part.current).every((part) => directParts.includes(part.id)),
    'Rule source removal retracts only the rule-dependent support',
  );
  assert(ruleParts.every((id) => c.partial.parts.some((part) => part.id === id && !part.current)));

  const limited = currentPartialContribution(project.data, c, {
    partialCoverage: { stateLimit: 0 },
  });
  assert(limited.parts.every((part) => !part.current && part.state === 'unverified'));
  assert.equal(limited.complete, false);
  const legacy = structuredClone(c);
  delete legacy.partial.readings;
  assert(
    currentPartialParts(project.data, legacy).every((part) => !part.current),
    'A legacy snapshot without acquisitions is never current proof',
  );
  const changedQuestion = structuredClone(c);
  changedQuestion.question.graph.edges = changedQuestion.question.graph.edges.filter(
    (edge) => edge.role !== ':instrument',
  );
  const invalidated = currentPartialContribution(project.data, changedQuestion);
  assert.equal(invalidated.replay.status, 'question-changed');
  assert(invalidated.parts.every((part) => !part.current));
  changedQuestion.partial = invalidated;
  assert.equal(
    currentPartialContribution(project.data, changedQuestion).replay.status,
    'question-changed',
    'Saving an invalidation cannot silently retarget its anchors',
  );
  const contextual = structuredClone(c);
  contextual.partial.caseSelection = {
    projectId: project.data.id,
    placementId: scope,
    sources: [],
  };
  assert.equal(
    currentPartialContribution(project.data, contextual).replay.status,
    'case-recheck-required',
  );
  assert(
    currentPartialParts(project.data, contextual).every((part) => !part.current),
    'A case-bound proof is never replayed as unconditional support',
  );
  const scoped = structuredClone(project.data);
  scoped.sourceScopes = c.partial.parts
    .filter((part) => part.current)
    .flatMap((part) =>
      part.sources.map((source) => ({
        placementId: source.nodeId,
        sentenceId: source.sentenceId,
        text: source.text,
        revision: source.revision,
        scopePlacementId: scope,
        caseTexts: ['A separate case is required.'],
        attribution: 'Frozen scope control',
      })),
    );
  assert(
    currentPartialParts(scoped, c).every((part) => !part.current),
    'Changed source scope retracts matching unqualified support',
  );
  console.log(
    'ok persistent identities, independent revisit, anchored elaboration, selective withdrawal, source revision/removal, rule ablation, sentence order, cache rebuild and bounded replay',
  );
} finally {
  globalThis.fetch = fetch;
  await rm(directory, { recursive: true, force: true });
}
