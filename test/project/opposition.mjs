/** The methods of opposition on a copy of the demo with a role that
 * contradicts the release manager: elenchus refutes a thesis directly or
 * through a rule, naming the smallest set of commitments; aporia finds where
 * the statements cannot hold together; counterexample finds where a rule
 * applies and is denied, and says when it never applies. On the demo as
 * bundled, nothing opposes. Nothing is saved or acquired; the copies are left
 * in tmp/. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openProject } from '../../src/project/authoring/project.mjs';
import { listEngineRuns } from '../../src/project/storage/engine-runs.mjs';
import { elenchusReport, formatElenchus } from '../../src/project/inquiries/elenchus.mjs';
import { aporiaReport, formatAporia } from '../../src/project/inquiries/aporia.mjs';
import {
  counterexampleReport,
  formatCounterexample,
} from '../../src/project/inquiries/counterexample.mjs';
import { methodsDemo } from '../support/methods-demo.mjs';

globalThis.fetch = () => {
  throw new Error('NETWORK_FORBIDDEN');
};
const path = await methodsDemo('opposition');
const project = await openProject(path);
const runs = (await listEngineRuns(project)).length;
const texts = (finding) => finding.statements.map((item) => item.statement).sort();
const rule = 'If a major incident is open, Morgan, the release manager, does not ship a release.';

// Elenchus. A conditional thesis is refuted directly by the release manager's
// rule, under its own condition; the smallest refutation stands alone.
const conditional = await elenchusReport(project, {
  statement: 'If a major incident is open, Morgan ships a release.',
  offline: true,
});
assert.equal(conditional.verdict, 'contested', 'Morgan ships a release, says another statement');
const direct = conditional.findings.filter((finding) => finding.kind === 'refutes');
assert.deepEqual(direct.map(texts), [[rule]]);
assert.equal(direct[0].via, 'directly');
assert.equal(direct[0].statements[0].author, 'Claude');
// Morgan is a company in the rule's reading and a person in this one: a name
// identifies, its type is the parser's guess.
const ships = await elenchusReport(project, {
  statement: 'Morgan ships a release.',
  offline: true,
});
assert(
  ships.findings.some(
    (finding) =>
      finding.kind === 'refutes' &&
      JSON.stringify(texts(finding)) === JSON.stringify(['A major incident is open.', rule]),
  ),
  'The rule and the open incident refute it, across the two types',
);
// Through a rule: supposed, a conjunction makes the rule apply, and the rule's
// conclusion is denied by the thesis's own other half. Both halves are also
// statements here, so the corpus supports it too: contested.
const conjunction = await elenchusReport(project, {
  text: 'A major incident is open, and Morgan ships a release.',
  offline: true,
});
assert.equal(conjunction.verdict, 'contested');
assert(
  conjunction.findings.some((finding) => finding.via?.rule === rule),
  'refuted through the release manager’s rule',
);
// Nothing refutes or supports what nothing speaks of.
const holiday = await elenchusReport(project, { text: 'Sam is on holiday.', offline: true });
assert.deepEqual([holiday.verdict, holiday.findings.length], ['open', 0]);
assert.match(formatElenchus(holiday), /open: nothing in the statements refutes or supports it/u);
const unread = await elenchusReport(project, { text: 'Priya is away.', offline: true });
assert.equal(unread.thesis.reading, 'needs-amr');

// Aporia: the plain statement against the rule (with the incident open), and
// the two opposed rules under their one condition.
const aporia = await aporiaReport(project);
assert.equal(aporia.findings.length, 3);
assert(
  aporia.findings.some(
    (finding) =>
      finding.kind === 'in its case' &&
      finding.case[0] === 'a major incident is open' &&
      JSON.stringify(texts(finding)) ===
        JSON.stringify(['If a major incident is open, Morgan ships a release.', rule]),
  ),
);
assert(aporia.findings.every((finding) => finding.question.endsWith('which is meant?')));
const policy = await aporiaReport(project, { role: 'Security Engineer' });
assert.deepEqual(policy.findings, [], 'The security engineer’s statements hold together');

// Counterexample: the rule applies once (the incident is open) and two
// statements say Morgan ships.
const counter = await counterexampleReport(project, { statement: rule });
assert.equal(counter.applies, 1);
assert.deepEqual(counter.findings.map(texts), [
  ['A major incident is open.', 'If a major incident is open, Morgan ships a release.'],
  ['A major incident is open.', 'Morgan ships a release.'],
]);
const kind = await counterexampleReport(project, { statement: 'A deployment is a change.' });
assert.deepEqual(kind.findings, []);
assert.match(formatCounterexample(kind), /Nothing the other statements say opposes it/u);

// On the demo as bundled: nothing opposes, and a rule whose condition no
// statement meets never applies.
await mkdir('tmp', { recursive: true });
const plain = join(await mkdtemp(resolve('tmp/opposition-plain-')), 'payments-demo');
await cp(resolve('demo/payments-on-call'), plain, { recursive: true });
const bundled = await openProject(plain);
const calm = await aporiaReport(bundled);
assert.deepEqual(calm.findings, []);
assert.match(formatAporia(calm), /they hold together; nothing opposes/u);
const never = await counterexampleReport(bundled, { statement: 'If a certificate expires' });
assert.equal(never.applies, 0);
assert.match(formatCounterexample(never), /It never applies: nothing the statements say meets/u);

assert.equal((await listEngineRuns(project)).length, runs, 'No check was saved');

// Through the CLI.
const cli = (...args) =>
  spawnSync(process.execPath, ['src/cli/engine.mjs', ...args, '--project', path, '--offline'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
assert.match(cli('aporia').stdout, /^Aporia over 28 statements \(5 rules\): 3 places/u);
assert.match(
  cli('elenchus', '--statement', 'A major incident is open.').stdout,
  /: refuted\.\n\nRefuted through/u,
);
assert.equal(cli('elenchus', '--text', 'Priya is away.').status, 1);
assert.equal(cli('elenchus').status, 2, 'One thesis is required');
assert.equal(JSON.parse(cli('counterexample', '--statement', rule, '--json').stdout).applies, 1);

console.log(`ok opposition: elenchus, aporia and counterexample, and their null results (${path})`);
