/** Collection and division, dilemma, analogy and dialogue: on the demo as
 * bundled, the two statements that tie the release manager and the incident
 * commander lean on each other; with alternatives, what follows either way;
 * with two statements of one shape, the rule that applies to one only; with
 * declared authors, where they clash. On the bundled demo the last three find
 * nothing, and say so. Nothing is saved or acquired; copies are left in tmp/. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openProject } from '../../src/project/authoring/project.mjs';
import { divisionReport, formatDivision } from '../../src/project/inquiries/division.mjs';
import { dilemmaReport, formatDilemma } from '../../src/project/inquiries/dilemma.mjs';
import { analogyReport, formatAnalogy } from '../../src/project/inquiries/analogy.mjs';
import { dialogueReport, formatDialogue } from '../../src/project/inquiries/dialogue.mjs';
import { methodsDemo } from '../support/methods-demo.mjs';

globalThis.fetch = () => {
  throw new Error('NETWORK_FORBIDDEN');
};
await mkdir('tmp', { recursive: true });
const plain = join(await mkdtemp(resolve('tmp/structure-and-voices-')), 'payments-demo');
await cp(resolve('demo/payments-on-call'), plain, { recursive: true });
const bundled = await openProject(plain);
const texts = (finding) => finding.statements.map((item) => item.statement).sort();

// Collection: the release manager confirms before the incident commander
// closes, the incident commander closes after the release manager confirms.
const division = await divisionReport(bundled);
assert.deepEqual(
  division.findings.map((finding) => [finding.kind, texts(finding)]),
  [
    [
      'collection',
      [
        'Maya, the incident commander, must close a major incident after the release manager confirms that payments are healthy.',
        'Morgan, the release manager, confirms that payments are healthy before the incident commander closes a major incident.',
      ],
    ],
  ],
);
assert.match(
  division.findings[0].proposal,
  /the tie between Release Manager and Incident Commander/u,
);
assert.match(formatDivision(division), /1 proposal\./u);

// On the bundled demo: no alternatives, no rule applies to one statement of a
// shape and not another, and its two authors (Claude, and the unrecorded)
// neither clash nor share.
const none = await dilemmaReport(bundled);
assert.deepEqual([none.alternatives, none.findings.length], [0, 0]);
assert.match(formatDilemma(none), /nothing follows from any alternative/u);
const calm = await analogyReport(bundled);
assert.deepEqual(calm.findings, []);
assert.match(formatAnalogy(calm), /no rule applies to one and not the other/u);
const quiet = await dialogueReport(bundled);
assert.deepEqual(quiet.findings, []);
assert.deepEqual(quiet.authors.sort(), ['Claude', 'unrecorded']);

// Dilemma: whichever of a certificate expiring or a payment key leaking,
// Priya renews the certificate, and through the chain Sam notifies.
const either = await openProject(
  await methodsDemo('dilemma', {
    role: 'Escalation',
    statements: [
      'Either a certificate expires or a payment key leaks.',
      'If a payment key leaks, Priya renews the certificate.',
    ],
  }),
);
const dilemma = await dilemmaReport(either);
assert.deepEqual(
  dilemma.findings.map((finding) => [finding.kind, finding.alternatives]),
  [
    ['either way', ['a certificate expires', 'a payment key leaks']],
    ['either way', ['a certificate expires', 'a payment key leaks']],
  ],
);
assert.deepEqual(
  dilemma.findings.map((finding) => finding.conclusion),
  ['Priya renews the certificate', 'Sam, the support lead, notifies the customers'],
);

// Analogy: the certificate rule applies with a certificate expiring, not with
// a payment key expiring; asked, not answered.
const expiry = await openProject(
  await methodsDemo('analogy', {
    role: 'Expiry',
    statements: ['A certificate expires.', 'A payment key expires.'],
  }),
);
const analogy = await analogyReport(expiry);
assert(
  analogy.findings.some(
    (finding) =>
      finding.question ===
      'Does “If a certificate expires, Priya, the security engineer, renews the certificate.” hold for key as for certificate?',
  ),
);
assert(analogy.findings.every((finding) => finding.kind === 'transfer'));

// Dialogue: Dana's declared statements against Claude's release rule.
const voices = await openProject(await methodsDemo('dialogue', { author: 'Dana' }));
const dialogue = await dialogueReport(voices);
assert(dialogue.findings.length >= 2);
assert(
  dialogue.findings.every(
    (finding) =>
      finding.kind === 'clash' &&
      JSON.stringify([...finding.authors].sort()) === JSON.stringify(['Claude', 'Dana']),
  ),
);
assert.match(formatDialogue(dialogue), /Dana and Claude disagree here: which is meant\?/u);

const cli = (...args) =>
  spawnSync(process.execPath, ['src/cli/engine.mjs', ...args, '--project', plain, '--offline'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
assert.equal(cli('collection').stdout, cli('division').stdout, 'collection is division');
assert.equal(JSON.parse(cli('dialogue', '--json').stdout).findings.length, 0);

console.log('ok structure and voices: collection and division, dilemma, analogy and dialogue');
