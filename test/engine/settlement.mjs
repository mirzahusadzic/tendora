/** The engine reads no question through a source on its own: where a question
 * and a source share words but were read differently, the connection is a
 * proposal a person confirms, not an answer (review 2026-10-25, #2 and #3).
 * A proposal that would answer with a participant the question itself names,
 * by its concept or its name, swaps roles and is not offered. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createProject, editConcept, saveProject } from '../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import { inputFromProject } from '../../src/engine/input.mjs';
import { runEngine } from '../../src/engine/run.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/settlement-'));
const fetch = globalThis.fetch;
globalThis.fetch = () => assert.fail('Settlement is checked from retained readings only');
try {
  let n = 0;
  const check = async ([text, penman], question, questionPenman) => {
    let project = await createProject(resolve(directory, String(n++)), 'Settlement', 'Root');
    project = await saveProject(
      project,
      editConcept(project.data, project.data.concepts[0].id, 'Root', [text]),
    );
    await retainAcquisitions(
      project,
      [
        [text, penman],
        [question, questionPenman],
      ].map(([t, p]) => ({ text: t, penman: p, origin: { kind: 'settlement-test' } })),
    );
    const input = await inputFromProject(project, {
      scopePlacementId: project.data.placements[0].id,
      question,
    });
    const run = await runEngine(project, { input, acquireMissing: false, trace: false });
    return {
      status: run.status,
      answers: (run.answer?.answers ?? []).map((a) => a.text),
      proposals: (run.answer?.clarifications ?? []).map((c) => c.answerLabel),
    };
  };

  // Two senses of one word are two meanings: "broke into" (break-02) is not
  // "broke" (break-01).
  const senses = await check(
    ['The storm broke the shed.', '(b / break-01 :ARG0 (s2 / storm) :ARG1 (s / shed))'],
    'Who broke into the shed?',
    '(b / break-02 :ARG0 (u / amr-unknown) :ARG1 (s / shed))',
  );
  assert.equal(senses.status, 'open', 'Two senses do not answer each other');
  assert.deepEqual(senses.answers, []);

  // "A proposal of Ana" read through "Ana may reject a proposal of the
  // intelligence" would answer Ana, the rejector, not the proposal's owner.
  const named = await check(
    [
      'Ana may reject a proposal of the intelligence.',
      '(p / possible-01 :ARG1 (r / reject-01 :ARG0 (p2 / person :name (n / name :op1 "Ana")) :ARG1 (t / thing :ARG1-of (p3 / propose-01 :ARG0 (i / intelligence)))))',
    ],
    'Who may reject a proposal of Ana?',
    '(p / possible-01 :ARG1 (r / reject-01 :ARG0 (u / amr-unknown) :ARG1 (t / thing :ARG1-of (p3 / propose-01 :ARG0 (p2 / person :name (n / name :op1 "Ana"))))))',
  );
  assert.equal(named.status, 'open', 'A named participant keeps its role');
  assert(!named.proposals.includes('Ana'), 'and no proposal swaps it');

  // The same words read as a frame in the question and a noun in the source:
  // one confirmation away, not answered.
  const form = await check(
    ['The operator leads the rollback.', '(l / lead-02 :ARG0 (o / operator) :ARG1 (r / rollback))'],
    'Who leads the rollback?',
    '(l / lead-02 :ARG0 (u / amr-unknown) :ARG1 (r / roll-back-01))',
  );
  assert.equal(form.status, 'open', 'A word read two ways waits for a person');
  assert.deepEqual(form.proposals, ['operator'], 'and the connection is proposed');

  // Read the same way, the question is answered as before.
  const same = await check(
    ['The operator leads the rollback.', '(l / lead-02 :ARG0 (o / operator) :ARG1 (r / rollback))'],
    'Who leads the rollback?',
    '(l / lead-02 :ARG0 (u / amr-unknown) :ARG1 (r / rollback))',
  );
  assert.deepEqual([same.status, same.answers], ['supported', ['operator']]);
  console.log(
    'ok settlement: shared words propose, they do not answer; no proposal swaps a named role',
  );
} finally {
  globalThis.fetch = fetch;
  await rm(directory, { recursive: true, force: true });
}
