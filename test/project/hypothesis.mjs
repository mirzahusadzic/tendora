/** Hypothesis (suppose) sets a statement beside the corpus in an overlay that
 * is never saved: on a copy of the bundled demo it reports what the statement
 * says, the rules that apply only with it, and the saved questions it would
 * answer, change or bring into conflict; a statement already said, or one from
 * which nothing follows, says so. The copy's files are byte for byte the same
 * after every supposition. Nothing is acquired; the copy is left in tmp/. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openProject } from '../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import { listEngineRuns } from '../../src/project/storage/engine-runs.mjs';
import { formatHypothesis, hypothesisReport } from '../../src/project/inquiries/hypothesis.mjs';
import { supposedId } from '../../src/project/inquiries/corpus.mjs';

const noNetwork =
  'data:text/javascript,' +
  encodeURIComponent('globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };');
globalThis.fetch = () => {
  throw new Error('NETWORK_FORBIDDEN');
};
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/hypothesis-'));
const path = join(directory, 'payments-demo');
await cp(resolve('demo/payments-on-call'), path, { recursive: true });
let project = await openProject(path);

// Two readings a person might suppose, retained exactly as eGemma read them
// (its wiki guesses too: Morgan is read as a company, in the saved question as
// well), so the test reads them offline.
const holiday = 'Sam is on holiday.',
  ships = 'A major incident is open, and Morgan ships a release.';
await retainAcquisitions(project, [
  {
    text: holiday,
    penman:
      '(z0 / holiday-01 :ARG0 (z1 / person :wiki "Kim Dae-jung" :name (z2 / name :op1 "Sam")))',
    origin: { kind: 'test-fixture' },
  },
  {
    text: ships,
    penman:
      '(z0 / and :op1 (z1 / open-01 :ARG1 (z2 / incident :ARG1-of (z3 / major-02))) :op2 (z4 / ship-01 :ARG0 (z5 / company :wiki "Morgan Stanley" :name (z6 / name :op1 "Morgan")) :ARG1 (z7 / release-01)))',
    origin: { kind: 'test-fixture' },
  },
]);
project = await openProject(path);

const files = async () => {
  const digest = createHash('sha256');
  for (const name of (await readdir(path, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort())
    digest.update(name).update(await readFile(name));
  return digest.digest('hex');
};
const before = await files(),
  runs = (await listEngineRuns(project)).length;
const suppose = (text, options = {}) =>
  hypothesisReport(project, { text, offline: true, ...options });
const item = (report, question, kase) =>
  report.questions.items.find((entry) => entry.question === question && entry.case === kase);

// A rule's condition supposed: two rules chain from it, and the open question
// "Who notifies the customers?" is answered, resting on the supposition.
const expires = await suppose('A certificate expires.');
assert.equal(expires.saved, false);
assert.equal(expires.supposed.reading, 'read');
assert.deepEqual(
  expires.variables.map((variable) => variable.outcome),
  ['new', 'new'],
  'Nothing else says a certificate expires',
);
assert.deepEqual(
  expires.follows.map((rule) => [rule.rule.split(',')[0], rule.onlyWith > 0]).sort(),
  [
    ['If Priya renews the certificate', true],
    ['If a certificate expires', true],
  ],
  'Both rules of the chain apply, and only with the supposition',
);
const notifies = item(expires, 'Who notifies the customers?');
assert.equal(notifies.kind, 'answered');
assert.deepEqual([notifies.before.status, notifies.after.answers], ['open', ['Sam']]);
assert(notifies.after.restsOnSupposition, 'The new answer rests on the supposition');
assert.equal(notifies.after.restsOn.length, 2, 'and on both rules');
// The same words as a check's case are a second certificate beside it: the
// engine does not decide they are one, and says the answer is ambiguous.
const renews = item(expires, 'Who renews the certificate?', 'A certificate expires.');
assert.equal(renews.kind, 'changed');
assert.equal(renews.after.status, 'ambiguous');
assert.deepEqual(
  renews.after.candidates
    .map((candidate) => [candidate.text, Boolean(candidate.supposition), Boolean(candidate.case)])
    .sort(),
  [
    ['Priya', false, true],
    ['Priya', true, false],
  ],
);
assert.equal(expires.questions.checked, 34, 'Every saved question in its scope');
assert.equal(expires.questions.unchanged, 31);
assert.equal(expires.nothingFollows, false);

// A supposition the corpus denies: the release manager's rule says Morgan does
// not ship during a major incident.
const shipping = await suppose(ships);
const ship = item(shipping, 'Does Morgan ship a release?', 'A major incident is open.');
assert.equal(ship.kind, 'conflict');
assert.deepEqual(ship.before.answers, ['No']);
assert(
  ship.after.candidates.some((candidate) => candidate.text === 'Yes' && candidate.supposition),
  'Yes comes from the supposition, No from the rule',
);
assert.deepEqual(
  shipping.follows.map((rule) => rule.rule),
  ['If a major incident is open, Morgan, the release manager, does not ship a release.'],
  'Its own clauses read apart are not a consequence',
);

// The null result: nothing follows, and that is a result.
const away = await suppose(holiday);
assert.deepEqual([away.follows.length, away.questions.items.length], [0, 0]);
assert.equal(away.nothingFollows, true);
assert.match(formatHypothesis(away), /Nothing follows from it/u);

// Said already: supposing it again adds nothing.
const said = await suppose(
  'Morgan, the release manager, freezes deployments during a major incident.',
);
assert.equal(said.supposed.alreadyStated, 'Release Manager');
assert.equal(said.nothingFollows, true);

// Under a role it stands in the checks scoped at that role or above it: the
// release manager's own checks, too.
const placed = await suppose('A certificate expires.', { role: 'Release Manager' });
assert.equal(placed.supposed.role, 'Release Manager');
assert.equal(placed.questions.checked, expires.questions.checked + 2);

// Offline, a sentence without a retained reading is not read.
const unread = await suppose('Priya is away.');
assert.equal(unread.supposed.reading, 'needs-amr');
assert.equal(unread.variables, undefined);

assert.equal(await files(), before, 'Nothing in the project changed');
assert.equal((await listEngineRuns(project)).length, runs, 'No check was saved');
assert(!JSON.stringify(expires).includes(`"${supposedId}"`), 'Its internal id is not reported');

// Through the CLI, also as tendora hypothesis; a supposition left unread exits 1.
const cli = (...args) =>
  spawnSync(
    process.execPath,
    ['--import', noNetwork, 'src/cli/engine.mjs', ...args, '--project', path, '--offline'],
    { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  );
const text = cli('suppose', '--text', 'A certificate expires.');
assert.equal(text.status, 0, text.stderr);
assert.match(
  text.stdout,
  /^Supposing “A certificate expires\.” at Incident Commander; nothing is saved\./u,
);
assert.match(
  text.stdout,
  /answered: Who notifies the customers\? {2}open → Sam; rests on the supposition and 2 statements/u,
);
const alias = cli('hypothesis', '--text', holiday, '--json');
assert.equal(alias.status, 0, alias.stderr);
assert.equal(JSON.parse(alias.stdout).nothingFollows, true);
assert.equal(cli('suppose', '--text', 'Priya is away.').status, 1);
assert.equal(cli('suppose').status, 2, '--text is required');
assert.equal(await files(), before, 'The CLI changed nothing either');

console.log(
  `ok hypothesis: an overlay never saved, its consequences and its null result (${directory})`,
);
