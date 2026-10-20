/** Ask keeps corpus scope, independent case and the question draft separate. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, saveProject } from '../../../src/project/authoring/project.mjs';
import { currentAsk, readInvestigation } from '../../../src/project/inquiries/investigation.mjs';
import { prepareProjectInquiry } from '../../../src/project/inquiries/inquiry.mjs';
import { createState } from '../../../src/tui/shell/state.mjs';
import { createWorkbench } from '../../../src/tui/shell/app.mjs';

class Terminal extends EventEmitter {
  width = 150;
  height = 42;
  frames = [];
  fullscreen() {}
  hideCursor() {}
  grabInput() {}
  styleReset() {}
  raw(value) {
    this.frames.push(value);
  }
}
const directory = await mkdtemp(join(tmpdir(), 'ask-scope-'));
let app;
try {
  let project = await createProject(directory, 'Scope selection', 'Ticket');
  project = await saveProject(project, {
    ...project.data,
    concepts: [
      { id: 'ticket', name: 'Ticket', passages: [] },
      { id: 'account', name: 'Account', passages: ['The account team handles login problems.'] },
      { id: 'login', name: 'Login ticket', passages: ['My login has failed three times.'] },
    ],
    placements: [
      { id: 'ticket', conceptId: 'ticket', parentId: null },
      { id: 'account', conceptId: 'account', parentId: 'ticket' },
      { id: 'login', conceptId: 'login', parentId: null },
    ],
  });
  const term = new Terminal();
  let captured;
  const config = {
    projectsHome: directory,
    preferencesPath: join(directory, '.layout'),
    noColor: true,
    captureInquiry: async (project, scope, question, _progress, _signal, options) => {
      captured = {
        scope,
        question,
        caseSelection: options.caseSelection,
        ...prepareProjectInquiry(project, scope, question, options),
      };
      throw new Error('Acquisition stopped after checking scope');
    },
  };
  const state = createState(
    { mode: 'project', project, placementId: 'login', focus: 'nodes' },
    config,
  );
  app = createWorkbench({ state, config, term, onExit: () => assert.fail('Unexpected exit') });
  app.start();
  // A retained engine experiment must not replace the pilot's Ask workspace.
  state.engineInputs = { profile: 'fragment-chain-v1' };
  assert(
    state
      .actionProvider()
      .some(
        (action) =>
          action.pane === 'nodes' && action.key === 'a' && action.description === 'ask here',
      ),
  );
  const key = async (key, isCharacter = false) => {
    term.emit('key', key, [], { isCharacter });
    await app.idle();
    assert.equal(state.failure, '');
  };
  await key('a');
  assert.equal(state.focus, 'reading', 'Opening Ask focuses the question without a pane switch');
  assert.equal(state.form.caseSelection, null, 'A selected concept is not an implicit case');
  const question = 'Which team should handle this ticket?';
  await key(question, true);
  await key('LEFT');
  const form = state.form,
    cursor = form.fields[0].cursor;
  for (const hidden of ['ALT_H', 'ALT_B', 'ALT_R']) {
    assert(!state.actionProvider().some((action) => action.key === hidden));
    await key(hidden);
    assert.equal(state.form, form, `${hidden} cannot open an unadvertised legacy view`);
    assert.equal(form.fields[0].value, question);
    assert.equal(form.fields[0].cursor, cursor);
  }
  assert(
    state.viewport.actionHits.some((hit) => hit.description === 'case' && hit.inputKey === 'ALT_C'),
    'The case selector is visible beside the question',
  );
  await key('ALT_C');
  assert.equal(state.form.title, 'Case');
  assert.deepEqual(
    state.form.move.map((choice) => choice.label),
    ['No case', 'Write a case', 'Ticket → Account', 'Login ticket'],
    'The case selector uses readable placement paths and omits empty concepts',
  );
  assert.equal(state.form.fields.length, 0, 'Case selection has no technical input fields');
  await key('END');
  assert(term.frames.at(-1).includes('My login has failed three times.'));
  await key('ESCAPE');
  assert.equal(state.form, form);
  assert.equal(form.caseSelection, null, 'Cancelling the selector leaves the case unchanged');
  assert.equal(state.placementId, 'login');
  assert.equal(form.fields[0].cursor, cursor);
  await key('ALT_C');
  await key('END');
  await key('ENTER');
  const selectedCase = structuredClone(form.caseSelection);
  assert.equal(selectedCase.placementId, 'login');
  assert.equal(state.form, form, 'Selection returns directly to the question');
  assert.equal(state.focus, 'reading');
  assert.equal(form.fields[0].value, question);
  assert.equal(form.fields[0].cursor, cursor);
  assert(term.frames.at(-1).includes('Scope: Login ticket'));
  assert(
    state.viewport.actionHits.some(
      (hit) => hit.description === 'scope' && hit.inputKey === 'ALT_S',
    ),
  );
  await key('ALT_S');
  assert.equal(state.form.title, 'Scope');
  assert.deepEqual(
    state.form.move.map((choice) => choice.label),
    ['Ticket', 'Ticket → Account', 'Login ticket'],
  );
  assert.equal(state.form.move[state.form.index].id, 'login');
  await key('HOME');
  await key('ESCAPE');
  assert.equal(state.form, form);
  assert.equal(state.placementId, 'login', 'Cancel leaves scope unchanged');
  await key('ALT_S');
  await key('HOME');
  await key('ENTER');
  assert.equal(state.form, form);
  assert.equal(state.focus, 'reading');
  assert.equal(state.placementId, 'ticket');
  assert.equal(form.fields[0].value, question);
  assert.equal(form.fields[0].cursor, cursor);
  assert.deepEqual(form.caseSelection, selectedCase);
  assert(term.frames.at(-1).includes('Scope: Ticket'));
  await key('ALT_C');
  assert.equal(state.form.move[state.form.index].id, 'login');
  await key('ENTER');
  assert.deepEqual(form.caseSelection, selectedCase, 'Reselecting preserves the saved case');
  assert.equal(state.placementId, 'ticket', 'Selecting a case never changes corpus scope');
  await key('ALT_C');
  await key('HOME');
  await key('ENTER');
  assert.equal(form.caseSelection, null);
  assert.equal(state.placementId, 'ticket');
  await key('ALT_C');
  await key('END');
  await key('ENTER');
  Object.assign(selectedCase, structuredClone(form.caseSelection));
  const saved = currentAsk((await readInvestigation(project, state.investigation.data.id)).data);
  assert.equal(saved.scopePlacementId, 'ticket');
  assert.deepEqual(saved.caseSelection, selectedCase);
  await key('ESCAPE');
  await key('a');
  assert.equal(state.placementId, 'ticket');
  assert.equal(state.form.fields[0].value, question);
  assert.deepEqual(state.form.caseSelection, selectedCase);
  await key('ENTER');
  for (let i = 0; i < 50 && !captured; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(captured.scope, 'ticket');
  assert.equal(captured.question, question);
  assert.deepEqual(captured.caseSelection, selectedCase);
  assert.deepEqual(
    captured.branch.map((node) => node.placementId),
    ['ticket', 'account'],
  );
  assert.equal(captured.asset.caseState.rootNodeId, 'login');
  assert.deepEqual(
    captured.asset.nodes.find((node) => node.id === 'login').sentences,
    selectedCase.sources.map((source) => source.text),
  );
  assert(
    captured.asset.nodes
      .find((node) => node.id === 'account')
      .sentences.includes('The account team handles login problems.'),
  );
  assert.equal(
    state.form.title,
    'Ask',
    'The submitted query belongs to the ordinary Ask workspace',
  );
  console.log(
    'ok Ask focuses the question; direct case selection, preview, cancellation and clearing preserve scope and draft; saved inputs match CLI',
  );
} finally {
  app?.dispose();
  await rm(directory, { recursive: true, force: true });
}
