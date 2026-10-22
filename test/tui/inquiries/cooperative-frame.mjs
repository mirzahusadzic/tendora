/** Ask and Development keep purpose/question lineage reachable through reload. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, openProject } from '../../../src/project/authoring/project.mjs';
import { currentAsk } from '../../../src/project/inquiries/investigation.mjs';
import { validateContinuation } from '../../../src/recording/continuation.mjs';
import { createState } from '../../../src/tui/shell/state.mjs';
import { createWorkbench } from '../../../src/tui/shell/app.mjs';
import { prepareProjectInquiry } from '../../../src/project/inquiries/inquiry.mjs';

class Terminal extends (await import('node:events')).EventEmitter {
  width = 160;
  height = 48;
  frame = '';
  fullscreen() {}
  hideCursor() {}
  grabInput() {}
  styleReset() {}
  raw(frame) {
    this.frame = frame;
  }
}

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/cooperative-frame-'));
let app;
try {
  const project = await createProject(directory, 'Cooperative frame', 'Operations');
  const term = new Terminal();
  const config = {
    projectsHome: directory,
    preferencesPath: join(directory, '.layout'),
    noColor: true,
    captureInquiry: async (project, scope, question, _progress, _signal, options) =>
      prepareProjectInquiry(project, scope, question, options),
  };
  const state = createState(
    { mode: 'project', project, placementId: project.data.placements[0].id },
    config,
  );
  app = createWorkbench({ state, config, term, onExit: () => assert.fail('Unexpected exit') });
  app.start();
  const key = async (key, isCharacter = false) => {
    term.emit('key', key, [], { isCharacter });
    await app.idle();
    assert.equal(state.failure, '');
  };
  const text = (value) => key(value, true);
  const hasAction = (description) =>
    assert(
      state.actionProvider().some((item) => item.description === description),
      description,
    );

  await key('a');
  await text('Who approves the rehearsal?');
  await key('CTRL_S');
  const created = currentAsk(state.investigation.data);
  assert.equal(created.frame.question.text, 'Who approves the rehearsal?');
  assert.equal(created.frame.question.revision, null);
  assert.equal(created.checkedFrame, null);
  hasAction('scope');
  hasAction('case');

  await key('ESCAPE');
  const savedEntry = state.projectEntryId;
  const savedRuns = state.projectEngineRuns;
  state.projectEngineRuns = [
    ...(savedRuns ?? []),
    {
      id: 'engine-only-without-ask',
      questions: [{ text: 'Engine-only question?' }],
      scopePlacementId: created.scopePlacementId,
      caseSelection: null,
      purpose: 'inquiry',
    },
  ];
  await state.workflow.refreshQuestions();
  const engineOnly = state.workflow
    .developmentItems()
    .find((item) => item.question === 'Engine-only question?');
  assert(engineOnly);
  assert(!engineOnly.investigationId && !engineOnly.askId);
  state.projectEntryId = engineOnly.id;
  assert(
    !state.actionProvider().some((item) => item.description === 'purpose'),
    'An engine-only question cannot expose the saved-Ask purpose action',
  );
  state.projectEngineRuns = savedRuns;
  await state.workflow.refreshQuestions();
  state.projectEntryId = savedEntry;

  await key('o');
  await key('HOME');
  await key('DOWN');
  hasAction('purpose');
  const purposeAction = state
    .actionProvider()
    .find((item) => item.pane === 'development' && item.key === 'i');
  assert(purposeAction);
  while (state.focus !== 'development') await key('TAB');
  await key('i');
  await app.idle();
  assert.equal(state.form.title, 'Purpose');
  await key('ALT_U');
  await text('Explain authority for the maintenance plan.');
  await key('ENTER');
  const purposeful = currentAsk(state.investigation.data);
  assert.equal(purposeful.frame.intention.text, 'Explain authority for the maintenance plan.');
  assert.equal(purposeful.carry.action, 'revise-purpose');
  assert.equal(purposeful.carry.status, 'pending');
  assert.equal(purposeful.carry.support, 'recheck');
  assert.match(term.frame, /Continued from/u);
  assert.match(term.frame, /The connection remains pending/u);

  await key('ESCAPE');
  await key('o');
  await key('HOME');
  await key('DOWN');
  assert.equal(state.focus, 'development');
  // The unsent Ask resumes from Development; a fresh Ask never adopts it.
  await key('ENTER');
  const resumed = currentAsk(state.investigation.data);
  assert.equal(resumed.id, purposeful.id);
  assert.equal(resumed.frame.intention.text, 'Explain authority for the maintenance plan.');

  await key('ALT_I');
  await key('ALT_U');
  await text('Plan the maintenance window.');
  await key('ENTER');
  const revisedPurpose = currentAsk(state.investigation.data);
  assert.equal(revisedPurpose.frame.intention.text, 'Plan the maintenance window.');
  assert.equal(revisedPurpose.carry.action, 'revise-purpose');

  await key('ALT_H');
  assert.equal(state.form.title, 'History');
  const askEntry = state.form.move.find((item) => item.kind === 'ask' && item.item?.carry);
  assert(askEntry);
  assert.ok(askEntry.item.carry, 'The Ask list retains its carry');
  const visibleCarry = askEntry.item.carry;
  await key('HOME');
  for (let i = 0; i < state.form.move.indexOf(askEntry); i++) await key('DOWN');
  await key('ENTER');
  assert.equal(state.form.title, 'Past question');
  assert.match(state.form.inspectRows.map((row) => row.join(': ')).join('\n'), /Continued from/u);
  assert.equal(visibleCarry.origin.question, 'Who approves the rehearsal?');
  await key('ESCAPE');

  const v2 = {
    schema: 'tendora.continuation',
    version: 2,
    author: 'participant',
    contextUse: 'review-only',
    question: 'Who approves the rehearsal?',
    scopePlacementId: 'operations',
    parent: {
      path: '/legacy/parent.json',
      revision: 'parent-revision',
      project: {
        id: 'legacy-project',
        path: '/legacy/project.json',
        placementId: 'operations',
      },
      question: 'Who approves the rehearsal?',
      nodeId: 'operations',
      occurrenceId: null,
      queryGraph: { top: 'r', nodes: [{ id: 'r', concept: 'approve-01' }], edges: [] },
    },
    opening: { id: 'question', kind: 'question', label: 'Who approves the rehearsal?' },
    history: [
      {
        question: 'Who approves the rehearsal?',
        path: '/legacy/parent.json',
        revision: 'parent-revision',
        scopePlacementId: 'operations',
        scopeLabel: 'Operations',
      },
    ],
  };
  assert.equal(validateContinuation(v2).version, 2, 'Existing v2 records remain readable');

  app.dispose();
  app = null;
  const reopenedProject = await openProject(directory);
  const reopenedTerm = new Terminal();
  const reopenedState = createState(
    {
      mode: 'project',
      project: reopenedProject,
      placementId: reopenedProject.data.placements[0].id,
    },
    config,
  );
  app = createWorkbench({
    state: reopenedState,
    config,
    term: reopenedTerm,
    onExit: () => assert.fail('Unexpected exit'),
  });
  app.start();
  const reopenedKey = async (key, isCharacter = false) => {
    reopenedTerm.emit('key', key, [], { isCharacter });
    await app.idle();
    assert.equal(reopenedState.failure, '');
  };
  // After reload the unsent Ask is still listed in Development.
  await reopenedKey('o');
  await reopenedKey('HOME');
  const draftAt = reopenedState.workflow
    .developmentItems()
    .findIndex((item) => item.askId === revisedPurpose.id);
  assert(draftAt >= 0, 'The unsent Ask survives reload');
  for (let i = 0; i < draftAt; i++) await reopenedKey('DOWN');
  await reopenedKey('ENTER');
  const reloaded = currentAsk(reopenedState.investigation.data);
  assert.ok(reloaded.frame, 'Reload restores the versioned frame');
  assert.ok(reloaded.carry, 'Reload restores the carry lineage');
  assert.equal(reloaded.frame.intention.text, 'Plan the maintenance window.');
  assert.equal(reloaded.carry.origin.question, 'Who approves the rehearsal?');
  assert.match(reopenedTerm.frame, /Purpose/u);

  console.log(
    'ok cooperative frame UI: ordinary Ask actions, purpose lineage, history detail, saved draft reload and legacy continuation readability',
  );
} finally {
  app?.dispose();
  await rm(directory, { recursive: true, force: true });
}
