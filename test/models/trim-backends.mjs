/** Trim backends: js is the default and runs everywhere; auto chooses js below
 * the size where a native program pays; an unknown or unavailable backend is
 * refused with why; and where swift and metal run (macOS with the Swift
 * toolchain), their trims and the inference they give equal JavaScript's on
 * every demo check tried. Elsewhere this says why they were not tried. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { openProject } from '../../src/project/authoring/project.mjs';
import { listEngineRuns, readEngineArtifact } from '../../src/project/storage/engine-runs.mjs';
import { answerRecording } from '../../src/engine/answer.mjs';
import { answerBase } from '../../src/recording/answers.mjs';
import { knowledgeSnapshot } from '../../src/project/authoring/knowledge.mjs';
import { MISSING, VAR, currentTrim, storeCapture, trimFast } from '../../src/amr/trim.mjs';
import {
  chooseBackend,
  describeBackends,
  metalLimit,
  nativeFrom,
  trimBackend,
  useTrimBackend,
  withoutMissing,
} from '../../src/models/trim-backends.mjs';

const list = (lists) => JSON.stringify(lists.map((items) => [...items]));
assert.equal(trimBackend('js'), trimFast);
assert.throws(() => trimBackend('gpu'), { code: 'BACKEND_UNKNOWN', message: /Choose js, swift/u });
assert.equal(useTrimBackend('js'), 'js');
assert.equal(currentTrim(), trimFast);
// auto: js below the size a native program pays at, then the fastest here.
const here =
  (...kinds) =>
  (kind) =>
    kinds.includes(kind);
assert.equal(chooseBackend(nativeFrom - 1, here('metal', 'swift')), 'js');
assert.equal(chooseBackend(nativeFrom, here('metal', 'swift')), 'metal');
assert.equal(chooseBackend(nativeFrom, here('swift')), 'swift');
assert.equal(chooseBackend(nativeFrom, here()), 'js');
// Metal's kernel holds at most 8 variables and 16 patterns a rule; auto passes
// a larger rule to Swift or JavaScript, which take any (review 2026-10-25,
// v0.2.0 #3). A rule with a constant the store lacks never reaches it.
const rule = (vars, patterns, constant = 1) => ({
  vars,
  patterns: Array.from({ length: patterns }, (_, k) => [
    (VAR | (k % vars)) >>> 0,
    constant,
    (VAR | ((k + 1) % vars)) >>> 0,
  ]),
});
assert.equal(metalLimit([rule(8, 16)]), null);
assert.match(metalLimit([rule(9, 2)]), /9 variables .* at most 8 variables and 16 patterns/u);
assert.match(metalLimit([rule(2, 17)]), /17 patterns/u);
assert.equal(metalLimit([rule(9, 17, MISSING)]), null);
assert.equal(chooseBackend(nativeFrom, here('metal', 'swift'), [rule(9, 2)]), 'swift');
assert.equal(chooseBackend(nativeFrom, here('metal'), [rule(2, 17)]), 'js');
assert.equal(chooseBackend(nativeFrom, here('metal', 'swift'), [rule(8, 16)]), 'metal');
// Rules with a missing constant keep nothing, without the native program
// seeing them (review 2026-10-25, v0.2.0 #1): the others go, in order, and
// come back in place.
const mixed = {
  columns: [Uint32Array.of(0, 2), Uint32Array.of(1, 1), Uint32Array.of(2, 3)],
  rules: [rule(2, 1), rule(2, 2, MISSING), rule(2, 1)],
  facts: 2,
  terms: 4,
};
const { sent, restore } = withoutMissing(mixed);
assert.deepEqual(sent.rules, [mixed.rules[0], mixed.rules[2]]);
assert.deepEqual(list(restore(trimFast(sent))), list(trimFast(mixed)));
assert.deepEqual(
  list(withoutMissing({ ...mixed, rules: [mixed.rules[1]] }).restore([])),
  '[[],[]]',
);

// Without a Swift toolchain (or off macOS) native backends are refused with
// why, and js and auto still run.
const backendsModule = new URL('../../src/models/trim-backends.mjs', import.meta.url).href;
const missing = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { describeBackends, trimBackend } = await import(${JSON.stringify(backendsModule)});
       let refused;
       try { trimBackend('swift'); } catch (error) { refused = [error.code, error.message]; }
       console.log(JSON.stringify({ refused, backends: describeBackends() }));`,
    ],
    { encoding: 'utf8', env: { ...process.env, TENDORA_SWIFTC: '/nonexistent/swiftc' } },
  ),
);
assert.equal(missing.refused[0], 'BACKEND_UNAVAILABLE');
assert.match(missing.refused[1], /not available here: it needs (macOS|the Swift toolchain)/u);
assert.deepEqual(
  missing.backends.map(({ name, available }) => [name, available]),
  [
    ['js', true],
    ['swift', false],
    ['metal', false],
    ['auto', true],
  ],
);

const native = describeBackends().filter(
  ({ name, available }) => ['swift', 'metal'].includes(name) && available,
);
if (!native.length)
  console.log(
    `native backends not tried: ${describeBackends()
      .filter(({ available }) => !available)
      .map(({ name, detail }) => `${name}: ${detail}`)
      .join('; ')}`,
  );
const project = await openProject('demo/payments-on-call');
const knowledge = knowledgeSnapshot(project.data);
const shape = (inference) =>
  JSON.stringify(
    inference.facts.map((fact) => [
      fact.id,
      fact.triple,
      fact.premises,
      fact.alternatives?.map((p) => p.premises),
    ]),
  );
const runs = (await listEngineRuns(project)).slice(0, 4);
for (const { name } of native) {
  const trim = trimBackend(name);
  for (const run of runs) {
    const [input, result] = await Promise.all([
      readEngineArtifact(project, run.inputRef),
      readEngineArtifact(project, run.resultRef),
    ]);
    const recording = answerRecording(project, input, result);
    const js = answerBase(recording, knowledge, { trim: trimFast });
    const other = answerBase(recording, knowledge, { trim });
    assert.equal(shape(other.inference), shape(js.inference), `${name}: ${run.questions[0].text}`);
    const capture = storeCapture(
      js.inference.store,
      js.material.rules.map((rule) => rule.when),
    );
    assert.equal(list(trim(capture)), list(trimFast(capture)), `${name} lists`);
  }
  // A rule with a missing constant keeps nothing here too; a rule larger than
  // Metal holds runs on Swift and is refused by an explicit metal, with why.
  assert.equal(list(trim(mixed)), list(trimFast(mixed)), `${name}: missing constant`);
  const large = { ...mixed, rules: [rule(9, 17)] };
  if (name === 'metal')
    assert.throws(() => trim(large), { code: 'BACKEND_UNAVAILABLE', message: /at most 8/u });
  else assert.equal(list(trim(large)), list(trimFast(large)), `${name}: a large rule`);
}
console.log(
  `ok trim backends: js default, auto below ${nativeFrom.toLocaleString('en')} facts, refusals with why${native.length ? `; ${native.map(({ name }) => name).join(' and ')} equal js on ${runs.length} checks` : ''}`,
);
