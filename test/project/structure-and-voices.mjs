/** Collection and division, dilemma, analogy and dialogue on a copy of the
 * bundled demo: the release manager and the incident commander tie their
 * roles; whichever of a certificate expiring or a payment key leaking holds,
 * Priya renews the certificate and Sam notifies; the audit-note rule holds
 * for Priya, and is asked of Alex; Claude's Friday statement clashes with an
 * unrecorded rule. Each says so when it finds nothing. Nothing is saved or
 * acquired; the copy is left in tmp/. */
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
const path = join(await mkdtemp(resolve('tmp/structure-and-voices-')), 'payments-demo');
await cp(resolve('demo/payments-on-call'), path, { recursive: true });
const project = await openProject(path);
const texts = (finding) => finding.statements.map((item) => item.statement).sort();

// Collection: the release manager confirms before the incident commander
// closes, the incident commander closes after the release manager confirms;
// each leans on the other, a tie between their roles. A role's own person
// ties its statements (a name always counts), and a measure (ten minutes)
// ties nothing, so no role falls apart.
const division = await divisionReport(project);
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

// Dilemma: a second way into the certificate chain, and a statement of the
// two alternatives; whichever holds, the chain follows.
const dilemma = await dilemmaReport(project);
assert.equal(dilemma.alternatives, 1);
assert.deepEqual(
  dilemma.findings.map((finding) => [finding.kind, finding.alternatives, finding.conclusion]),
  [
    [
      'either way',
      ['a certificate expires', 'a payment key leaks'],
      'Priya, the security engineer, renews the certificate',
    ],
    [
      'either way',
      ['a certificate expires', 'a payment key leaks'],
      'Sam, the support lead, notifies the customers',
    ],
  ],
);

// Analogy: Priya and Alex both review access logs; the audit-note rule names
// Priya, so it applies with hers. Asked, not answered.
const analogy = await analogyReport(project);
assert.deepEqual(
  analogy.findings.map((finding) => finding.question),
  ['Does “If Priya reviews access logs, she files an audit note.” hold for Alex as for Priya?'],
);

// Dialogue: Friday's failures (Claude) against Maya's rule (unrecorded).
const dialogue = await dialogueReport(project);
assert.deepEqual(
  dialogue.findings.map((finding) => [finding.kind, [...finding.authors].sort()]),
  [['clash', ['Claude', 'unrecorded']]],
);
assert.match(
  formatDialogue(dialogue),
  /An unrecorded author and Claude disagree here: which is meant\?/u,
);

// One way only: with "either a certificate expires or the vault opens" and
// no rule for the vault, Priya renews the certificate under one alternative,
// and the finding asks which holds.
const oneWay = await dilemmaReport(
  await openProject(
    await methodsDemo('dilemma-one-way', {
      roles: { Vault: ['Either a certificate expires or the vault opens.'] },
      extra: {
        'Either a certificate expires or the vault opens.':
          '(o / or :op1 (e / expire-01 :ARG1 (c / certificate)) :op2 (p / open-01 :ARG1 (v / vault)))',
      },
    }),
  ),
);
const renews = oneWay.findings.find(
  (finding) => finding.conclusion === 'Priya, the security engineer, renews the certificate',
);
assert.equal(renews.kind, 'one way only');
assert.match(renews.question, /^Which is it: a certificate expires, or the vault opens\?/u);

// A declared author who says, in other words, what an unrecorded statement
// says: a shared commitment, not a clash. (eGemma reads this Maya as a
// company; the name identifies her.)
const shared = await dialogueReport(
  await openProject(
    await methodsDemo('dialogue-shared', {
      roles: { Finance: ['Maya approves the database vendor invoice.'] },
      extra: {
        'Maya approves the database vendor invoice.':
          '(z0 / approve-01 :ARG0 (z1 / company :wiki - :name (z2 / name :op1 "Maya")) :ARG1 (z3 / bill-01 :ARG2 (z4 / person :ARG0-of (z5 / vend-01 :ARG1 (z6 / database)))))',
      },
      author: 'Dana',
    }),
  ),
);
assert(
  shared.findings.some(
    (finding) =>
      finding.kind === 'agreement' &&
      JSON.stringify([...finding.authors].sort()) === JSON.stringify(['Dana', 'unrecorded']),
  ),
  'Dana and an unrecorded author commit to the same',
);

// What each says when it finds nothing.
assert.match(
  formatDilemma({ alternatives: 0, findings: [] }),
  /nothing follows from any alternative/u,
);
assert.match(
  formatAnalogy({ pairs: 0, findings: [] }),
  /no rule applies to one and not the other/u,
);
assert.match(
  formatDivision({ statements: 1, roles: 1, findings: [] }),
  /each role holds together, and no statement leans elsewhere/u,
);
assert.match(
  formatDialogue({ authors: ['Claude'], findings: [] }),
  /0 clashes, 0 shared commitments/u,
);

const cli = (...args) =>
  spawnSync(process.execPath, ['src/cli/engine.mjs', ...args, '--project', path, '--offline'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
assert.equal(cli('collection').stdout, cli('division').stdout, 'collection is division');
assert.equal(JSON.parse(cli('dialogue', '--json').stdout).findings.length, 1);

console.log(
  `ok structure and voices: collection and division, dilemma, analogy and dialogue (${path})`,
);
