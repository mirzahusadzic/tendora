/** Trim backends: js is the default and runs everywhere; auto chooses js below
 * the size where a native program pays; an unknown or unavailable backend is
 * refused with why; and where swift and metal run (macOS with the Swift
 * toolchain), their trims and the inference they give equal JavaScript's on
 * every demo check tried. Elsewhere this says why they were not tried. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openProject } from '../../src/project/authoring/project.mjs';
import { listEngineRuns, readEngineArtifact } from '../../src/project/storage/engine-runs.mjs';
import { answerRecording } from '../../src/engine/answer.mjs';
import { answerBase } from '../../src/recording/answers.mjs';
import { knowledgeSnapshot } from '../../src/project/authoring/knowledge.mjs';
import {
  MISSING,
  VAR,
  currentTrim,
  encodeTrim,
  storeCapture,
  trimFast,
} from '../../src/amr/trim.mjs';
import {
  chooseBackend,
  describeBackends,
  metalLimit,
  nativeFrom,
  nativeProgram,
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
// A native backend this machine lacks is skipped, and said so by name: the
// packed Metal variant is compared with js only where a Metal device runs.
const skipped = describeBackends()
  .filter(({ name, available }) => ['swift', 'metal'].includes(name) && !available)
  .map(({ name, detail }) => `${name} skipped (${detail})`);
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
// A capture that does not hold together is refused by every backend alike,
// with why: never padded, never read past (review of the Metal trim,
// 2026-10-25, #4).
const malformed = {
  'terms zero': { ...mixed, terms: 0 },
  'a short column': {
    ...mixed,
    columns: [Uint32Array.of(0), mixed.columns[1], mixed.columns[2]],
  },
  'a term past terms': { ...mixed, columns: [Uint32Array.of(0, 9), ...mixed.columns.slice(1)] },
  'a variable the rule lacks': { ...mixed, rules: [{ vars: 1, patterns: [[VAR | 3, 1, 2]] }] },
  'a constant past terms': { ...mixed, rules: [{ vars: 1, patterns: [[VAR, 7, 2]] }] },
  'a pattern of two words': { ...mixed, rules: [{ vars: 1, patterns: [[VAR, 1]] }] },
  'negative facts': { ...mixed, facts: -1 },
  'terms past the bound': { ...mixed, terms: 2 ** 28 + 1 },
  // A rule declaring far more variables than its patterns name, and a store
  // whose index alone would need gigabytes (GPU recheck, #2).
  'variables past its patterns': { ...mixed, rules: [{ ...rule(2, 1), vars: 1_000_000 }] },
  'more memory than the bound': { ...mixed, terms: 2 ** 28 },
};
for (const name of ['js', ...native.map((backend) => backend.name)])
  for (const [what, capture] of Object.entries(malformed))
    assert.throws(
      () => trimBackend(name)(capture),
      { code: 'CAPTURE_INVALID' },
      `${name}: ${what}`,
    );
// auto checks before it chooses; a column longer than its facts is read up to
// them by every backend alike (fourth review, #7).
assert.throws(() => trimBackend('auto')(null), { code: 'CAPTURE_INVALID' });
const longer = {
  ...mixed,
  // Past the page its column is padded to, so a native write would spill.
  columns: mixed.columns.map((column) => Uint32Array.from([...column, ...Array(5000).fill(3)])),
};
for (const { name } of native)
  assert.equal(list(trimBackend(name)(longer)), list(trimFast(longer)), `${name}: a longer column`);

// The native program itself refuses what does not hold together, with a
// reason and exit 2, and never stops on a signal; an empty store or no rules
// is the empty trim; a pool too small says so, exit 3, as the host retries on
// (review of the Metal trim, #1 to #3 and #6).
const scratchDir = await mkdtemp(resolve('tmp/trim-native-'));
let captures = 0;
const writeNative = async ({ columns, rules, facts, terms }, edit = {}) => {
  const dir = join(scratchDir, `c${captures++}`);
  await mkdir(dir);
  const page = 16384,
    columnBytes = facts ? Math.ceil((facts * 4) / page) * page : 0;
  const words = new Uint32Array((3 * columnBytes) / 4);
  columns.forEach((column, c) => words.set(column.subarray(0, facts), (c * columnBytes) / 4));
  const ruleWords = [rules.length];
  for (const rule of rules)
    ruleWords.push(rule.patterns.length, rule.vars, ...rule.patterns.flat());
  const files = {
    'meta.json': JSON.stringify({ facts, terms, columnBytes, page }),
    'columns.bin': Buffer.from(words.buffer),
    'rules.bin': Buffer.from(Uint32Array.from(ruleWords).buffer),
    ...edit,
  };
  for (const [file, content] of Object.entries(files))
    if (content !== null) await writeFile(join(dir, file), content);
  return dir;
};
const runNative = (kind, dir, flags = [], env = {}) => {
  const built = nativeProgram(kind);
  const out = join(dir, 'out.bin');
  const ran = spawnSync(
    built.binary,
    [
      kind === 'metal' ? 'metal' : 'cpu',
      dir,
      ...(flags.includes('--repeat') ? [] : ['--repeat', '1']),
      '--out',
      out,
      ...flags,
    ],
    { encoding: 'utf8', env: { ...process.env, TRIM_ARCHIVE: built.archive, ...env } },
  );
  return { ...ran, out };
};
const valid = { ...mixed, rules: [rule(2, 1)] };
const validWords = await writeNative(valid);
const validRules = await readFile(join(validWords, 'rules.bin'));
const corrupt = {
  'truncated columns': { 'columns.bin': Buffer.alloc(100) },
  'no columns': { 'columns.bin': null },
  'truncated rules header': { 'rules.bin': validRules.subarray(0, 6) },
  'a rule cut short': { 'rules.bin': validRules.subarray(0, validRules.length - 4) },
  'many rules declared': { 'rules.bin': Buffer.from(Uint32Array.of(1e9, 1, 2).buffer) },
  'malformed meta': { 'meta.json': '{' },
  'meta with a word for a count': {
    'meta.json': JSON.stringify({ facts: 'two', terms: 4, columnBytes: 16384 }),
  },
};
const term = (value) => Uint32Array.of(0, value);
for (const { name: kind } of native) {
  for (const [what, edit] of Object.entries(corrupt)) {
    const ran = runNative(kind, await writeNative(valid, edit));
    assert.deepEqual([ran.status, ran.signal], [2, null], `${kind}: ${what}: ${ran.stderr}`);
    assert.notEqual(ran.stderr.trim(), '', `${kind}: ${what} says why`);
  }
  for (const [what, capture] of Object.entries({
    'a term past terms': { ...valid, columns: [term(9), ...valid.columns.slice(1)] },
    'a variable the rule lacks': { ...valid, rules: [{ vars: 1, patterns: [[VAR | 3, 1, 2]] }] },
    'variables past its patterns': { ...valid, rules: [{ ...rule(2, 1), vars: 1_000_000 }] },
  })) {
    const ran = runNative(kind, await writeNative(capture));
    assert.deepEqual([ran.status, ran.signal], [2, null], `${kind}: ${what}: ${ran.stderr}`);
  }
  for (const [what, capture] of Object.entries({
    'no facts': {
      columns: [new Uint32Array(0), new Uint32Array(0), new Uint32Array(0)],
      rules: [rule(2, 1)],
      facts: 0,
      terms: 4,
    },
    'no rules': { ...valid, rules: [] },
  })) {
    const ran = runNative(kind, await writeNative(capture));
    assert.equal(ran.status, 0, `${kind}: ${what}: ${ran.stderr}`);
    assert.deepEqual(
      [...new Uint32Array(new Uint8Array(await readFile(ran.out)).buffer)],
      [...encodeTrim(trimFast(capture))],
      `${kind}: ${what} is the empty trim`,
    );
  }
  const flagged = kind === 'metal' ? ['--variant', 'bogus'] : ['--threads', '0'];
  for (const flags of [flagged, ['--repeat', 'many']]) {
    const ran = runNative(kind, validWords, flags);
    assert.deepEqual([ran.status, ran.signal], [2, null], `${kind} ${flags.join(' ')}`);
  }
  if (kind === 'metal') {
    const groups = runNative(kind, validWords, [], { TRIM_GROUPS: '0' });
    assert.deepEqual([groups.status, groups.signal], [2, null], 'TRIM_GROUPS=0');
    // With no rules too: a wrong setting is refused with or without work
    // (GPU recheck, #6).
    const idle = runNative(kind, await writeNative({ ...valid, rules: [] }), [], {
      TRIM_GROUPS: '0',
    });
    assert.deepEqual([idle.status, idle.signal], [2, null], 'TRIM_GROUPS=0 with no rules');
    const pool = runNative(kind, validWords, [], { TRIM_POOL: '1' });
    assert.equal(pool.status, 3, pool.stderr);
    assert.match(pool.stderr, /the pool of 1 words ran out; set TRIM_POOL/u);
  }
}

// auto: a native trim that fails as it runs hands the trim on (Metal to
// Swift, Swift to JavaScript), with the same lists; an explicit backend fails
// loud (review of the Metal trim, #5).
if (native.some(({ name }) => name === 'metal')) {
  const facts = nativeFrom;
  const big = {
    columns: [0, 1, 2].map((c) =>
      Uint32Array.from({ length: facts }, (_, f) => (f * (c + 7)) % 1000),
    ),
    rules: [{ vars: 2, patterns: [[VAR, 5, (VAR | 1) >>> 0]] }],
    facts,
    terms: 1000,
  };
  process.env.TRIM_GROUPS = '0';
  try {
    assert.equal(list(trimBackend('auto')(big)), list(trimFast(big)), 'auto falls back');
    assert.throws(() => trimBackend('metal')(big), { code: 'BACKEND_UNAVAILABLE' });
  } finally {
    delete process.env.TRIM_GROUPS;
  }
}

console.log(
  `ok trim backends: js default, auto below ${nativeFrom.toLocaleString('en')} facts, refusals with why${native.length ? `; ${native.map(({ name }) => name).join(' and ')} equal js on ${runs.length} checks` : ''}${skipped.length ? `; ${skipped.join('; ')}` : ''}`,
);
