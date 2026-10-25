/** Real engine processes: useful arguments, pure JSON, offline proof and cancellation. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { editConcept, openProject, saveProject } from '../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import {
  listEngineRuns,
  readEngineRun,
  saveEngineRun,
} from '../../src/project/storage/engine-runs.mjs';
import { captureProjectInquiry } from '../../src/project/inquiries/inquiry.mjs';
import { compactEngineStorage } from '../../src/project/inquiries/engine-storage.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/cli-engine-'));
const location = join(directory, 'project with spaces');
const noNetwork =
  'data:text/javascript,' +
  encodeURIComponent('globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };');
const observations = [];
function command(args, { interrupt = false, closeOutput = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--import', noNetwork, 'src/cli/engine.mjs', ...args], {
      cwd: resolve('.'),
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      sent = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI command did not complete: ' + args.join(' ')));
    }, 60_000);
    child.stdout.on('data', (data) => (stdout += data));
    if (closeOutput) child.stdout.destroy();
    child.stderr.on('data', (data) => {
      stderr += data;
      if (interrupt && !sent && stderr.includes('Check scoped source revisions')) {
        sent = true;
        child.kill('SIGINT');
      }
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      const result = { args, code, signal, stdout, stderr, interrupted: sent };
      observations.push(result);
      done(result);
    });
  });
}
function successful(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert(!result.stderr.includes('NETWORK_FORBIDDEN'));
}
function machine(result, code = 0) {
  assert.equal(result.code, code, result.stderr);
  assert.equal(result.signal, null);
  assert(!result.stdout.includes('\x1b'), 'Machine output has no terminal escapes');
  assert(!result.stderr.includes('NETWORK_FORBIDDEN'), 'The offline command never acquired');
  return JSON.parse(result.stdout);
}

const rootHelp = await command([]);
successful(rootHelp);
assert.match(rootHelp.stdout, /Usage: engine <command>/u);
assert.equal(rootHelp.stderr, '');
assert.match(rootHelp.stdout, /130 interrupted/u);
const closedPipe = await command(['--help'], { closeOutput: true });
successful(closedPipe);
assert.equal(closedPipe.stderr, '', 'A closed pipeline does not expose a Node stack trace');
for (const action of [
  'init',
  'ask',
  'run',
  'runs',
  'show',
  'delete',
  'knowledge',
  'storage',
  'compact',
]) {
  const result = await command([action, '--help']);
  successful(result);
  assert.match(result.stdout, new RegExp('Usage: engine ' + action + ' --project', 'u'));
  assert.equal(result.stderr, '');
  if (!['ask', 'run'].includes(action)) assert(!result.stdout.includes('--scope'));
}
assert.match((await command(['ask', '-h'])).stdout, /missing AMRs may be acquired/u);
assert.match((await command(['delete', '--help'])).stdout, /runs immediately/u);

const absent = join(directory, 'must not be created');
const invalid = [
  { args: ['unknown'], match: /Unknown engine command/u },
  { args: ['init', 'extra', '--project', absent], match: /Unexpected argument: extra/u },
  { args: ['init', '--project', absent, '--offline'], match: /--offline is not available/u },
  {
    args: ['init', '--project', absent, '--question', 'Unexpected'],
    match: /--question is not available/u,
  },
  {
    args: ['init', '--project', absent, '--name', 'One', '--name', 'Two'],
    match: /Repeated option: --name/u,
  },
  { args: ['ask', '--project', absent], match: /--question is required/u },
  { args: ['ask', '--project', absent, '--question', '   '], match: /non-empty/u },
  { args: ['ask', '--question', 'Who?'], match: /--project is required/u },
  {
    args: ['ask', '--project', absent, '--question', 'Who?', '--case', 'A', '--case-text', 'B'],
    match: /Choose --case or --case-text/u,
  },
  { args: ['show', '--project', absent], match: /--run is required/u },
  { args: ['knowledge', '--project', absent], match: /--file is required/u },
  { args: ['delete', '--project', absent], match: /Choose --run <id> or --all/u },
  {
    args: ['delete', '--project', absent, '--all', '--run', 'id'],
    match: /Choose --run <id> or --all/u,
  },
  { args: ['storage', '--project', absent, '--trace'], match: /--trace is not available/u },
  { args: ['runs', '--project', absent, '--scope', 'Root'], match: /--scope is not available/u },
  { args: ['--project', absent], match: /Choose an engine command/u },
  { args: ['ask', '--not-real'], match: /Unknown option/u },
  { args: ['ask', '--question'], match: /argument missing/u },
];
for (const { args, match } of invalid) {
  const result = await command(args);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '', 'Argument errors do not pollute stdout');
  assert.match(result.stderr, match);
  assert.match(result.stderr, /--help/u);
  assert(!result.stderr.includes('\n    at '), 'Ordinary usage errors do not dump a stack');
}
await assert.rejects(access(absent), { code: 'ENOENT' });

const created = machine(
  await command([
    'init',
    '--project',
    location,
    '--name',
    'Workshop',
    '--root',
    'Workshop',
    '--json',
  ]),
);
assert.equal(created.project, location);
let project = await openProject(location);
assert.equal(created.id, project.data.id);
assert.equal(project.data.concepts[0].name, 'Workshop');
const original = await readFile(project.path, 'utf8');
const repeated = await command(['init', '--project', location]);
assert.equal(repeated.code, 1);
assert.equal(repeated.stdout, '');
assert.equal(await readFile(project.path, 'utf8'), original, 'Existing project was not replaced');
assert.equal((await command(['runs', '--project', location])).stdout.trim(), 'No engine runs');
assert.deepEqual(machine(await command(['runs', '--project', location, '--json'])), []);

const question = 'Who repairs bicycles?';
const missing = machine(
  await command(['ask', '--project', location, '--question', question, '--offline', '--json']),
  1,
);
assert.equal(missing.status, 'needs-amr');
assert.equal(missing.calls.length, 0);
assert.equal(missing.via, 'cli', 'A run records the interface it came through');
assert.equal(missing.actor, 'unrecorded', 'A CLI run names no actor unless given one');
const named = machine(
  await command([
    'ask',
    '--project',
    location,
    '--question',
    question,
    '--offline',
    '--json',
    '--actor',
    'Script A',
  ]),
  1,
);
assert.equal(named.actor, 'Script A', 'A declared actor is recorded as given');
project = await saveProject(
  project,
  editConcept(project.data, project.data.concepts[0].id, 'Workshop', ['Sam repairs bicycles.']),
);
await retainAcquisitions(
  project,
  [
    {
      text: 'Sam repairs bicycles.',
      penman: '(r / repair-01 :ARG0 (p / person :name (n / name :op1 "Sam")) :ARG1 (b / bicycle))',
    },
    { text: question, penman: '(r / repair-01 :ARG0 (u / amr-unknown) :ARG1 (b / bicycle))' },
    {
      text: 'Who approves the rehearsal?',
      penman: '(a / approve-01 :ARG0 (u / amr-unknown) :ARG1 (r / rehearse-01))',
    },
  ].map((entry) => ({ ...entry, origin: { kind: 'frozen-cli-test' } })),
);
const frozenDigest = project.digest;
const args = [
  'ask',
  '--project',
  location,
  '--scope',
  '/Workshop',
  '--question',
  question,
  '--offline',
  '--json',
];
// Who wrote the statements, declared beside the project: exported answers
// carry it with the corpus's identity.
const accepted = { by: 'Workshop reviewer', on: '2026-10-25' };
await writeFile(
  join(location, 'provenance.json'),
  JSON.stringify({
    version: 1,
    statements: [
      { text: 'Sam repairs bicycles.', author: 'Workshop author', accepted, number: 'W1' },
    ],
  }),
);
const answerResult = await command(args);
assert.equal(
  answerResult.stderr,
  '',
  'Noninteractive checks are quiet unless details are requested',
);
const answer = machine(answerResult);
assert.equal(answer.status, 'supported');
assert.equal(answer.answer.answers[0].text, 'Sam');
assert(answer.answer.answers[0].sourceIds.length);
assert(answer.answer.answers[0].bindings.length);
assert(answer.answer.answers[0].derivation.tree, 'The answer retains its chart proof');
assert(answer.answer.grammar.corpora[0].rules > 0);
assert(answer.calls.every((call) => call.client === 'PENMAN'));
assert.deepEqual(answer.provenance, {
  projectId: project.data.id,
  projectRevision: answer.projectDigest,
  statements: [
    {
      sourceId: answer.answer.answers[0].sourceIds[0],
      text: 'Sam repairs bicycles.',
      author: 'Workshop author',
      accepted,
      number: 'W1',
    },
  ],
});

const previousFetch = globalThis.fetch;
globalThis.fetch = () => assert.fail('TUI parity check must use frozen readings');
try {
  const captured = await captureProjectInquiry(
    project,
    project.data.placements[0].id,
    question,
    () => {},
    undefined,
    { acquireMissing: false, engineTrace: false },
  );
  const proof = (run) => ({
    status: run.status,
    answers: run.answer.answers.map(({ text, sourceIds, ruleIds }) => ({
      text,
      sourceIds,
      ruleIds,
    })),
  });
  assert.deepEqual(
    proof(captured.recording.reasoning),
    proof(answer),
    'CLI and TUI use the same attributed answer services',
  );
  assert.deepEqual(
    captured.recording.provenance,
    answer.provenance,
    'A recording carries the same provenance',
  );
} finally {
  globalThis.fetch = previousFetch;
}

const detailed = await command([...args, '--explain']);
assert.equal(machine(detailed).status, 'supported');
assert.match(detailed.stderr, /Check scoped source revisions/u);
const shown = machine(await command(['show', '--project', location, '--run', answer.id, '--json']));
assert.equal(shown.id, answer.id);
assert.deepEqual(shown.provenance, answer.provenance, 'and so does a saved check shown again');
assert.equal(shown.questions[0].text, question);
const human = await command(['show', '--project', location, '--run', answer.id, '--explain']);
successful(human);
assert.match(human.stdout, /Answer: Sam/u);
assert.match(human.stdout, /Evidence: Sam repairs bicycles/u);
assert.equal(human.stderr, '');
// A run retained before item-level lexical audits still renders its answer.
const legacyRun = {
  ...structuredClone(await readEngineRun(project, answer.id)),
  id: randomUUID(),
  lexicalAudit: { status: 'unverified' },
};
await saveEngineRun(project, legacyRun);
const legacy = await command(['show', '--project', location, '--run', legacyRun.id]);
successful(legacy);
assert.match(legacy.stdout, /Answer: Sam/u);
assert.doesNotMatch(legacy.stdout, /AMR vocabulary/u);
const alias = machine(await command(['run', ...args.slice(1)]));
assert.equal(alias.status, answer.status);
const open = machine(
  await command([
    'ask',
    '--project',
    location,
    '--question',
    'Who approves the rehearsal?',
    '--offline',
    '--json',
  ]),
);
assert.equal(open.answer.answers.length, 0);
assert(
  ['open', 'partial'].includes(open.status),
  'No evidence stays open with a successful check exit status',
);

const stopped = await command([...args, '--explain'], { interrupt: true });
assert(stopped.interrupted, 'The signal was sent during real engine work');
const cancelled = machine(stopped, 130);
assert.equal(cancelled.status, 'cancelled');
assert.match(stopped.stderr, /Cancelling check/u);
assert.equal(
  (await listEngineRuns(project)).find((run) => run.id === cancelled.id).status,
  'cancelled',
);

const beforeBadDelete = machine(await command(['runs', '--project', location, '--json']));
const badDelete = await command(['delete', '--project', location, '--all', 'extra']);
assert.equal(badDelete.code, 2);
assert.deepEqual(
  machine(await command(['runs', '--project', location, '--json'])),
  beforeBadDelete,
);
const deleted = machine(
  await command(['delete', '--project', location, '--run', cancelled.id, '--json']),
);
assert.deepEqual(deleted.deleted, [cancelled.id]);
const noLongerThere = await command([
  'show',
  '--project',
  location,
  '--run',
  cancelled.id,
  '--json',
]);
assert.equal(noLongerThere.code, 1);
assert.equal(noLongerThere.stdout, '');
assert.match(noLongerThere.stderr, /^Error:/u);
assert.equal((await openProject(location)).digest, frozenDigest);

const knowledgePath = join(directory, 'knowledge.json');
await writeFile(knowledgePath, '{broken');
const malformed = await command([
  'knowledge',
  '--project',
  location,
  '--file',
  knowledgePath,
  '--json',
]);
assert.equal(malformed.code, 1);
assert.equal(malformed.stdout, '');
assert.equal((await openProject(location)).digest, frozenDigest);
await writeFile(
  knowledgePath,
  JSON.stringify({
    kind: 'engine-knowledge',
    version: 1,
    id: 'empty-cli-import',
    name: 'Empty import',
    attribution: 'Process contract test',
    scopePlacementId: project.data.placements[0].id,
  }),
);
assert.equal(
  machine(await command(['knowledge', '--project', location, '--file', knowledgePath, '--json']))
    .id,
  'empty-cli-import',
);
assert.equal((await openProject(location)).data.knowledge[0].id, 'empty-cli-import');

const storage = machine(await command(['storage', '--project', location, '--json']));
assert(storage.bytes > 0 && storage.allocated > 0);
const compact = machine(await command(['compact', '--project', location, '--json']));
assert(compact.after.allocated > 0);
// A released check keeps the statements its answer rests on (review
// 2026-10-25, #4): shown again, it exports the same provenance.
await compactEngineStorage(await openProject(location), { force: true, budget: 32 * 1024 });
const released = machine(
  await command(['show', '--project', location, '--run', alias.id, '--json']),
);
assert.equal(released.cache, 'recheck', 'The check was released by compaction');
assert.deepEqual(released.provenance, {
  ...answer.provenance,
  projectRevision: alias.projectDigest,
});
// One released before it kept them says its statements are not known.
const releasedRun = await readEngineRun(project, alias.id);
const olderRelease = {
  ...releasedRun,
  id: randomUUID(),
  lastAnswer: {
    status: releasedRun.lastAnswer.status,
    answers: releasedRun.lastAnswer.answers.map(({ text }) => ({ text })),
  },
};
await saveEngineRun(project, olderRelease);
const older = machine(
  await command(['show', '--project', location, '--run', olderRelease.id, '--json']),
);
assert.deepEqual(older.provenance.statements, []);
assert.equal(older.provenance.statementsUnrecorded, true);
assert.equal(released.provenance.statementsUnrecorded, undefined);
const reset = machine(await command(['delete', '--project', location, '--all', '--json']));
assert.equal(reset.reset, true);
assert.deepEqual(machine(await command(['runs', '--project', location, '--json'])), []);
assert.deepEqual((await openProject(location)).data.concepts[0].passages, [
  'Sam repairs bicycles.',
]);
await writeFile(
  join(directory, 'process-results.json'),
  JSON.stringify(observations, null, 2) + '\n',
);
console.log(
  `ok ${observations.length} CLI processes: help, preflight, offline proof, TUI parity, JSON, cancellation and storage (${directory})`,
);
