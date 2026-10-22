/** Keyboard-only outcomes. A visible row, its Enter action and its back path agree. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createProject,
  openProject,
  saveProject,
} from '../../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../../src/project/storage/acquisitions.mjs';
import { sourceCatalog } from '../../../src/project/authoring/sources.mjs';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { saveEngineRun, acquireEngineRunLease } from '../../../src/project/storage/engine-runs.mjs';
import { captureProjectInquiry } from '../../../src/project/inquiries/inquiry.mjs';
import {
  journeyWorkbench,
  authorHierarchy,
  capturedParser,
} from '../../support/journey-workbench.mjs';
import { questionStatusFixture } from '../../support/question-status-fixtures.mjs';
import { theatre, theatreQuestions } from '../../../tools/harbour-theatre.mjs';
import {
  keyboardContracts,
  reviewedTransition,
} from '../../../tools/support/keyboard-workflow-contract.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/keyboard-workflow-'));
const fixture = JSON.parse(
  await readFile(new URL('../../support/theatre-acquisitions.json', import.meta.url)),
);
const embeddings = JSON.parse(
  await readFile(new URL('../../support/theatre-embeddings.json', import.meta.url)),
);
const oldFetch = globalThis.fetch;
globalThis.fetch = capturedParser(fixture.entries, [], embeddings);
const matrix = [];
const stateFrames = [];
const stateFrame = async (name, actions, expect, limit) => {
  const width = ui.term.width;
  const height = ui.term.height;
  for (const columns of [180, 80]) {
    ui.term.width = columns;
    ui.term.height = columns === 80 ? 24 : 54;
    ui.term.emit('resize');
    await new Promise((done) => setImmediate(done));
    if (name.includes('-candidate-')) {
      assert(
        ui.state.viewport.choiceHits.some(
          (hit) => hit.index === ui.state.workflow.readingView().activeChoice,
        ),
        'Candidate source selection remains visible after resize',
      );
    }
    const plain = stripVTControlCharacters(ui.term.frame);
    for (const text of expect) assert(plain.includes(text), `${name}: ${text}`);
    const id = `${name}-${columns}`;
    const ansi = join(directory, id + '.ansi');
    await writeFile(ansi, ui.term.frame);
    stateFrames.push({
      name: id,
      ansi,
      width: columns,
      height: ui.term.height,
      actions,
      expect,
      limit,
      test: 'test/tui/inquiries/keyboard-workflow.mjs',
    });
  }
  ui.term.width = width;
  ui.term.height = height;
  ui.term.emit('resize');
};
let ui;
const leases = [];
const currentQuestion = () => ui.state.workflow.current()?.input.question.text;
const record = (id, outcome, options) =>
  matrix.push(reviewedTransition(id, 'test/tui/inquiries/keyboard-workflow.mjs', outcome, options));
const focus = async (pane) => {
  for (let i = 0; i < 4 && ui.state.focus !== pane; i++) await ui.key('TAB');
  assert.equal(ui.state.focus, pane);
};
const allRows = (section) => [
  ...(section.rowChoices ?? []),
  ...(section.table?.entries ?? []),
  ...(section.groups ?? []).flatMap(allRows),
];
const selectable = () =>
  ui.state.workflow
    .readingView()
    .sections.flatMap(allRows)
    .filter((row) => row.choiceIndex !== undefined);
const selectRow = async (predicate) => {
  await focus('reading');
  const rows = selectable();
  const at = rows.findIndex(predicate);
  assert(at >= 0, 'A keyboard-selectable row exists for this action');
  await ui.key('HOME');
  for (let i = 0; i < at; i++) await ui.key('DOWN');
  assert.equal(
    ui.state.workflow.readingView().activeChoice,
    rows[at].choiceIndex,
    'The row reached with keys is the row Enter will activate',
  );
  return rows[at];
};
const questionIs = (text) => assert.equal(currentQuestion(), text);
const readText = (text) =>
  assert.match(
    stripVTControlCharacters(ui.term.frame),
    new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
  );

try {
  const path = join(directory, 'theatre');
  ui = journeyWorkbench(await createProject(path, theatre.name, theatre.role), directory);
  await ui.app.idle();
  ui.term.on('mouse', () => assert.fail('Keyboard audit must never synthesize mouse input'));

  await ui.key('c');
  await ui.text('Discarded');
  await ui.key('ESCAPE');
  assert.equal(ui.state.workflow.roles().length, 1);
  record('roles.add-cancel', 'No role was created by cancelling the form.');
  await ui.key('c');
  await ui.text('Temporary branch');
  await ui.submit('ENTER');
  const child = ui.state.placementId;
  assert.equal(ui.state.workflow.role().label, 'Temporary branch');
  await ui.key('CTRL_Z');
  assert(!ui.state.workflow.roles().some((r) => r.id === child));
  await ui.key('CTRL_Y');
  assert(ui.state.workflow.roles().some((r) => r.id === child));
  record('roles.add', 'The named child is persisted; undo removes it and redo restores it.');
  await ui.selectRole('Temporary branch');
  await ui.key('ENTER');
  await ui.key('ALT_U');
  await ui.text('Renamed branch');
  await ui.submit();
  readText('Renamed branch');
  await ui.key('CTRL_Z');
  assert.equal(ui.state.workflow.role().label, 'Temporary branch');
  await ui.key('CTRL_Y');
  assert.equal(ui.state.workflow.role().label, 'Renamed branch');
  record('roles.rename', 'Saved, undone and restored names agree in the role tree.');
  record('roles.undo-redo', 'Undo and redo preserve role identity and reverse only the edit.');
  await ui.key('m');
  assert(ui.state.form.move.length > 0);
  await ui.choose((item) => item.id === null || item.label === 'Top level');
  assert.equal(ui.state.workflow.role().parentId, null);
  await ui.key('CTRL_Z');
  assert.equal(ui.state.workflow.role().parentId, ui.state.workflow.roles()[0].id);
  record('roles.move', 'Moving a child to the top level and undoing restores its parent.');
  await ui.key('x');
  assert.equal(ui.state.form.yesNo.yes, false);
  await ui.key('ENTER');
  assert(ui.state.workflow.roles().some((r) => r.id === child));
  record('roles.remove-cancel', 'The default No leaves the role and its identity intact.');
  await ui.key('x');
  await ui.key('LEFT');
  await ui.key('ENTER');
  assert(!ui.state.workflow.roles().some((r) => r.id === child));
  await ui.key('CTRL_Z');
  assert(ui.state.workflow.roles().some((r) => r.id === child));
  await ui.key('CTRL_Y');
  assert(!ui.state.workflow.roles().some((r) => r.id === child));
  record('roles.remove', 'Explicit confirmation deletes; undo restores and redo removes.');

  await authorHierarchy(ui, theatre);
  assert.equal(sourceCatalog(ui.state.project.data).length, 19);
  record('sources.add', 'Nineteen frozen source statements are authored through source forms.');
  await ui.selectRole('Rigging');
  await ui.key('LEFT');
  assert.equal(ui.state.workflow.role().label, 'Technical production');
  record('roles.parent', 'Left follows the actual parent relationship.');
  await ui.key('RIGHT');
  assert.equal(ui.state.workflow.role().label, 'Rigging');
  record('roles.child', 'Right follows the first actual child and returns to Rigging.');
  await ui.key('HOME');
  assert.equal(ui.state.workflow.role().label, 'Production');
  await ui.key('END');
  assert.equal(ui.state.workflow.role().label, 'Front of house');
  await ui.key('UP');
  assert.equal(ui.state.workflow.role().label, 'Costumes');
  await ui.key('DOWN');
  assert.equal(ui.state.workflow.role().label, 'Front of house');
  record('roles.select', 'All movement keys select visible authored roles.');
  await ui.selectRole('Workshop');
  const source = sourceCatalog(ui.state.project.data).find(
    (s) => s.text === 'Sam repairs bicycles.',
  );
  const originalSourceRow = await selectRow((row) => row.source?.text === source.text);
  await ui.key('ENTER');
  readText('Check the language reading');
  readText(source.text);
  assert.equal(ui.state.form, null, 'Reading opens directly, not through another picker');
  assert.doesNotMatch(
    ui.term.frame,
    /\/ repair-01/u,
    'Raw graph is not the default language surface',
  );
  await ui.key('g');
  assert.match(ui.term.frame, /\/ repair-01/u);
  await ui.key('g');
  assert.doesNotMatch(ui.term.frame, /\/ repair-01/u);
  record(
    'reading.graph',
    'Raw retained AMR is available and toggles back to the relationship table.',
  );
  record('sources.read', 'Enter opens the source that is selected by keyboard.');
  await ui.key('e');
  assert.equal(ui.state.workflow.role().label, 'Workshop');
  assert.equal(
    ui.state.form.fields[ui.state.form.index].value,
    theatre.children.find((node) => node.role === 'Workshop').statements.join('\n'),
    'Review focuses the authored paragraph containing this source, with its other sentences intact',
  );
  const digest = ui.state.project.digest;
  await ui.key('ALT_U');
  await ui.text('An unsaved replacement.');
  await ui.key('ESCAPE');
  assert.equal(ui.state.project.digest, digest);
  readText('Check the language reading');
  record(
    'sources.revise',
    'The selected source field opens and cancellation returns to its reading.',
  );
  record('sources.cancel', 'Discarded wording changes neither saved material nor project digest.');
  await ui.key('ESCAPE');
  assert.equal(
    ui.state.workflow.readingView().activeChoice,
    originalSourceRow.choiceIndex,
    'Back from a reading restores its keyboard row',
  );

  await ui.selectRole('Production');
  await ui.key('a');
  await ui.text(theatreQuestions[0]);
  await ui.key('ESCAPE');
  assert(ui.state.workflow.developmentItems().some((q) => q.question === theatreQuestions[0]));
  record('draft.save', 'Leaving Ask retains the exact question as a draft.');
  await ui.key('a');
  assert.equal(
    ui.state.form.fields[0].value,
    '',
    'Ask starts empty; typing never appends to a saved draft',
  );
  await ui.key('ESCAPE');
  await ui.key('o');
  await ui.choose(theatreQuestions[0]);
  assert.equal(ui.state.form.fields[0].value, theatreQuestions[0]);
  record('draft.resume', 'Development resumes the same unsent question.');
  await ui.key('ALT_S');
  await ui.choose((item) => item.label.endsWith('Technical production'));
  assert.equal(ui.state.workflow.role().label, 'Technical production');
  await ui.key('ALT_S');
  await ui.choose('Production');
  assert.equal(ui.state.workflow.role().label, 'Production');
  record('ask.scope', 'Scope changes and returns without changing the question text.');
  await ui.key('ALT_C');
  await ui.choose((item) => item.label.endsWith('Workshop'));
  assert(ui.state.form.caseSelection);
  await ui.key('ALT_C');
  await ui.choose('No case');
  assert.equal(ui.state.form.caseSelection, null);
  record('ask.case', 'A separately selected case can be removed without changing corpus scope.');
  await ui.submit('ENTER');
  assert.equal(ui.state.workflow.current().run.answer.answers[0].text, 'technician');
  record('ask.run', 'The source chain proves technician with an attributed answer.');

  const question = theatreQuestions[0];
  const originalBranchRow = await selectRow(
    (row) => row.placementId && row.cells.includes('Technical production'),
  );
  readText('Technical production');
  await ui.key('ENTER');
  assert.equal(ui.state.workflow.role().label, 'Technical production');
  questionIs(question);
  await ui.key('ESCAPE');
  assert.equal(ui.state.workflow.role().label, 'Production');
  questionIs(question);
  assert.equal(
    ui.state.workflow.readingView().activeChoice,
    originalBranchRow.choiceIndex,
    'Back from a role restores the selected branch',
  );
  record(
    'question.branch',
    'Enter follows only the selected branch; Escape returns to its parent view.',
  );
  const proofSourceRow = await selectRow((row) =>
    row.source?.text.includes('approves the rehearsal'),
  );
  const selectedText = selectable().find((row) =>
    row.source?.text.includes('approves the rehearsal'),
  ).source.text;
  await ui.key('ENTER');
  readText(selectedText);
  readText('Check the language reading');
  await ui.key('ESCAPE');
  assert.equal(ui.state.workflow.role().label, 'Production');
  questionIs(question);
  assert.equal(
    ui.state.workflow.readingView().activeChoice,
    proofSourceRow.choiceIndex,
    'Back from proof review restores that source row',
  );
  record(
    'question.source',
    'The selected proof source opens directly; Escape preserves the question and role.',
  );
  record('question.back', 'A reading round trip does not navigate to another role or question.');
  await ui.key('r');
  await ui.state.workflow.idle();
  await ui.app.idle();
  assert.equal(ui.state.workflow.current().run.answer.answers[0].text, 'technician');
  record('question.recheck', 'A fresh deterministic check retains the same attributed answer.');
  await ui.ask(theatreQuestions[3]);
  assert.equal(ui.state.workflow.current().run.status, 'open');
  readText('Why no answer');
  record(
    'question.open',
    'The unsupported curtain question stays open and shows its unmet requirements.',
    { limit: 'Explaining missing proof does not create the absent source connection.' },
  );
  const openGap = await selectRow((row) => row.openings?.length);
  // Selection presents the gap: statements it records show under the row.
  assert.equal(ui.state.workflow.readingView().title, 'Develop question');
  assert.equal(ui.term.frame.includes('↳ '), Boolean(openGap.preview.length));
  await ui.key('i');
  assert.equal(ui.state.workflow.readingView().title, 'Language reading');
  await ui.key('ESCAPE');
  assert.equal(ui.state.workflow.readingView().activeChoice, openGap.choiceIndex);
  record(
    'question.gap',
    'A selected gap shows its related statements in place; its reading opens with i and Escape returns to the same row.',
    {
      limit: 'A gap with no proposal remains unresolved; inspection does not supply new evidence.',
    },
  );
  await ui.key('i');
  assert.equal(
    ui.state.form,
    null,
    'Reading inspection must not open an undifferentiated text picker',
  );
  readText('Check the language reading');
  readText(theatreQuestions[3]);
  record(
    'question.read',
    'The current question reading opens directly, without unrelated source choices.',
    {
      limit:
        'Reading review can expose an acquisition mismatch; it does not prove absent semantics.',
    },
  );
  await ui.key('e');
  assert.equal(ui.state.form.fields[0].value, theatreQuestions[3]);
  assert.equal(ui.state.workflow.role().label, 'Production');
  await ui.key('ESCAPE');
  readText('Check the language reading');
  await ui.key('ESCAPE');
  questionIs(theatreQuestions[3]);
  record(
    'reading.revise-question',
    'Revise opens the original wording and scope; cancelling preserves both.',
  );
  await ui.key('o');
  await ui.choose(question);
  questionIs(question);
  await ui.key('o');
  await ui.choose(theatreQuestions[3]);
  questionIs(theatreQuestions[3]);
  record(
    'development.switch',
    'Switching questions changes the displayed check without losing either question.',
  );

  await ui.selectRole('Workshop');
  await ui.ask(theatreQuestions[4]);
  await ui.key('d');
  await ui.key('ESCAPE');
  assert.equal(ui.state.workflow.current().run.status, 'open');
  record(
    'clarify.cancel',
    'Cancellation does not retain a proposed correspondence or establish an answer.',
  );
  await ui.key('d');
  await ui.choose((item) => item.candidate?.answerLabel === 'Sam');
  await ui.state.workflow.idle();
  assert.equal(ui.state.workflow.current().run.answer.answers[0].text, 'Sam');
  record(
    'clarify.confirm',
    'Confirming Sam creates an attributed answer and a retained corpus connection.',
  );
  await ui.ask(theatreQuestions[5]);
  assert.equal(ui.state.workflow.current().run.answer.answers[0].text, 'Yes');
  const connection = ui.state.project.data.contributions.find((contribution) =>
    contribution.wordings.some((wording) => wording.kind === 'clarification' && !wording.withdrawn),
  );
  const transferred = ui.state.workflow.current().run.answer.answers[0];
  assert(connection && transferred.ruleIds.some((id) => id.includes(connection.id)));
  assert(
    transferred.sourceIds.length && transferred.derivation.tree,
    'Transfer is attributed and backed by an actual chart proof',
  );
  record('clarify.transfer', 'A distinct polar question reuses the confirmed connection.');
  await ui.key('u');
  await ui.key('ENTER');
  assert.equal(ui.state.form.yesNo.yes, false);
  await ui.key('ENTER');
  assert.equal(
    ui.state.form.title,
    'Confirmed connections',
    'Declining returns to the connections list',
  );
  await ui.key('ESCAPE');
  assert.equal(ui.state.form, null);
  assert.equal(ui.state.workflow.current().run.answer.answers[0].text, 'Yes');
  record('withdraw.cancel', 'Default No preserves the connection and its dependent answer.');
  await ui.key('u');
  await ui.key('ENTER');
  await ui.key('LEFT');
  await ui.submit('ENTER');
  await ui.state.workflow.idle();
  assert.equal(ui.state.workflow.current().run.status, 'open');
  await ui.ask(theatreQuestions[6]);
  assert.equal(ui.state.workflow.current().run.answer.answers[0].text, 'Yes');
  record(
    'withdraw.confirm',
    'Withdrawal reopens the dependent question while direct lexical support remains.',
  );

  await ui.selectRole('Workshop');
  await ui.key('?');
  assert(ui.state.help);
  await writeFile(join(directory, 'help-frame.txt'), ui.term.frame);
  assert.equal((ui.term.frame.match(/enter[^\n]*edit role/gu) ?? []).length, 1);
  assert(!ui.term.frame.includes('ENTER edit role'));
  assert.equal((ui.term.frame.match(/esc[^\n]*close question/gu) ?? []).length, 1);
  assert(!ui.term.frame.includes('ESCAPE close question'));
  await ui.key('ESCAPE');
  assert.equal(ui.state.focus, 'nodes');
  record('help', 'Help is scoped to the current pane and Escape restores its focus.');
  await ui.key('w');
  assert.equal(ui.state.mode, 'home');
  await ui.key('ESCAPE');
  assert.equal(ui.state.mode, 'project');
  assert.equal(ui.state.workflow.role().label, 'Workshop');
  record('projects', 'Project home returns to the same project and selected role.');
  await focus('reading');
  await ui.key('f');
  assert(ui.state.expandReading);
  await ui.key('f');
  assert(!ui.state.expandReading);
  record('expand', 'Expanded reading returns to split panes without changing the work.');
  const resizeSource = await selectRow((row) => row.source?.kind === 'source');
  const resizeText = resizeSource.source.text;
  for (const [width, height] of [
    [80, 24],
    [60, 20],
    [120, 38],
    [180, 54],
  ]) {
    ui.term.width = width;
    ui.term.height = height;
    ui.term.emit('resize', width, height);
    await ui.app.idle();
    assert.equal(ui.state.workflow.readingView().activeChoice, resizeSource.choiceIndex);
    assert(
      ui.state.viewport.choiceHits.some((hit) => hit.index === resizeSource.choiceIndex),
      `Resize alone keeps the selected source visible at ${width} columns`,
    );
    await ui.key('ENTER');
    assert.equal(ui.state.workflow.readingView().title, 'Language reading');
    assert(JSON.stringify(ui.state.workflow.readingView().sections).includes(resizeText));
    await ui.key('ESCAPE');
    assert.equal(ui.state.workflow.readingView().activeChoice, resizeSource.choiceIndex);
    await ui.key('HOME');
    assert.equal(ui.state.offset, 0, 'Home restores the question and answer overview');
    assert.match(ui.term.frame, /Question:/u);
    assert.match(ui.term.frame, /Answer:/u);
    await ui.key('ENTER');
    assert.equal(ui.state.workflow.readingView().title, 'Language reading');
    assert(JSON.stringify(ui.state.workflow.readingView().sections).includes(theatreQuestions[6]));
    await ui.key('ESCAPE');
    await selectRow((row) => row.source?.text === resizeText);
  }
  record(
    'navigation.resize-selection',
    'Resize preserves the visible selected source; Enter reads that same text and Escape restores it.',
  );
  for (const [width, height] of [
    [180, 54],
    [120, 38],
    [80, 24],
    [60, 20],
  ]) {
    ui.term.width = width;
    ui.term.height = height;
    ui.term.emit('resize', width, height);
    await ui.app.idle();
    const reached = new Set();
    for (let i = 0; i < 3; i++) {
      await ui.key('TAB');
      reached.add(ui.state.focus);
      assert.match(ui.term.frame, /› (Roles|Development|Develop question)/u);
    }
    assert.equal(reached.size, 3);
    const before = ui.state.focus;
    await ui.key('SHIFT_TAB');
    await ui.key('TAB');
    assert.equal(ui.state.focus, before);
    await focus('reading');
    for (const key of ['HOME', 'PAGE_DOWN', 'PAGE_UP', 'END', 'HOME']) {
      await ui.key(key);
      const active = ui.state.workflow.readingView().activeChoice;
      assert(
        ui.state.viewport.choiceHits.some((hit) => hit.index === active),
        `${key}: the reading row stays visible at ${width} columns`,
      );
    }
    await focus('nodes');
    if (width === 80) {
      readText('↑↓ select role');
      readText('enter edit role');
      readText('? more actions');
    }
    for (const key of ['HOME', 'PAGE_DOWN', 'PAGE_UP', 'END']) {
      await ui.key(key);
      assert(
        ui.state.viewport.nodeHits.some((hit) => hit.id === ui.state.placementId),
        `${key}: the role stays visible at ${width} columns`,
      );
    }
    await focus('development');
    for (const key of ['HOME', 'PAGE_DOWN', 'PAGE_UP', 'END']) {
      await ui.key(key);
      assert(
        ui.state.viewport.developmentHits.some((hit) => hit.id === ui.state.projectEntryId),
        `${key}: the question stays visible at ${width} columns`,
      );
    }
  }
  record(
    'navigation.page',
    'Page and boundary keys keep the activated row visible in all panes at every tested width.',
  );
  record(
    'focus',
    'All three panes remain keyboard reachable from 60 to 180 columns with visible focus.',
  );
  await ui.key('q');
  assert.equal(ui.state.quitPrompt.yes, false);
  await ui.key('ENTER');
  assert.equal(ui.state.quitPrompt, null);
  record('quit.cancel', 'Quit defaults to No and returns without terminating the editor.');
  ui.app.dispose();
  ui = journeyWorkbench(await openProject(path), directory);
  await ui.key('o');
  await ui.choose(theatreQuestions[5]);
  await ui.state.workflow.idle();
  assert.equal(ui.state.workflow.current().run.status, 'open');
  await ui.key('o');
  await ui.choose(theatreQuestions[6]);
  assert.equal(ui.state.workflow.current().run.answer.answers[0].text, 'Yes');
  record('reload', 'Cold reopen retains withdrawal while independent support remains usable.');
  const supported = structuredClone(ui.state.workflow.current().run);
  leases.push(await acquireEngineRunLease(ui.state.project, supported.id));
  ui.app.dispose();
  ui = journeyWorkbench(await openProject(path), directory, { noColor: false });
  // These are presentation fixtures over the real retained question, not new
  // engine claims. Each status must suppress the prior successful answer.
  for (const [status, message] of [['limited', 'The search reached its limit']]) {
    const run = {
      ...supported,
      id: randomUUID(),
      status,
      answer: {
        ...supported.answer,
        answers: [],
        openings: [],
        partial: { parts: [] },
        complete: status !== 'limited',
      },
    };
    await saveEngineRun(ui.state.project, run);
    await ui.state.workflow.show(run.id);
    await ui.app.idle();
    readText(message);
    assert.doesNotMatch(stripVTControlCharacters(ui.term.frame), /Answer: Yes/u);
    await stateFrame(
      status,
      ['show retained status fixture'],
      [message],
      'Injected result status over a real question; renderer/controller only, not a new inference outcome.',
    );
    const statusGap = await selectRow((row) => row.openings);
    assert.equal(
      ui.term.frame.includes('↳ '),
      Boolean(statusGap.preview.length),
      'The selected gap previews only the statements it records',
    );
    assert.equal(ui.state.workflow.readingView().title, 'Develop question');
    assert.equal(ui.state.workflow.current().run.status, status);
    await stateFrame(
      status + '-gap',
      ['Select gap'],
      ['Develop question'],
      'A selected gap previews in place in an injected result-status fixture.',
    );
    record(
      'question.' + status,
      `The ${status} presentation keeps the question and discloses uncertainty without the prior answer.`,
      {
        limit: 'UI status fixture only; the reasoner outcome is verified by separate engine tests.',
      },
    );
  }
  ui.app.dispose();
  for (const status of ['ambiguous', 'conflict']) {
    const fixture = await questionStatusFixture(directory, status);
    leases.push(await acquireEngineRunLease(fixture.project, fixture.run.id));
    ui = journeyWorkbench(fixture.project, directory, { noColor: false });
    await ui.state.workflow.show(fixture.run.id);
    await ui.app.idle();
    const heading = status === 'ambiguous' ? 'Possible answer' : 'Conflicting answer';
    const outcome =
      status === 'ambiguous' ? 'Several answers remain possible.' : 'Sources disagree.';
    readText(heading);
    assert.equal(ui.state.workflow.current().run.answer.answers.length, 0);
    for (const candidate of fixture.run.answer.candidates) readText('Candidate: ' + candidate.text);
    assert(
      !JSON.stringify(ui.state.workflow.readingView().sections).includes('Related connections'),
      'Attributed complete alternatives do not repeat provisional query matches below them',
    );
    for (const source of fixture.sources)
      assert.equal(
        selectable().filter((row) => row.source?.text === source).length,
        1,
        'Each attributed candidate source is offered once, not repeated in local context',
      );
    await writeFile(
      join(directory, status + '-run.json'),
      JSON.stringify(fixture.run, null, 2) + '\n',
    );
    await stateFrame(
      status,
      ['show actual retained engine result'],
      [outcome],
      'Actual model-free runEngine outcome over declared symbolic source readings; alternatives have attributed chart proofs. Acquisition accuracy is not asserted.',
    );
    for (const source of fixture.sources) {
      await selectRow((row) => row.source?.text === source);
      await stateFrame(
        status + '-candidate-' + fixture.sources.indexOf(source),
        ['select attributed candidate source with arrows'],
        [heading],
        'Actual unresolved candidate and its exact attributed source, selected for keyboard inspection.',
      );
      await ui.key('ENTER');
      assert.equal(ui.state.workflow.readingView().title, 'Language reading');
      assert.equal(ui.state.workflow.readingView().sections[0].rows[0][1], source);
      await stateFrame(
        status + '-source-' + fixture.sources.indexOf(source),
        ['select exact candidate source with arrows', 'Enter'],
        ['Language reading'],
        'Exact candidate source reading opened through keyboard selection; no candidate becomes an established answer.',
      );
      await ui.key('ESCAPE');
      assert.equal(ui.state.workflow.current().run.status, status);
      assert.equal(ui.state.workflow.current().run.answer.answers.length, 0);
    }
    await ui.key('HOME');
    await stateFrame(
      status + '-back',
      ['Escape from candidate source', 'Home'],
      [outcome],
      'Returns to the same unresolved question, candidates and source attribution after reading inspection.',
    );
    record(
      'question.' + status,
      `An actual ${status} engine outcome shows each attributed alternative, opens its exact source and returns without reporting a resolved answer.`,
      {
        limit:
          'Symbolic fixture readings exercise deterministic reasoning; no model acquisition quality claim.',
      },
    );
    ui.app.dispose();
  }
  let mode = 'pending',
    started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  ui = journeyWorkbench(await openProject(path), directory, {
    noColor: false,
    captureInquiry: (...args) => {
      const [, , , progress, signal] = args;
      if (mode === 'retry') return captureProjectInquiry(...args);
      if (mode === 'failed') return Promise.reject(new Error('Controlled check failure'));
      progress('Checking a retained source branch');
      started();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  });
  await ui.state.workflow.show(supported.id);
  ui.term.emit('key', 'r', [], {});
  await began;
  // Let the real header animation tick while the check stays pending.
  await new Promise((resolve) => setTimeout(resolve, 90));
  readText('Checking a retained source branch');
  assert.doesNotMatch(stripVTControlCharacters(ui.term.frame), /Answer: Yes/u);
  await stateFrame(
    'pending',
    ['r'],
    ['Checking a retained source branch', 'cancel check'],
    'Real controller with a deliberately deferred local check; no model request.',
  );
  await ui.key('ESCAPE');
  assert.equal(ui.state.workflow.activity(), null);
  assert.equal(ui.state.workflow.current(), null);
  await stateFrame(
    'cancelled',
    ['r', 'Escape'],
    ['Roles', 'Development'],
    'Escape aborts the deferred operation and returns to the role; the question remains in Development.',
  );
  assert(
    ui.state.workflow.developmentItems().some((item) => item.question === theatreQuestions[6]),
  );
  record(
    'question.pending',
    'Checking is visible, prior support is hidden, and Escape cancels without deleting Development.',
  );
  mode = 'failed';
  await ui.state.workflow.show(supported.id);
  await ui.key('r');
  readText('Controlled check failure');
  assert.doesNotMatch(stripVTControlCharacters(ui.term.frame), /Answer: Yes/u);
  await stateFrame(
    'failure',
    ['r'],
    ['Controlled check failure', 'retry check'],
    'Controlled service rejection through the real controller; prior answer suppressed.',
  );
  assert(
    ui.state.workflow
      .actions()
      .some((action) => action.key === 'r' && action.description === 'retry check'),
  );
  await ui.key('ESCAPE');
  assert.equal(ui.state.workflow.current(), null, 'A failed check can be closed');
  await stateFrame(
    'failure-back',
    ['Escape'],
    ['Roles', 'Development'],
    'Closing an error preserves the question in Development.',
  );
  assert(
    ui.state.workflow.developmentItems().some((item) => item.question === theatreQuestions[6]),
  );
  await ui.state.workflow.show(supported.id);
  mode = 'retry';
  await ui.key('r');
  questionIs(theatreQuestions[6]);
  assert.equal(ui.state.workflow.current().run.answer.answers[0].text, 'Yes');
  await stateFrame(
    'retry',
    ['reopen same question', 'r'],
    ['Answer: Yes'],
    'Actual offline captureProjectInquiry retries the retained question and establishes its attributed answer.',
  );
  record(
    'question.failure',
    'Failure hides prior support; retry checks the same question and restores a real attributed answer.',
  );
  ui.app.dispose();
  const legacyPath = join(directory, 'retained-role');
  let legacy = await createProject(legacyPath, 'Retained language', 'Workshop');
  const data = structuredClone(legacy.data);
  data.concepts[0].passages = ['Sam repairs bicycles.', 'An unacquired source sentence.'];
  legacy = await saveProject(legacy, data);
  const savedSource = fixture.entries.find((entry) => entry.text === data.concepts[0].passages[0]);
  await retainAcquisitions(legacy, [
    {
      text: savedSource.text,
      penman: savedSource.acquisition.penman,
      acquisition: savedSource.acquisition,
      origin: { kind: 'retained-fixture' },
    },
  ]);
  assert(
    sourceCatalog(legacy.data).every((source) => !source.graph),
    'This exercises sources whose graph is stored separately from their passage',
  );
  const legacyDigest = legacy.digest;
  globalThis.fetch = async () =>
    assert.fail('Review of retained or missing readings must not request a model');
  ui = journeyWorkbench(legacy, directory);
  await ui.app.idle();
  await selectRow((row) => row.source?.text === savedSource.text);
  await ui.key('i');
  readText('Subject');
  readText('Participant');
  assert.doesNotMatch(ui.term.frame, /Reading: Not acquired/u);
  await ui.key('g');
  assert.match(ui.term.frame, /\/ repair-01/u);
  await ui.key('ESCAPE');
  assert.equal(ui.state.workflow.current(), null, 'Review never manufactures a question');
  assert.equal((await openProject(legacyPath)).digest, legacyDigest);
  record(
    'sources.retained',
    'A separately retained reading is inspectable before asking, without acquisition or source changes.',
  );
  await selectRow((row) => row.source?.text === data.concepts[0].passages[1]);
  await ui.key('i');
  readText('No retained reading for this exact text');
  assert(
    !ui.state.workflow.actions().some((action) => action.key === 'g'),
    'There is no raw graph action when no graph exists',
  );
  await ui.key('ESCAPE');
  assert.equal((await openProject(legacyPath)).digest, legacyDigest);
  record(
    'sources.unread',
    'An absent acquisition is disclosed with no network call and the original source stays intact.',
    { limit: 'A missing reading cannot be examined until normal acquisition occurs.' },
  );
  assert.deepEqual(
    new Set(matrix.map((r) => r.id)),
    new Set(keyboardContracts.map((r) => r.id)),
    'Every declared action earns a result',
  );
  await writeFile(
    join(directory, 'matrix.json'),
    JSON.stringify(
      {
        project: path,
        input: 'Frozen theatre acquisitions and embeddings',
        mouseEvents: 0,
        matrix,
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    join(directory, 'state-frames.json'),
    JSON.stringify(
      {
        provenance:
          'Actual renderer output at asserted controller states. Status fixtures and deferred failures are explicitly disclosed per frame. ANSI decoding is a screenshot export step, not a second interaction test.',
        frames: stateFrames,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`ok ${matrix.length} keyboard transitions: ${join(directory, 'matrix.json')}`);
} finally {
  ui?.app.dispose();
  for (const release of leases) await release();
  globalThis.fetch = oldFetch;
}
