/** Corpus fidelity on the bundled demo: every statement asked back and each
 * variable classed, the checked questions classed by what they rest on, the
 * same from a worker thread, and each probe outcome's class. Read-only. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, openProject } from '../../src/project/authoring/project.mjs';
import {
  fidelityInWorker,
  fidelityReport,
  formatFidelity,
  questionKinds,
  variableKind,
  variableKinds,
} from '../../src/project/inquiries/fidelity.mjs';

// Each probe outcome's class.
const probe = { sourceId: 's' };
const answer = (sourceIds, conditional = false) => ({ text: 'x', sourceIds, conditional });
for (const [checked, kind] of [
  [{ outcome: 'recovered', answers: [answer(['s'])] }, 'own'],
  [{ outcome: 'recovered', status: 'ambiguous', answers: [] }, 'possible'],
  [{ outcome: 'also elsewhere', answers: [] }, 'shared'],
  [{ outcome: 'elsewhere', answers: [answer(['t'])] }, 'carried'],
  [{ outcome: 'elsewhere', answers: [answer(['t'], true)] }, 'owed'],
  [{ outcome: 'elsewhere', status: 'ambiguous', answers: [] }, 'possible'],
  [{ outcome: 'conditional', answers: [] }, 'silent'],
  [{ outcome: 'necessary', answers: [] }, 'silent'],
  [{ outcome: 'otherwise', answers: [] }, 'otherwise'],
  [{ outcome: 'conflict', answers: [] }, 'conflict'],
  [{ outcome: 'open', answers: [] }, 'owed'],
  [{ outcome: 'limited', answers: [] }, 'owed'],
])
  assert.equal(variableKind(probe, checked), kind, `${checked.outcome} → ${kind}`);

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/fidelity-'));
try {
  await cp(resolve('demo/payments-on-call'), join(directory, 'demo'), { recursive: true });
  const project = await openProject(join(directory, 'demo'));
  const report = await fidelityReport(project, { withhold: true });
  const t = report.totals;
  assert.equal(
    t.variables,
    variableKinds.reduce((sum, kind) => sum + t[kind], 0),
  );
  assert.equal(t.answerable, t.own + t.shared + t.carried);
  assert.equal(t.borneAlone + t.borneShared, t.own + t.shared);
  assert.deepEqual(
    { ...t },
    {
      statements: 25,
      read: 25,
      variables: 85,
      own: 81,
      shared: 0,
      carried: 0,
      possible: 0,
      silent: 3,
      otherwise: 0,
      owed: 1,
      conflict: 0,
      answerable: 81,
      borneAlone: 81,
      borneShared: 0,
      settled: 24,
      restedOn: 18,
    },
  );
  assert.deepEqual(report.questions, {
    total: 36,
    one: 14,
    composed: 3,
    conditional: 11,
    possible: 1,
    met: 0,
    open: 7,
    composedAcrossRoles: 2,
  });
  assert.equal(
    questionKinds.reduce((sum, kind) => sum + report.questions[kind], 0),
    report.questions.total,
  );
  // Workbench statements are placed at their roles: the chain question composes
  // two statements from two roles.
  assert.deepEqual(
    report.asked.find((q) => q.question === 'Who notifies the customers?' && q.case),
    {
      question: 'Who notifies the customers?',
      case: 'A certificate expires.',
      kind: 'composed',
      statements: 2,
      roles: 2,
    },
  );
  assert.equal(report.roles.length, 6);
  assert.equal(
    report.roles.reduce((sum, role) => sum + role.statements, 0),
    t.statements,
  );
  // What to review is the one owed obligation.
  assert.deepEqual(
    report.statements.filter((item) => item.review.length).map((item) => item.review),
    [[{ kind: 'owed', asks: 'must do what' }]],
  );
  const text = formatFidelity(report);
  assert.match(text, /answerable 81 \(95%\): own 81, shared 0, carried 0/u);
  assert.match(text, /withheld: borne alone 81, shared with another statement 0/u);
  assert.match(text, /To review:\n {2}Sam, the support lead, must not promise/u);
  // A worker thread gives the same report.
  assert.deepEqual(await fidelityInWorker(project), await fidelityReport(project));
  // Without a check at the root role there is nothing to read.
  const empty = await createProject(join(directory, 'empty'), 'Empty');
  await assert.rejects(fidelityReport(empty), /ask a question there first/u);
  await assert.rejects(fidelityInWorker(empty), /ask a question there first/u);
  console.log('ok corpus fidelity: variables, questions, withholding, worker and outcome classes');
} finally {
  await rm(directory, { recursive: true, force: true });
}
