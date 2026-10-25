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
import { currentTrim, storeCapture, trimFast } from '../../src/amr/trim.mjs';
import {
  chooseBackend,
  describeBackends,
  nativeFrom,
  trimBackend,
  useTrimBackend,
} from '../../src/models/trim-backends.mjs';

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
const project = await openProject('.proj/payments-on-call');
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
const list = (lists) => JSON.stringify(lists.map((items) => [...items]));
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
}
console.log(
  `ok trim backends: js default, auto below ${nativeFrom.toLocaleString('en')} facts, refusals with why${native.length ? `; ${native.map(({ name }) => name).join(' and ')} equal js on ${runs.length} checks` : ''}`,
);
