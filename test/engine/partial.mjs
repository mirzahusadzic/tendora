/** Persistent original compound coverage depends on current sources, not copied assertions. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import { retainPartialContribution } from '../../src/engine/partial.mjs';
import { developedConcepts } from '../../src/engine/concepts.mjs';
import { contributionSources } from '../../src/project/authoring/development.mjs';
import { originalHandQuestion, originalHandPenman } from '../support/original-hand-question.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/partial-contribution-'));
const fetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('Retaining and revisiting frozen partial meaning cannot acquire language');
};
try {
  const fixture = JSON.parse(
    await readFile(new URL('../support/qa-domain-fixtures.json', import.meta.url), 'utf8'),
  );
  const acquisition = JSON.parse(
    await readFile(new URL('../support/qa-development-acquisitions.json', import.meta.url), 'utf8'),
  );
  const text = 'The programmer recognizes intention in the resulting design.';
  const changedText = 'The programmer recognizes intention in a larger design.';
  const independent = 'What does the programmer recognize?';
  let project = await createProject(directory, 'Original compound contribution', 'Hand');
  const scope = project.data.placements[0].id;
  const concept = project.data.concepts[0].id;
  project = await saveProject(project, editConcept(project.data, concept, 'Hand', [text]));
  await retainAcquisitions(project, [
    ...[text, changedText].map((text) => ({
      text,
      penman: fixture.graphs.find((entry) => entry.text === text).penman,
      origin: { kind: 'test-replay', file: 'qa-domain-fixtures.json' },
    })),
    {
      text: originalHandQuestion,
      penman: originalHandPenman,
      origin: { kind: 'test-replay', file: 'original-hand-question.mjs' },
    },
    {
      text: independent,
      penman: acquisition.entries.find((entry) => entry.text === independent).acquisition.penman,
      origin: { kind: 'test-replay', file: 'qa-development-acquisitions.json' },
    },
  ]);
  const ask = async (question = originalHandQuestion) => {
    const input = await inputFromProject(project, { scopePlacementId: scope, question });
    const prepared = await prepareInquiry(input);
    const result = { inputs: prepared.records };
    return { input, result, answer: checkAnswer(project, input, result) };
  };
  const first = await ask();
  assert.equal(first.answer.status, 'open');
  assert.equal(first.answer.partial.parts.length, 1);
  const before = JSON.stringify(project.data);
  const retained = retainPartialContribution(project, first.input, first.result);
  assert.equal(
    JSON.stringify(project.data),
    before,
    'Retention returns the next authored revision',
  );
  assert.equal(retained.contribution.question.text, originalHandQuestion);
  assert.deepEqual(retained.contribution.question.graph, first.result.inputs.at(-1).graph);
  assert.deepEqual(
    retained.contribution.responses,
    [],
    'Support remains dependency-bound; no observation is copied',
  );
  assert.equal(retained.contribution.partial.parts[0].sources[0].text, text);
  const oldDependency = retained.contribution.partial.parts[0].sources[0];
  project = await saveProject(project, retained.data);
  const savedId = retained.contribution.id;
  assert.throws(
    () => retainPartialContribution(project, first.input, first.result),
    /corpus changed/u,
  );
  project = await openProject(directory);
  assert.equal(project.data.contributions[0].partial.parts.length, 1);
  assert(
    contributionSources(project.data)
      .filter((source) => source.development.contributionId === savedId)
      .every((source) => source.development.asserted === false),
  );
  const originalAnchors = [...developedConcepts(project.data).entries.values()];
  const interfaceAnchor = originalAnchors.find((entry) => entry.anchor.nodeId === 'z11');
  assert(
    interfaceAnchor,
    'The concrete interface remains an authorable anchor in the original compound',
  );
  assert.equal(interfaceAnchor.anchor.partId, 'question');
  assert.equal(interfaceAnchor.anchor.contributionId, savedId);
  const other = await ask(independent);
  assert(
    other.answer.openings.some(
      (opening) => opening.kind === 'aporia' && opening.contributionId === savedId,
    ),
    'An independently focused question revisits the same partial contribution',
  );
  assert.equal((await ask()).answer.partial.parts.length, 1);

  project = await saveProject(project, editConcept(project.data, concept, 'Hand', [changedText]));
  const revised = await ask();
  assert.equal(revised.answer.partial.parts.length, 1);
  assert(
    revised.answer.partial.parts.every((part) =>
      part.dependencies.every((dependency) => dependency.revision !== oldDependency.revision),
    ),
    'Reassessment uses the changed source revision, never the retained proof snapshot',
  );
  project = await saveProject(project, editConcept(project.data, concept, 'Hand', []));
  project = await openProject(directory);
  const removed = await ask();
  assert.equal(removed.answer.status, 'open');
  assert.equal(
    removed.answer.partial.parts.length,
    0,
    'Deleting support retracts its partial proof after reopen',
  );
  assert.equal(project.data.contributions[0].question.text, originalHandQuestion);
  assert.deepEqual(project.data.contributions[0].responses, []);
  assert.equal(
    project.data.contributions[0].partial.parts[0].sources[0].revision,
    oldDependency.revision,
    'The old snapshot remains inspectable history, not evidence',
  );
  assert.throws(
    () => retainPartialContribution(project, removed.input, removed.result),
    /no supported parts/u,
  );
  console.log(
    'ok original partial persistence, independent revisit, concrete anchors, current source revisions and support removal after reload',
  );
} finally {
  globalThis.fetch = fetch;
  await rm(directory, { recursive: true, force: true });
}
