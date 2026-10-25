/** Maieutics, equivocation and definition on a copy of the bundled demo:
 * the missing premise of an open question walked back through two rules and
 * asked back in the rules' words, the deepest first; a word read in two
 * senses; a term's genus from a kind statement, and the questions what
 * nothing says becomes. Nothing is saved or acquired; the copy is left in
 * tmp/. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openProject } from '../../src/project/authoring/project.mjs';
import { listEngineRuns } from '../../src/project/storage/engine-runs.mjs';
import { formatMaieutics, maieuticsReport } from '../../src/project/inquiries/maieutics.mjs';
import {
  equivocationReport,
  formatEquivocation,
} from '../../src/project/inquiries/equivocation.mjs';
import { definitionReport, formatDefinition } from '../../src/project/inquiries/definition.mjs';

globalThis.fetch = () => {
  throw new Error('NETWORK_FORBIDDEN');
};
await mkdir('tmp', { recursive: true });
const path = join(await mkdtemp(resolve('tmp/premises-and-words-')), 'payments-demo');
await cp(resolve('demo/payments-on-call'), path, { recursive: true });
const project = await openProject(path);
const runs = (await listEngineRuns(project)).length;
const texts = (finding) => finding.statements.map((item) => item.statement);

// Maieutics: "Who notifies the customers?" is open; the support lead's rule
// would answer it if Priya renewed the certificate, and the security
// engineer's two rules would bring that about if a certificate expired or a
// payment key leaked: the deepest premises first, each tried as the case.
const notified = await maieuticsReport(project, { question: 'Who notifies the customers?' });
const premises = notified.findings.filter((finding) => finding.kind === 'missing premise');
assert.deepEqual(
  premises.map((finding) => [finding.premise, finding.answers, finding.statements.length]),
  [
    ['a certificate expires', ['Sam'], 2],
    ['a payment key leaks', ['Sam'], 2],
    ['Priya renews the certificate', ['Sam'], 1],
  ],
);
assert.equal(premises[0].ask, 'Is it so that a certificate expires?');
assert.equal(premises[0].author, 'Claude', 'asked of the author of the rule');
const all = await maieuticsReport(project);
assert(
  all.findings.some(
    (finding) =>
      finding.kind === 'unjoined' &&
      finding.question === 'Which engineer acknowledges every page within ten minutes?' &&
      texts(finding)[0] ===
        'Alex, the on-call engineer, acknowledges every page within five minutes.',
  ),
  'five minutes said, ten asked: is it meant to answer?',
);
assert(
  !all.findings.some((finding) => /Why/u.test(finding.question)),
  '“why” asks through cause-01, a frame, not about a statement’s cause',
);
assert.match(formatMaieutics(notified), /ask Claude: Is it so that a certificate expires\?/u);

// Equivocation: Jordan restores a backup in two senses.
const words = await equivocationReport(project);
const restore = words.findings.find((finding) => finding.lemma === 'restore');
assert.deepEqual(
  restore.senses.map((item) => [item.concept, item.gloss]),
  [
    ['restore-01', 'give back'],
    ['restore-02', 'make like new, restore to previous state'],
  ],
);
assert.match(formatEquivocation(words), /“restore” is read in 2 senses/u);
assert.deepEqual(
  words.findings.map((finding) => [finding.kind, finding.lemma]),
  [
    ['senses', 'restore'],
    ['structure', undefined],
  ],
  'the whole inventory: one word in two senses, one phrase in two structures',
);
// The same words read as two structures: "a payment key" is key :mod pay-01
// in two readings and key :instrument-of pay-01 in four.
const key = words.findings.find((finding) => finding.kind === 'structure');
assert.deepEqual(
  [key.words, key.structures.map((item) => [item.reading, item.statements.length])],
  [
    'a payment key',
    [
      ['key :mod pay-01', 2],
      ['key :instrument-of pay-01', 4],
    ],
  ],
);
assert.match(formatEquivocation(words), /“a payment key” is read with 2 structures/u);

// Definition: a deployment is a change (eGemma reads it as deploy-01, which
// PropBank names "deployment"); nothing says what a change is.
const deployment = await definitionReport(project, { term: 'deployment' });
assert.deepEqual(
  deployment.genus.map((row) => [row.kind, row.statement]),
  [['change-01', 'A deployment is a change.']],
);
assert.deepEqual(
  deployment.said.map((row) => row.relation),
  ['freeze-02 :ARG1'],
);
assert.deepEqual(deployment.findings, []);
const change = await definitionReport(project, { term: 'change' });
assert.deepEqual(
  change.species.map((row) => row.kind),
  ['deploy-01'],
);
assert.deepEqual(
  change.findings.map((finding) => finding.question),
  ['What is a change?'],
);
assert.match(formatDefinition(change), /Nothing says what kind of thing a change is/u);

assert.equal((await listEngineRuns(project)).length, runs, 'No check was saved');
const cli = (...args) =>
  spawnSync(process.execPath, ['src/cli/engine.mjs', ...args, '--project', path, '--offline'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
assert.match(cli('maieutics').stdout, /^Maieutics over 18 open or conditional questions/u);
assert.equal(JSON.parse(cli('equivocation', '--json').stdout).findings[0].lemma, 'restore');
assert.equal(cli('definition').status, 2, '--term is required');

console.log(`ok premises and words: maieutics, equivocation and definition (${path})`);
