/** A checked question continues from a real opening through capture and reload. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, openProject } from '../../../src/project/authoring/project.mjs';
import { currentAsk, readInvestigation } from '../../../src/project/inquiries/investigation.mjs';
import { journeyWorkbench, capturedParser } from '../../support/journey-workbench.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/cooperative-loop-'));
const fixture = JSON.parse(
  await readFile(new URL('../../support/qa-development-acquisitions.json', import.meta.url)),
);
const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = capturedParser(fixture.entries, requests);
let ui;
try {
  const project = await createProject(join(directory, 'project'), 'Cooperative loop', 'Workshop');
  ui = journeyWorkbench(project, directory);
  await ui.key('n');
  await ui.text('Sam repairs bicycles.');
  await ui.submit();
  const initial = await ui.ask('Who repairs bicycles in the workshop?');
  assert.equal(initial.run.status, 'open');
  assert(initial.run.openings.length > 1, 'The source question retains more than one gap');
  while (ui.state.focus !== 'reading') await ui.key('TAB');
  await ui.key('HOME');
  const rows = (section) => [
    ...(section.rowChoices ?? []),
    ...(section.table?.entries ?? []).filter((entry) => entry.choiceIndex !== undefined),
    ...(section.groups ?? []).flatMap(rows),
  ];
  const choices = ui.state.workflow.readingView().sections.flatMap(rows);
  const row = choices.find((entry) => entry.openings?.length);
  assert(row);
  await ui.key('HOME');
  for (let i = 0; i < choices.indexOf(row); i++) await ui.key('DOWN');
  // The selected gap offers continuation directly.
  assert.equal(ui.state.workflow.readingView().title, 'Develop question');
  assert(
    ui.state.workflow
      .actions()
      .some((item) => item.key === 'c' && item.description === 'continue question'),
  );
  assert.match(ui.term.frame, /c continue question/u);
  await ui.key('c');
  assert.equal(ui.state.form.title, 'Ask');
  const parentPath = initial.run.recording.path;
  const parentRevision = ui.state.form.origin.recordingRevision;
  assert.equal(ui.state.form.continuation.version, 3);
  assert.equal(ui.state.form.continuation.carry.status, 'pending');
  const openingId = ui.state.form.continuation.opening.id;
  assert(openingId);

  await ui.key('ALT_U');
  await ui.text('What does Sam repair in the workshop?');
  await ui.submit('ENTER');
  const received = ui.state.workflow.current();
  assert(received);
  assert.equal(received.input.question.text, 'What does Sam repair in the workshop?');
  const first = currentAsk(ui.state.investigation.data);
  assert.equal(first.continuation.parent.path, parentPath);
  assert.equal(first.continuation.parent.revision, parentRevision);
  assert.equal(first.carry.origin.opening.id, 'e5');
  assert.equal(first.originOpening.id, 'e5');
  assert.equal(first.retainedOpening.id, 'query:e2');
  assert.deepEqual(first.retainedOpening.edge, first.originOpening.edge);
  assert.equal(first.carry.receiving.question, 'What does Sam repair in the workshop?');
  assert.equal(first.frame.question.text, received.input.question.text);
  assert.equal(first.frame.question.revision.length, 64);
  assert.equal(first.frame.id, first.carry.receiving.frameRevision);
  assert.equal(first.continuation.frame.id, first.continuation.carry.receiving.frameRevision);
  assert.equal(first.checkedFrame.id, first.frame.id);
  assert.equal(first.runs.at(-1).frame.id, first.frame.id);
  assert.equal(first.runs.at(-1).carry.origin.frameRevision, first.carry.origin.frameRevision);
  const firstRunCount = ui.state.projectEngineRuns.length;
  await ui.key('o');
  await ui.choose((item) => item.label === 'What does Sam repair in the workshop?');
  const purposeAction = ui.state
    .actionProvider()
    .find((item) => item.key === 'i' && item.description === 'purpose');
  assert(purposeAction);
  while (ui.state.focus !== 'development') await ui.key('TAB');
  await ui.key('i');
  await ui.app.idle();
  assert.equal(ui.state.form.title, 'Purpose');
  await ui.key('ALT_U');
  await ui.text('Explain repair authority for the workshop.');
  await ui.key('ENTER');
  const purposeful = currentAsk(ui.state.investigation.data);
  assert.equal(purposeful.frame.intention.text, 'Explain repair authority for the workshop.');
  assert.equal(purposeful.carry.action, 'revise-purpose');
  assert.equal(purposeful.carry.status, 'checked');
  assert.equal(purposeful.carry.support, 'unchanged');
  assert.equal(purposeful.frame.question.revision, first.frame.question.revision);
  assert.equal(purposeful.checkedFrame.id, first.frame.id);
  assert.match(ui.term.frame, /What changed: purpose/u);
  assert.doesNotMatch(ui.term.frame, /What changed: question/u);
  assert.equal(
    ui.state.projectEngineRuns.length,
    firstRunCount,
    'A purpose-only edit does not manufacture a new check or assessment',
  );
  assert.equal(ui.state.workflow.current().run.id, first.runs.at(-1).engineRunId);
  assert.equal(ui.state.workflow.current().run.status, 'open');

  const firstPath = first.runs.at(-1).path;
  const firstRevision = first.runs.at(-1).recordingRevision;
  const saved = currentAsk((await readInvestigation(project, ui.state.investigation.data.id)).data);
  assert.equal(saved.id, first.id);
  assert.equal(saved.continuation.version, 3);
  assert.equal(saved.carry.status, 'checked');
  assert.equal(saved.carry.support, 'unchanged');

  ui.app.dispose();
  ui = journeyWorkbench(await openProject(join(directory, 'project')), directory);
  await ui.key('o');
  await ui.choose((item) => item.label === 'What does Sam repair in the workshop?');
  assert.equal(ui.state.workflow.current().run.status, 'open');
  assert(ui.state.workflow.current().run.answer.partial.openings.length);
  assert.match(ui.term.frame, /How this question was reached/u);
  assert.match(ui.term.frame, /Who repairs bicycles in the workshop\?/u);

  const reopenedRuns = ui.state.projectEngineRuns.length;
  await ui.key('o');
  await ui.choose((item) => item.label === 'Who repairs bicycles in the workshop?');
  await ui.key('o');
  await ui.choose((item) => item.label === 'What does Sam repair in the workshop?');
  while (ui.state.focus !== 'reading') await ui.key('TAB');
  await ui.key('HOME');
  const reopenedChoices = ui.state.workflow.readingView().sections.flatMap(rows);
  const reopenedRow = reopenedChoices.find((entry) => entry.openings?.length);
  assert(reopenedRow);
  await ui.key('HOME');
  for (let i = 0; i < reopenedChoices.indexOf(reopenedRow); i++) await ui.key('DOWN');
  assert.equal(ui.state.workflow.readingView().title, 'Develop question');
  await ui.key('c');
  assert.equal(ui.state.form.title, 'Ask');
  const secondOrigin = ui.state.form.origin;
  assert.equal(secondOrigin.path, firstPath);
  assert.equal(secondOrigin.recordingRevision, firstRevision);
  await ui.key('ALT_U');
  await ui.text('Who repairs bicycles?');
  await ui.submit('ENTER');
  const second = ui.state.workflow.current();
  assert(second);
  assert.equal(second.input.question.text, 'Who repairs bicycles?');
  assert.equal(second.run.status, 'supported');
  assert.equal(second.run.answer.answers[0].text, 'Sam');
  const ask = currentAsk(ui.state.investigation.data);
  assert.equal(ask.continuation.parent.path, firstPath);
  assert.equal(ask.continuation.parent.revision, firstRevision);
  assert.equal(ask.carry.origin.question, 'What does Sam repair in the workshop?');
  assert.equal(ask.carry.receiving.question, 'Who repairs bicycles?');
  assert.equal(ask.frame.question.revision.length, 64);
  assert.equal(ask.frame.id, ask.carry.receiving.frameRevision);
  assert.equal(ask.continuation.frame.id, ask.continuation.carry.receiving.frameRevision);
  assert(ui.state.projectEngineRuns.length > reopenedRuns);

  console.log(
    'ok cooperative loop: real opening carry, receiving capture, checked reload, second continuation, parent paths/revisions and current answers',
  );
} finally {
  ui?.app.dispose();
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
