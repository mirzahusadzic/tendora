/** Revising authored language replaces support without losing question or acquisition history. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  addConcept,
  createProject,
  openProject,
  saveProject,
} from '../../src/project/authoring/project.mjs';
import {
  developContribution,
  reviseContribution,
  readLanguage,
} from '../../src/engine/develop.mjs';
import {
  contributionRules,
  contributionRevision,
} from '../../src/project/authoring/development.mjs';
import { developedConcepts } from '../../src/engine/concepts.mjs';
import { inputFromProject } from '../../src/engine/input.mjs';
import { runEngine } from '../../src/engine/run.mjs';
import {
  deleteEngineRuns,
  deleteQuestion,
} from '../../src/project/inquiries/delete-engine-runs.mjs';
import { acquireEngineRunLease, listEngineRuns } from '../../src/project/storage/engine-runs.mjs';
import { frozenParser } from '../support/development-acquisition.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/qa-contribution-revisions-'));
const before = globalThis.fetch;
globalThis.fetch = frozenParser();
let project;
async function develop(question, answer = '', options = {}) {
  const result = await developContribution(project, {
    scopePlacementId: project.data.placements[0].id,
    question,
    answer,
    ...options,
  });
  project = await saveProject(project, result.data);
  return result.contribution;
}
async function revise(c, question, answers) {
  const active = c.responses.filter((r) => !r.withdrawn);
  const result = await reviseContribution(project, {
    contributionId: c.id,
    question,
    responses: answers.map((text, i) => ({ id: active[i]?.id ?? null, text })),
  });
  project = await saveProject(project, result.data);
  return result.contribution;
}
async function ask(question) {
  return runEngine(project, {
    input: await inputFromProject(project, {
      scopePlacementId: project.data.placements[0].id,
      question,
    }),
    acquireMissing: true,
    trace: false,
  });
}
try {
  project = await createProject(join(directory, 'workshop'), 'Workshop');
  let repair = await develop('Who repairs bicycles?', 'Sam.');
  repair = await develop('Who repairs bikes?', '', { contributionId: repair.id, wording: true });
  const original = repair.question;
  const inferredChild = await develop('Which person repairs bicycles?');
  assert(inferredChild.anchor.nodeId, 'An inferred context records its concrete target');
  assert(inferredChild.anchor.revision, 'An inferred context records its source revision');
  const child = await develop('Where does Sam repair bicycles?', '', {
    anchor: {
      contributionId: repair.id,
      partId: 'question',
      nodeId: original.graph.top,
      revision: contributionRevision(original.graph),
      label: 'repairs',
      question: original.text,
    },
  });
  assert.equal((await ask('Does Sam repair bikes?')).status, 'supported');
  repair = await revise(repair, 'What does Sam repair?', ['Sam repairs bicycles.']);
  assert.equal(repair.id, project.data.contributions[0].id);
  assert.deepEqual(repair.questionHistory[0].graph, original.graph);
  assert.equal(repair.responses[0].withdrawn, true);
  const current = repair.responses.find((r) => !r.withdrawn);
  assert(current.composition.derivation, 'Revision composes through the HRG chart');
  assert.equal(current.replaces, repair.responses[0].id);
  assert.equal(
    contributionRules(project.data).length,
    0,
    'Old declarations cannot support revised meaning',
  );
  assert.equal((await ask('Does Sam repair bikes?')).status, 'open');
  const supported = await ask('What does Sam repair?');
  assert.equal(supported.status, 'supported');
  assert(
    supported.answer.answers.every((a) =>
      a.sourceIds.includes(`contribution:${repair.id}:${current.id}`),
    ),
  );
  assert(
    developedConcepts(project.data).roots.some(
      (r) => r.contributionId === child.id && r.contextNote,
    ),
  );
  assert(
    developedConcepts(project.data).roots.some(
      (r) => r.contributionId === inferredChild.id && r.contextNote,
    ),
    'An inferred context does not silently attach to a revised source',
  );

  // A different commitment must remove the old positive evidence, not only relabel it.
  repair = await revise(repair, 'Does Sam repair bicycles?', ['No']);
  assert(
    repair.responses.find((r) => !r.withdrawn).graph.edges.some((e) => e.role === ':polarity'),
  );
  assert.equal((await ask('Who repairs bicycles?')).status, 'open');
  const unchanged = structuredClone(project.data);
  await assert.rejects(revise(repair, 'Who repairs bicycles?', ['No']), /needs an answer/u);
  assert.deepEqual(project.data, unchanged, 'Failed recomposition keeps all previous meaning');
  repair = await revise(repair, repair.question.text, ['']);
  assert(repair.responses.every((r) => r.withdrawn));
  assert.equal(
    developedConcepts(project.data).byContribution.get(repair.id)[0].materialState,
    'Question',
  );

  // Previous question readings remain corpus-owned when run history is cleared.
  await deleteEngineRuns(project, { all: true });
  project = await openProject(join(directory, 'workshop'));
  assert.equal(project.data.contributions[0].questionHistory.length, 2);
  assert((await readLanguage(project, original.text, { offline: true })).acquisition.reused);

  // Question deletion obeys run/stale-write guards and scoped shared ownership.
  project = await createProject(join(directory, 'deletion'), 'Question deletion');
  const sharedQuestion = await develop('Who repairs bicycles?');
  const duplicate = await develop(sharedQuestion.question.text);
  const rootScope = project.data.placements[0].id;
  project = await saveProject(project, addConcept(project.data, rootScope, 'Other workshop').data);
  const otherScope = project.data.placements.at(-1).id;
  const scopedQuestion = await develop(sharedQuestion.question.text, '', {
    scopePlacementId: otherScope,
  });
  await ask(sharedQuestion.question.text);
  await runEngine(project, {
    input: await inputFromProject(project, {
      scopePlacementId: otherScope,
      question: sharedQuestion.question.text,
    }),
    acquireMissing: true,
    trace: false,
  });
  const target = {
    contributionId: sharedQuestion.id,
    scopePlacementId: rootScope,
    text: sharedQuestion.question.text,
  };
  const beforeDeletion = structuredClone(project.data);
  const runIds = (await listEngineRuns(project)).map((run) => run.id);
  const release = await acquireEngineRunLease(project, randomUUID());
  try {
    await assert.rejects(deleteQuestion(project, target), /running engine/u);
  } finally {
    await release();
  }
  assert.deepEqual((await openProject(join(directory, 'deletion'))).data, beforeDeletion);
  const stale = project;
  project = await saveProject(project, { ...project.data, name: 'Revised workshop' });
  await assert.rejects(deleteQuestion(stale, target), /Project changed/u);
  assert.deepEqual(
    (await listEngineRuns(project)).map((run) => run.id),
    runIds,
  );
  let deleted = await deleteQuestion(project, target);
  project = deleted.project;
  assert.equal(deleted.deleted.length, 0, 'Another authored question retains shared assessments');
  assert(!project.data.contributions.some((c) => c.id === sharedQuestion.id));
  assert(project.data.contributions.some((c) => c.id === duplicate.id));
  deleted = await deleteQuestion(project, { ...target, contributionId: duplicate.id });
  project = deleted.project;
  assert.equal(deleted.deleted.length, 1, 'Deleting the last owner clears its assessment');
  const remainingRuns = await listEngineRuns(project);
  assert.equal(remainingRuns.length, 1);
  assert.equal(remainingRuns[0].scopePlacementId, otherScope);
  assert(project.data.contributions.some((c) => c.id === scopedQuestion.id));

  project = await createProject(join(directory, 'hand'), 'Recognition');
  let recognition = await develop('Does the programmer recognize intention in the interface?');
  recognition = await revise(
    recognition,
    'What does the programmer recognize in the resulting design?',
    ['The programmer recognizes intention in the resulting design.'],
  );
  assert.equal((await ask(recognition.question.text)).status, 'supported');
  assert.equal(
    (await ask('Does the programmer recognize intention in the interface?')).status,
    'open',
  );
  project = await openProject(join(directory, 'hand'));
  assert.equal(project.data.contributions[0].id, recognition.id);
  assert.equal(
    project.data.contributions[0].questionHistory[0].text,
    'Does the programmer recognize intention in the interface?',
  );
  const source = recognition.responses.find((r) => !r.withdrawn);
  recognition = await develop(
    'Does the programmer recognize intention in the resulting design?',
    '',
    {
      contributionId: recognition.id,
      perspective: true,
      basisResponseId: source.id,
    },
  );
  const design = [...developedConcepts(project.data).entries.values()].find(
    (n) => n.contributionId === recognition.id && n.name === 'design',
  );
  const located = await develop(
    'How does the design of the interface participate in recognizing intention?',
    '',
    { anchor: design.anchor },
  );
  recognition = await revise(
    recognition,
    'Does the programmer recognize intention in the resulting design?',
    ['The programmer recognizes intention in the resulting design.'],
  );
  assert.equal(
    recognition.responses.find((r) => !r.withdrawn).id,
    source.id,
    'The unchanged supporting assertion retains its occurrence',
  );
  assert(
    !recognition.wordings[0].withdrawn,
    'A perspective on the unchanged assertion remains applicable',
  );
  assert(
    [...developedConcepts(project.data).entries.values()].some(
      (n) => n.contributionId === located.id && n.contextLink && n.parentId === design.id,
    ),
  );

  // The editor supplies all active answers; omitting one must not silently withdraw it.
  recognition = await develop('', 'The programmer recognizes intention in the resulting design.', {
    contributionId: recognition.id,
  });
  await assert.rejects(revise(recognition, recognition.question.text, ['']), /Reopen its editor/u);
  recognition = await revise(recognition, recognition.question.text, [
    '',
    'The programmer recognizes intention in the resulting design.',
  ]);
  assert.equal(recognition.responses.filter((r) => !r.withdrawn).length, 1);
  assert.equal((await ask(recognition.question.text)).status, 'supported');
  console.log(
    'ok contribution revision: two domains, HRG recomposition, support/declaration retraction, anchored question preservation, atomic failure, multiple answers, history, retained acquisitions and guarded scoped question deletion',
  );
} finally {
  globalThis.fetch = before;
  await rm(directory, { recursive: true, force: true });
}
