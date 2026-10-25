/** The methods of opposition on a copy of the bundled demo: aporia finds
 * Maya's rule against Friday's failures, and the key rule against the freeze
 * rule when both conditions meet (asked both ways, since the release the key
 * rule ships is the one Morgan manages); counterexample finds Maya's rule
 * applied and denied, and says when a rule never applies; elenchus refutes a
 * thesis directly or through a rule, and leaves open what nothing refutes. A
 * copy with one more role tests a name read as two types. Nothing is saved
 * or acquired; the copies are left in tmp/. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openProject } from '../../src/project/authoring/project.mjs';
import { listEngineRuns } from '../../src/project/storage/engine-runs.mjs';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import { elenchusReport, formatElenchus } from '../../src/project/inquiries/elenchus.mjs';
import { aporiaReport, formatAporia } from '../../src/project/inquiries/aporia.mjs';
import {
  counterexampleReport,
  formatCounterexample,
} from '../../src/project/inquiries/counterexample.mjs';
import { methodsDemo, theses } from '../support/methods-demo.mjs';

globalThis.fetch = () => {
  throw new Error('NETWORK_FORBIDDEN');
};
await mkdir('tmp', { recursive: true });
const path = join(await mkdtemp(resolve('tmp/opposition-')), 'payments-demo');
await cp(resolve('demo/payments-on-call'), path, { recursive: true });
let project = await openProject(path);
// Theses that are not statements, as eGemma read them.
await retainAcquisitions(
  project,
  Object.entries(theses).map(([text, penman]) => ({
    text,
    penman,
    origin: { kind: 'test-fixture' },
  })),
);
project = await openProject(path);
const runs = (await listEngineRuns(project)).length;
const texts = (finding) => finding.statements.map((item) => item.statement).sort();
const freeze = 'If a major incident is open, Morgan, the release manager, does not ship a release.';
const key = 'If a payment key leaks, Morgan, the release manager, ships a release.';
const maya =
  'Maya, the incident commander, declares a major incident when payment failures last more than ten minutes.';
const friday =
  'On Friday payment failures lasted more than ten minutes, and Maya, the incident commander, did not declare a major incident.';

// Aporia: two places the statements cannot hold together.
const aporia = await aporiaReport(project);
assert.deepEqual(
  aporia.findings.map((finding) => [finding.kind, finding.case, texts(finding)]),
  [
    ['in its case', ['payment failures last more than ten minutes'], [maya, friday]],
    ['joint case', ['a major incident is open', 'a payment key leaks'], [freeze, key]],
  ],
);
assert(aporia.findings.every((finding) => finding.question.endsWith('which is meant?')));
assert.match(formatAporia(aporia), /2 places where they cannot hold together/u);
const security = await aporiaReport(project, { role: 'Security Engineer' });
assert.deepEqual(security.findings, [], 'The security engineer’s statements hold together');
assert.match(formatAporia(security), /they hold together; nothing opposes/u);

// Counterexample: Friday's failures meet Maya's rule, and she did not declare.
const counter = await counterexampleReport(project, { statement: maya });
assert.equal(counter.applies, 1);
assert.deepEqual(counter.findings.map(texts), [[friday]]);
const never = await counterexampleReport(project, { statement: 'If a certificate expires' });
assert.equal(never.applies, 0, 'No statement says a certificate expires');
assert.match(formatCounterexample(never), /It never applies: nothing the statements say meets/u);
const kind = await counterexampleReport(project, { statement: 'A deployment is a change.' });
assert.deepEqual(kind.findings, []);
assert.match(formatCounterexample(kind), /Nothing the other statements say opposes it/u);

// Elenchus. Under its own condition alone, the key rule is neither refuted nor
// supported: the opposition needs a major incident too.
const alone = await elenchusReport(project, { statement: key, offline: true });
assert.deepEqual([alone.verdict, alone.findings.length], ['open', 0]);
// A thesis under the freeze rule's condition is refuted directly, by it alone.
const conditional = await elenchusReport(project, {
  text: 'If a major incident is open, Morgan ships a release.',
  offline: true,
});
assert.equal(conditional.verdict, 'refuted');
assert.deepEqual(conditional.findings.map(texts), [[freeze]]);
assert.equal(conditional.findings[0].via, 'directly');
assert.equal(conditional.findings[0].statements[0].author, 'Claude');
// Supposed, a conjunction makes the freeze rule apply, and the rule's
// conclusion is denied by the thesis's own other half.
const conjunction = await elenchusReport(project, {
  text: 'A major incident is open, and Morgan ships a release.',
  offline: true,
});
assert.equal(conjunction.verdict, 'refuted');
assert(conjunction.findings.some((finding) => finding.via?.rule === freeze));
// Nothing refutes or supports what nothing speaks of.
const holiday = await elenchusReport(project, { text: 'Sam is on holiday.', offline: true });
assert.deepEqual([holiday.verdict, holiday.findings.length], ['open', 0]);
assert.match(formatElenchus(holiday), /open: nothing in the statements refutes or supports it/u);
const unread = await elenchusReport(project, { text: 'Priya is away.', offline: true });
assert.equal(unread.thesis.reading, 'needs-amr');
assert.equal((await listEngineRuns(project)).length, runs, 'No check was saved');

// Morgan is a company in the freeze rule's reading and a person in another's:
// a name identifies, its type is the parser's guess.
const typed = await openProject(await methodsDemo('opposition-types'));
const ships = await elenchusReport(typed, { statement: 'Morgan ships a release.', offline: true });
assert(
  ships.findings.some(
    (finding) =>
      finding.kind === 'refutes' &&
      JSON.stringify(texts(finding)) === JSON.stringify(['A major incident is open.', freeze]),
  ),
  'The rule and the open incident refute it, across the two types',
);

// Through the CLI.
const cli = (...args) =>
  spawnSync(process.execPath, ['src/cli/engine.mjs', ...args, '--project', path, '--offline'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
assert.match(cli('aporia').stdout, /^Aporia over 30 statements \(7 rules\): 2 places/u);
assert.match(
  cli('elenchus', '--text', 'If a major incident is open, Morgan ships a release.').stdout,
  /: refuted\.\n\nRefuted directly, by 1 statement:/u,
);
assert.equal(cli('elenchus', '--text', 'Priya is away.').status, 1);
assert.equal(cli('elenchus').status, 2, 'One thesis is required');
assert.equal(JSON.parse(cli('counterexample', '--statement', maya, '--json').stdout).applies, 1);

console.log(`ok opposition: elenchus, aporia and counterexample, and their null results (${path})`);
