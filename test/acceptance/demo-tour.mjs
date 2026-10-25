/** The capability tour of docs/demo.md replays offline on a copy of the bundled
 * demo: each capability's question and outcome through the real CLI, and its
 * view in the workbench. Nothing is acquired; the bundled demo is unchanged. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openProject } from '../../src/project/authoring/project.mjs';
import { journeyWorkbench } from '../support/journey-workbench.mjs';

const noNetwork =
  'data:text/javascript,' +
  encodeURIComponent('globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };');
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/demo-tour-'));
const project = join(directory, 'payments-demo');
await cp(resolve('.proj/payments-on-call'), project, { recursive: true });

function tendora(...args) {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', noNetwork, 'src/cli/engine.mjs', ...args, '--project', project],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.on('error', reject);
    child.on('close', (code) => {
      assert(!stderr.includes('NETWORK_FORBIDDEN'), 'The tour never acquires');
      done({ code, stdout, stderr });
    });
  });
}
const json = async (...args) => {
  const result = await tendora(...args, '--json');
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const ask = (question, ...more) => json('ask', '--question', question, '--offline', ...more);
const texts = (run) => run.answer.answers.map((answer) => answer.text);
let ui;

try {
  // Asking within a scope: a source answers with the statements it rests on.
  const asked = await ask('Who freezes deployments during a major incident?');
  assert.deepEqual([asked.status, texts(asked)], ['supported', ['Morgan']]);
  const outside = await ask(
    'Who approves the database vendor invoice?',
    '--scope',
    'Release Manager',
  );
  assert.equal(outside.status, 'open', 'A statement outside the scope answers nothing');
  // A kind statement extends one way: deployments are changes.
  const kind = await ask('Who freezes changes during a major incident?');
  assert.deepEqual([kind.status, texts(kind)], ['supported', ['Morgan']]);
  assert(kind.answer.answers[0].sourceIds.length === 2, 'It rests on the kind statement too');
  // A rule and its case; two rules in two roles chain under one case.
  const renews = await ask('Who renews the certificate?', '--case-text', 'A certificate expires.');
  assert.deepEqual(texts(renews), ['Priya']);
  const chain = await ask(
    'Who notifies the customers?',
    '--case-text',
    'A certificate expires.',
    '--actor',
    'Dana',
  );
  assert.deepEqual([chain.status, texts(chain)], ['supported', ['Sam']]);
  assert.equal(chain.answer.answers[0].ruleIds.length, 2, 'Two rules, read from two statements');
  const said = await tendora(
    'ask',
    '--question',
    'Who notifies the customers?',
    '--case-text',
    'A certificate expires.',
    '--offline',
  );
  assert.match(said.stdout, /Answer: Sam\n {2}Rests on the case and 2 statements\./u);
  const ungrounded = await ask('Who notifies the customers?');
  assert.equal(ungrounded.status, 'open', 'Without its case, a rule answers nothing');
  // A negated conclusion under a condition.
  const denied = await ask(
    'Does Morgan ship a release?',
    '--case-text',
    'A major incident is open.',
  );
  assert.deepEqual(texts(denied), ['No']);
  // Reading steps, each named in the answer.
  const pronoun = await ask('Does Jordan test a backup before restoring it?');
  assert.deepEqual([texts(pronoun), pronoun.answer.answers[0].readAs], [['Yes'], 'reference']);
  const should = await ask('Who should rotate a leaked payment key?');
  assert.deepEqual([texts(should), should.answer.answers[0].readAs], [['Priya'], 'requirement']);
  const may = await ask('Who may fail over the primary database?');
  assert.deepEqual([may.status, texts(may)], ['conditional', ['Jordan']]);
  // Open, said why: a proposal one confirmation away, the closest statements, a
  // number the sources do not give.
  const proposed = await ask('Who may approve a rollback of the payments service?');
  assert.equal(proposed.status, 'open');
  assert.deepEqual(
    proposed.answer.clarifications.map((proposal) => proposal.answerLabel),
    ['Maya'],
  );
  const closest = await ask('Who pays the database vendor?');
  assert.match(closest.answer.related[0].text, /approves the database vendor invoice/u);
  const human = await tendora('ask', '--question', 'Who pays the database vendor?', '--offline');
  assert.match(human.stdout, /Why it stays open:/u);
  assert.match(human.stdout, /Closest statements/u);
  const number = await ask('Which engineer acknowledges every page within ten minutes?');
  assert.equal(number.status, 'open', 'Five minutes does not answer ten');
  // Two roles say access logs are reviewed: each answers the yes/no question;
  // "Who …?" has two answers and stays ambiguous.
  const reviewed = await ask('Are access logs reviewed?');
  assert.deepEqual(texts(reviewed), ['Yes', 'Yes']);
  const reviewers = await ask('Who reviews access logs?');
  assert.equal(reviewers.status, 'ambiguous');
  // Provenance: the statements written for the tour record their author.
  assert.deepEqual(
    chain.provenance.statements.map(({ kind = 'statement', author, via }) => [kind, author, via]),
    [
      ['statement', 'Claude', 'library'],
      ['statement', 'Claude', 'library'],
      ['case', 'Dana', 'cli'],
    ],
    'Two statements written through the library, and the case of the check',
  );
  assert.equal(asked.provenance.statements[0].author, 'unrecorded', 'Written before recording');

  // Recoil: down, up and sideways.
  const down = await json(
    'recoil',
    '--question',
    'Who notifies the customers?',
    '--case-text',
    'A certificate expires.',
  );
  assert.deepEqual(
    down.down.filter((row) => row.kind === 'statement').map((row) => row.label),
    [
      'If Priya renews the certificate, Sam, the support lead, notifies the customers.',
      'If a certificate expires, Priya, the security engineer, renews the certificate.',
    ],
  );
  assert(down.down.some((row) => row.kind === 'case'));
  assert.deepEqual(
    down.sideways.map((row) => row.label),
    ['Who renews the certificate? / Case: A certificate expires.'],
  );
  const up = await json('recoil', '--statement', 'If a certificate expires');
  assert.deepEqual(
    up.up
      .filter((row) => row.kind === 'question')
      .map((row) => row.label)
      .sort(),
    [
      'Who notifies the customers? / Case: A certificate expires.',
      'Who renews the certificate? / Case: A certificate expires.',
    ],
  );
  assert.deepEqual(up.frontier, [], 'Every check is current: nothing beyond the walk');
  // Corpus fidelity: every statement asked back, every question classed.
  const fidelity = await json('fidelity');
  assert.deepEqual(
    [fidelity.totals.variables, fidelity.totals.answerable, fidelity.totals.settled],
    [85, 81, 24],
  );
  assert.equal(fidelity.questions.composedAcrossRoles, 2);
  // Tension lines: resolved, gathered and open.
  const tensions = await json('tensions');
  assert.deepEqual(
    tensions.lines.map((line) => [
      line.between.toSorted(),
      line.resolved,
      line.gathered,
      line.open,
    ]),
    [
      [
        ['On-call Engineer', 'Security Engineer'],
        [],
        ['Are access logs reviewed?'],
        ['Who reviews access logs?'],
      ],
      [['Security Engineer', 'Support Lead'], ['Who notifies the customers?'], [], []],
    ],
  );
  // Probes: each statement of a role asked back from its own reading.
  const probes = await json('probe', '--role', 'Security Engineer');
  assert(probes.statements.length >= 4);
  assert(
    probes.statements.every((item) => item.probes.every((probe) => probe.outcome === 'recovered')),
    JSON.stringify(probes.counts),
  );

  // The workbench shows the same, where a person looks.
  ui = journeyWorkbench(await openProject(project), directory);
  await ui.app.idle();
  const item = ui.state.workflow
    .developmentItems()
    .find(
      (entry) =>
        entry.question === 'Who notifies the customers?' &&
        entry.caseSelection?.sources?.[0]?.text === 'A certificate expires.',
    );
  await ui.state.workflow.openDevelopment(item.id);
  await ui.app.idle();
  const headings = (view) =>
    view.sections.flatMap((section) => (section.groups ?? []).map((group) => group.heading));
  const question = ui.state.workflow.readingView();
  for (const heading of [
    'What the answer rests on',
    'Other questions resting on the same statements',
    'Juxtaposition: what it brings together',
  ])
    assert(headings(question).includes(heading), heading);
  const together = question.sections[0].groups.find(
    (group) => group.heading === 'Juxtaposition: what it brings together',
  );
  assert.deepEqual(together.rows, [
    ['Support Lead ↔ Security Engineer', 'resolved: one answer composes both'],
  ]);
  // A statement the answer rests on: what rests on it, asked back, who wrote it.
  await ui.selectReading(
    'If a certificate expires, Priya, the security engineer, renews the certificate.',
  );
  await ui.key('ENTER');
  await ui.app.idle();
  const statement = ui.state.workflow.readingView();
  for (const heading of ['What rests on it', 'Asked back from its reading', 'Written by'])
    assert(headings(statement).includes(heading), heading);
  const writer = statement.sections[0].groups.find((group) => group.heading === 'Written by');
  assert.deepEqual(writer.rows.slice(0, 2), [
    ['Author', 'Claude'],
    ['Through', 'library'],
  ]);
  // The root role: juxtaposition between its branches, and corpus fidelity.
  ui.app.dispose();
  ui = journeyWorkbench(await openProject(project), directory);
  await ui.app.idle();
  const root = ui.state.project.data.placements.find((placement) => !placement.parentId).id;
  ui.state.workflow.select(root, 'reading');
  ui.state.workflow.sync();
  await ui.app.idle();
  const rootView = ui.state.workflow.readingView();
  for (const heading of ['Juxtaposition: tension lines', 'Corpus fidelity'])
    assert(headings(rootView).includes(heading), heading);
  const fidelityGroup = rootView.sections
    .flatMap((section) => section.groups ?? [])
    .find((group) => group.heading === 'Corpus fidelity');
  assert.match(fidelityGroup.rows[0][1], /85 variables of 25 statements; answerable 81 \(95%\)/u);
  assert.equal(fidelityGroup.table.entries.length, 6, 'one row a top-level role');
  console.log(
    `ok demo tour: every capability replays offline in the CLI and the workbench (${directory})`,
  );
} finally {
  ui?.app.dispose();
  await rm(directory, { recursive: true, force: true });
}
