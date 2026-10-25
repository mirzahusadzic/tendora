/** The trim in inference: on every saved check of the bundled demo, rules
 * matched over only the facts the trim keeps give the same inference as over
 * every fact (facts, proofs, alternatives, their order, completeness); the
 * fast trim equals the readable oracle on each check's store; a rule whose
 * constant the store lacks keeps nothing. Read-only. */
import assert from 'node:assert/strict';
import { openProject } from '../../src/project/authoring/project.mjs';
import { listEngineRuns, readEngineArtifact } from '../../src/project/storage/engine-runs.mjs';
import { answerRecording } from '../../src/engine/answer.mjs';
import { answerBase } from '../../src/recording/answers.mjs';
import { knowledgeSnapshot } from '../../src/project/authoring/knowledge.mjs';
import {
  MISSING,
  currentTrim,
  decodeTrim,
  encodeTrim,
  storeCapture,
  trimFast,
  trimReference,
  usablePositions,
} from '../../src/amr/trim.mjs';

assert.equal(currentTrim(), trimFast, 'JavaScript is the default backend');
const project = await openProject('demo/payments-on-call');
const knowledge = knowledgeSnapshot(project.data);
const shape = (inference) =>
  JSON.stringify({
    complete: inference.complete,
    rounds: inference.rounds,
    facts: inference.facts.map((fact) => [
      fact.id,
      fact.triple,
      fact.ruleId,
      fact.premises,
      fact.alternatives?.map((proof) => [proof.ruleId, proof.premises]),
    ]),
  });
const list = (lists) => lists.map((items) => [...items]);
let checks = 0,
  trimmedRounds = 0,
  store;
for (const run of await listEngineRuns(project)) {
  const [input, result] = await Promise.all([
    readEngineArtifact(project, run.inputRef),
    readEngineArtifact(project, run.resultRef),
  ]);
  const recording = answerRecording(project, input, result);
  const all = answerBase(recording, knowledge, { trim: null });
  const trimmed = answerBase(recording, knowledge);
  assert.equal(shape(trimmed.inference), shape(all.inference), run.questions[0].text);
  trimmedRounds += trimmed.inference.trimmed.length;
  const capture = storeCapture(
    trimmed.inference.store,
    trimmed.material.rules.map((rule) => rule.when),
  );
  assert.deepEqual(list(trimFast(capture)), list(trimReference(capture)), 'fast = oracle');
  store = trimmed.inference.store;
  checks++;
}
assert.equal(checks, 37);
assert(trimmedRounds >= checks, 'every check trims its rounds');

// A constant the store does not hold leaves its rule nothing to keep.
const absent = storeCapture(store, [[['?x', 'no-such-role', '?y']]]);
assert.deepEqual(absent.rules[0].patterns[0][1], MISSING);
assert.deepEqual(list(trimFast(absent)), [[]]);
assert.equal(
  usablePositions(store, [[['?x', 'no-such-role', '?y']]]).reduce((a, b) => a + b, 0),
  0,
);
// Every backend's output encodes and decodes the same way.
const arg0 = storeCapture(store, [[['?x', ':ARG0', '?y']]]);
const lists = trimFast(arg0);
assert.deepEqual(list(decodeTrim(Buffer.from(encodeTrim(lists).buffer), arg0)), list(lists));
// Output that does not fit its capture is refused, never read as an empty
// trim (review 2026-10-25, v0.2.0 #2): a truncated file, offsets out of
// order, a total that disagrees, a list too few or too many, a position past
// the facts or out of order.
const words = (...values) => Buffer.from(Uint32Array.from(values).buffer);
const malformed = {
  truncated: Uint8Array.of(1, 2, 3),
  'too short': words(1),
  'offsets out of order': words(2, 0, 2, 1, 0, 1, 2),
  'total disagrees': words(1, 0, 3, 0, 1),
  'missing words': words(1, 0, 2, 0),
};
for (const [why, bytes] of Object.entries(malformed))
  assert.throws(() => decodeTrim(bytes), { code: 'TRIM_OUTPUT_INVALID' }, why);
const one = { ...arg0, facts: 4 };
for (const [why, bytes] of Object.entries({
  'a list too many': words(2, 0, 0, 0),
  'past the facts': words(1, 0, 1, 4),
  'out of order': words(1, 0, 2, 2, 1),
  repeated: words(1, 0, 2, 1, 1),
}))
  assert.throws(() => decodeTrim(bytes, one), { code: 'TRIM_OUTPUT_INVALID' }, why);
assert.deepEqual(list(decodeTrim(words(1, 0, 2, 1, 3), one)), [[1, 3]]);
// Whatever backend trims, its lists must fit the capture.
for (const bad of [() => [], (capture) => [Uint32Array.of(capture.facts)]])
  assert.throws(() => usablePositions(store, [[['?x', ':ARG0', '?y']]], { trim: bad }), {
    code: 'TRIM_OUTPUT_INVALID',
  });
console.log(`ok trim in inference: ${checks} checks identical with and without it; fast = oracle`);
