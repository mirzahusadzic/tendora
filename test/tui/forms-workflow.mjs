/** Keyboard recovery never overwrites an unseen project revision or loses its draft. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createProject,
  openProject,
  removeBranch,
  saveProject,
} from '../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import { journeyWorkbench } from '../support/journey-workbench.mjs';
import { createDevelopment } from '../../src/tui/engine/development.mjs';
import { createForms } from '../../src/tui/shell/forms.mjs';
import { createText } from '../../src/tui/shell/text.mjs';
import { formActions } from '../../src/tui/shell/form-actions.mjs';
import { editorLines, editorCursor } from '../../src/tui/shell/layout.mjs';

// Editable statements wrap at words without changing text or cursor offsets.
const measure = (value) => Array.from(value).length;
const sentence = 'Tendora sells services over the internet.';
const wrapped = editorLines(sentence, 16, measure);
assert.deepEqual(
  wrapped.map((line) => line.text),
  ['Tendora sells ', 'services over ', 'the internet.'],
);
assert.equal(wrapped.map((line) => line.text).join(''), sentence);
const field = { value: sentence, cursor: 16 };
assert.equal(editorCursor(field, 'HOME', 16, measure), 14);
assert.equal(editorCursor(field, 'END', 16, measure), 27);
assert.equal(editorCursor(field, 'UP', 16, measure), 2);
assert.equal(editorCursor(field, 'DOWN', 16, measure), 30);
assert.deepEqual(
  editorLines('wide-token\n\nnext', 4, measure).map((line) => line.text),
  ['wide', '-tok', 'en', '', 'next'],
);
const wideMeasure = (value) =>
  Array.from(value).reduce((width, char) => width + (/[^\x00-\x7f]/u.test(char) ? 2 : 1), 0);
const unicode = editorLines('海港 theatre', 6, wideMeasure);
assert.equal(unicode.map((line) => line.text).join(''), '海港 theatre');
assert(unicode.every((line) => wideMeasure(line.text) <= 6));

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/form-recovery-'));
const path = join(directory, 'project');
const fetch = globalThis.fetch;
globalThis.fetch = () => assert.fail('Form recovery must not make model or network requests');
let ui;
try {
  let project = await createProject(path, 'Recovery', 'Workshop');
  const data = structuredClone(project.data);
  data.concepts[0].passages = ['Sam repairs bicycles.'];
  project = await saveProject(project, data);
  const fixtures = JSON.parse(
    await readFile(new URL('../support/theatre-acquisitions.json', import.meta.url)),
  );
  await retainAcquisitions(
    project,
    fixtures.entries.map(({ text, acquisition }) => ({
      text,
      acquisition,
      penman: acquisition.penman,
      origin: { kind: 'frozen-form-test' },
    })),
  );
  ui = journeyWorkbench(project, directory);
  const key = async (key, isCharacter = false) => {
    ui.term.emit('key', key, [], { isCharacter });
    await ui.app.idle();
    assert.equal(ui.state.failure, '');
  };
  const submit = async () => {
    const form = ui.state.form;
    await key('CTRL_S');
    await form.execution;
    await ui.app.idle();
    return form;
  };
  const external = async (edit) => {
    const disk = await openProject(path);
    const next = structuredClone(disk.data);
    edit(next);
    return saveProject(disk, next);
  };
  const hasAction = (key, description) =>
    ui.state.viewport.actionHits.some(
      (hit) => hit.inputKey === key && hit.description === description,
    );

  await key('TAB');
  await key('ENTER');
  assert.match(ui.term.frame, /Language reading/u);
  await key('e');
  assert.equal(ui.state.form.title, 'Edit statements');
  assert.equal(
    ui.state.form.error,
    '',
    'Legacy source review can edit a project without contributions',
  );
  assert.equal(ui.state.form.fields[0].value, 'Sam repairs bicycles.');
  await key('ESCAPE');
  assert.match(ui.term.frame, /Language reading/u);
  await key('ESCAPE');
  await key('SHIFT_TAB');
  ui.term.width = 80;
  ui.term.height = 24;
  await key('ENTER');
  await key('ALT_U');
  await submit();
  assert.match(ui.term.frame, /Role name:/u);
  assert.match(ui.term.frame, /Role name is required/u);
  assert.doesNotMatch(ui.term.frame, /No corpus changes/u);
  await key('My workshop', true);
  const role = ui.state.form;
  const changed = await external((data) => {
    data.concepts[0].name = 'Saved workshop';
    data.concepts[0].description = 'Changed by another editor';
  });
  await submit();
  assert(role.projectChanged);
  assert.match(ui.term.frame, /Role name:/u);
  assert.match(ui.term.frame, /My workshop/u);
  assert(hasAction('ALT_R', 'reload project'));
  assert.equal((await openProject(path)).digest, changed.digest);
  await key('ALT_R');
  assert.equal(ui.state.form, role);
  assert.equal(role.fields[0].value, 'My workshop', 'Reload keeps the editable draft');
  assert(role.contextRows.some(([, value]) => value === 'Saved workshop'));
  assert.equal((await openProject(path)).digest, changed.digest, 'Reload never saves the draft');
  await submit();
  assert.equal(ui.state.form, null);
  ui.term.width = 180;
  ui.term.height = 54;
  assert.equal((await openProject(path)).data.concepts[0].name, 'My workshop');
  assert.equal(
    (await openProject(path)).data.concepts[0].description,
    'Changed by another editor',
    'Unedited metadata fields retain the newly loaded saved value',
  );

  // Unrelated project edits can be safely rebased without changing source identity.
  await key('e');
  const source = ui.state.form;
  await key('ALT_U');
  await key('The technician inspects the rig.', true);
  await external((data) => {
    data.concepts[0].description = 'Another independent change';
  });
  await submit();
  assert(source.projectChanged);
  await key('ALT_R');
  assert.equal(source.readOnly, undefined);
  assert.equal(source.fields[0].value, 'The technician inspects the rig.');
  await submit();
  assert.equal(ui.state.form, null);
  assert.equal(
    (await openProject(path)).data.concepts[0].description,
    'Another independent change',
  );

  // A simultaneous edit of the same source is displayed, not silently overwritten.
  await key('e');
  const conflict = ui.state.form;
  await key('ALT_U');
  await key('Sam repairs bicycles.', true);
  const theirs = await external((data) => {
    data.concepts[0].passages = ['The director coordinates the rehearsal.'];
    delete data.concepts[0].sourceRecords;
  });
  await submit();
  assert(conflict.projectChanged);
  ui.term.width = 80;
  ui.term.height = 24;
  ui.state.offset = 40;
  await key('ALT_R');
  assert(conflict.readOnly);
  assert.equal(conflict.title, 'Unsaved statement draft');
  assert.equal(
    ui.state.offset,
    0,
    'Conflict review starts with the complete problem and saved text',
  );
  assert.match(ui.term.frame, /saved statements changed/u);
  assert.equal(conflict.fields[0].value, 'Sam repairs bicycles.');
  assert(
    conflict.contextRows.some(([, text]) => text === 'The director coordinates the rehearsal.'),
  );
  assert(hasAction('ALT_E', 'edit current statements'));
  await key('ALT_U');
  await key('Incorrect text', true);
  await key('CTRL_S');
  assert.equal(conflict.fields[0].value, 'Sam repairs bicycles.');
  assert.equal((await openProject(path)).digest, theirs.digest);
  await key('ALT_E');
  assert.notEqual(ui.state.form, conflict);
  assert.equal(ui.state.form.fields[0].value, 'The director coordinates the rehearsal.');
  await key('ESCAPE');
  assert.equal(ui.state.form, conflict, 'Current source inspection returns to the retained draft');
  await key('ESCAPE');
  assert.equal(ui.state.form, null);
  ui.term.width = 180;
  ui.term.height = 54;

  // Leaving a conflicted form still exposes a reload path in the editor.
  while (ui.state.focus !== 'nodes') await key('TAB');
  await key('ENTER');
  await key('ALT_U');
  await key('Cancelled name', true);
  const latest = await external((data) => {
    data.concepts[0].name = 'Final saved name';
  });
  await submit();
  await key('ESCAPE');
  assert(hasAction('CTRL_R', 'reload project'));
  await key('CTRL_R');
  assert.equal(ui.state.project.digest, latest.digest);
  assert.equal(ui.state.workflow.role().label, 'Final saved name');
  assert(!ui.state.reloadNeeded.has(ui.state.project.path));

  await key('a');
  await key('Who repairs bicycles?', true);
  const ask = ui.state.form;
  await external((data) => {
    data.concepts[0].description = 'Most recent description';
  });
  await key('ENTER');
  assert(ask.projectChanged);
  assert(hasAction('ALT_R', 'reload project'));
  await key('ALT_R');
  assert.equal(ui.state.form, ask);
  assert.equal(ask.fields[0].value, 'Who repairs bicycles?');
  assert.equal(ui.state.project.data.concepts[0].description, 'Most recent description');
  await key('ESCAPE');
  assert.equal(ui.state.form, null);

  while (ui.state.focus !== 'nodes') await key('TAB');
  await key('c');
  await key('Temporary role', true);
  await submit();
  const removedPlacement = ui.state.placementId;
  await key('ENTER');
  await key('ALT_U');
  await key('My removed draft', true);
  const removedRole = ui.state.form;
  const withoutRole = await external((data) => {
    Object.assign(data, removeBranch(data, removedPlacement).data);
  });
  await submit();
  assert(removedRole.projectChanged);
  ui.term.width = 80;
  ui.term.height = 24;
  ui.state.offset = 40;
  await key('ALT_R');
  assert(removedRole.readOnly);
  assert.equal(removedRole.title, 'Unsaved role draft');
  assert.equal(ui.state.offset, 0);
  assert.match(ui.term.frame, /This role was removed/u);
  assert.match(ui.term.frame, /My removed draft/u);
  assert(!hasAction('CTRL_S', 'save role'));
  await key('ALT_U');
  await key('Incorrect replacement', true);
  await key('CTRL_S');
  assert.equal(removedRole.fields[0].value, 'My removed draft');
  assert.equal((await openProject(path)).digest, withoutRole.digest);
  await key('ESCAPE');
  assert.equal(ui.state.form, null);
  assert.equal(ui.state.workflow.role().label, 'Final saved name');
  ui.term.width = 180;
  ui.term.height = 54;

  await key('w');
  assert.equal(ui.state.mode, 'home');
  assert(hasAction('DOWN', 'select project'));
  assert(!ui.state.actionProvider().some((action) => action.key === 'D'));
  assert.doesNotMatch(ui.term.frame, /develop corpus|Organize roles|Add source statements/u);
  assert.match(ui.term.frame, /Project name/u);
  await key('D');
  assert.equal(ui.state.form, null, 'Home cannot dispatch the retained project legacy editor');
  await key('ENTER');
  ui.term.width = 80;
  ui.term.height = 24;
  await submit();
  assert.match(ui.term.frame, /Project name:/u);
  assert.match(ui.term.frame, /Project name is required/u);
  assert.doesNotMatch(ui.term.frame, /No corpus changes/u);
  await key('ESCAPE');
  ui.term.width = 180;
  ui.term.height = 54;
  await key('DOWN');
  assert.match(ui.term.frame, /Saved roles, statements and questions/u);
  await key('ESCAPE');
  assert.equal(ui.state.mode, 'project');

  // Persistence cannot truthfully offer cancellation once the write has begun.
  const committing = {
    project: {
      ...ui.state.project,
      data: {
        ...ui.state.project.data,
        contributions: [
          {
            id: 'retained-connection',
            responses: [],
            wordings: [{ id: 'connection', text: 'Confirmed source connection' }],
          },
        ],
      },
    },
    focus: 'reading',
    offset: 0,
    form: null,
  };
  let rejectWrite, enteredWrite;
  const writing = new Promise((resolve) => {
    enteredWrite = resolve;
  });
  const forms = createForms({
    state: committing,
    text: createText({ noColor: true }),
    projectsHome: directory,
    setNotice() {},
    scrollKey() {},
    saveError: (error) => error.message,
  });
  const development = createDevelopment({
    state: committing,
    forms,
    investigation: {},
    draw() {},
    setNotice() {},
    projects: {
      saveError: (error) => error.message,
      persistProject: () => {
        enteredWrite();
        return new Promise((_resolve, reject) => {
          rejectWrite = reject;
        });
      },
    },
  });
  development.withdrawDeclaration('retained-connection', 'connection');
  const withdrawal = committing.form;
  const saving = forms.submitForm();
  await writing;
  assert(withdrawal.busy && withdrawal.committing);
  assert.deepEqual(formActions(withdrawal), [], 'A committing write offers no false cancel');
  forms.backForm();
  assert.equal(committing.form, withdrawal);
  assert(withdrawal.busy, 'Escape cannot change a pending write into an editable form');
  rejectWrite(new Error('Write unavailable'));
  await saving;
  await withdrawal.execution;
  assert.equal(withdrawal.busy, false);
  assert.equal(withdrawal.committing, false);
  assert.equal(withdrawal.error, 'Write unavailable');
  assert(formActions(withdrawal).includes('Esc back'));
  assert(!committing.project.data.contributions[0].wordings[0].withdrawn);

  console.log(
    'ok keyboard project-change recovery: explicit reload/save, retained role and question drafts, unrelated source rebase, same-source conflict protection, fresh-editor return, global reload, zero requests',
  );
} finally {
  ui?.app.dispose();
  globalThis.fetch = fetch;
}
