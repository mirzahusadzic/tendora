/** The role tree is authored structure; acquired meanings and their warnings remain inspectable. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, openProject } from '../../../src/project/authoring/project.mjs';
import { retainAcquisitions, acquiredTexts } from '../../../src/project/storage/acquisitions.mjs';
import { frozenParser } from '../../support/development-acquisition.mjs';
import { originalHandQuestion, originalHandPenman } from '../../support/original-hand-question.mjs';
import { journeyWorkbench } from '../../support/journey-workbench.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/reading-review-'));
const oldFetch = globalThis.fetch,
  requests = [];
globalThis.fetch = frozenParser(requests);
let ui;
try {
  const path = join(directory, 'hand');
  const project = await createProject(path, 'Touchable making', 'Design');
  await retainAcquisitions(project, [
    {
      text: originalHandQuestion,
      penman: originalHandPenman,
      acquisition: {
        penman: originalHandPenman,
        model: 'retained-original-AMRBART',
        revision: 'unchanged',
      },
      origin: { kind: 'original-retained-reading' },
    },
  ]);
  ui = journeyWorkbench(project, directory);
  await ui.key('c');
  await ui.text('Workbench');
  await ui.submit('ENTER');
  await ui.key('n');
  await ui.text('The programmer recognizes intention in the resulting design.');
  await ui.submit();
  await ui.selectRole('Design');
  const current = await ui.ask(originalHandQuestion);
  assert.equal(current.run.status, 'open');
  const before = JSON.stringify(current.result.inputs.find((i) => i.kind === 'question').graph);
  assert.match(ui.term.frame, /A word may have been read with another meaning/u);
  assert.doesNotMatch(ui.term.frame, /Why flagged:/u, 'Details stay in the reading review');
  assert(ui.state.viewport.developmentHeight > 0);
  assert.equal(ui.state.viewport.recordingsHeight, 0);
  assert.equal(
    ui.state.workflow.roles().length,
    2,
    'AMR participants do not replace authored roles',
  );
  await ui.key('i');
  assert.equal(
    ui.state.workflow.readingView().sections[0].rows[0][1],
    originalHandQuestion,
    'Review starts at the flagged question',
  );
  assert.equal(ui.state.form, null, 'The exact reading opens without a mixed-text picker');
  assert.match(ui.term.frame, /Check the language reading/u);
  assert.match(ui.term.frame, /intercede-01/u);
  assert.match(ui.term.frame, /Reading.*Meaning.*Why flagged/u);
  assert.match(ui.term.frame, /No matching expression/u);
  assert.match(ui.term.frame, /the expression may be implicit/u);
  assert.match(ui.term.frame, /e revise wording/u);
  await ui.key('ESCAPE');
  assert.match(ui.term.frame, /Develop question/u);
  const child = ui.state.viewport.nodeHits.find((hit) => hit.id !== project.data.placements[0].id);
  assert(child);
  ui.term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: 9, y: child.y });
  await ui.app.idle();
  assert.equal(ui.state.workflow.role().label, 'Workbench');
  assert.match(
    ui.term.frame,
    /Question: Did programmer recognized/u,
    'A mouse-selected child retains the working question',
  );
  assert.match(ui.term.frame, /The programmer recognizes intention in the resulting design/u);
  await ui.key('i');
  await ui.key('e');
  assert.equal(ui.state.form.fields[0].value, originalHandQuestion);
  assert.equal(
    ui.state.placementId,
    project.data.placements[0].id,
    'Revising a question keeps its original scope, even when inspecting from a child',
  );
  await ui.key('ESCAPE');
  assert.match(ui.term.frame, /Check the language reading/u);
  await ui.key('ESCAPE');
  assert.equal(
    JSON.stringify(current.result.inputs.find((i) => i.kind === 'question').graph),
    before,
  );
  assert.equal(
    (await acquiredTexts(ui.state.project, [originalHandQuestion]))[0].penman,
    originalHandPenman,
  );
  assert(
    !requests.includes(originalHandQuestion),
    'The suspect reading is disclosed, never silently replaced',
  );
  ui.app.dispose();
  ui = journeyWorkbench(await openProject(path), directory);
  await ui.key('o');
  await ui.choose(originalHandQuestion);
  assert.match(ui.term.frame, /read with another meaning/u, 'The warning survives reopening');
  ui.app.dispose();
  ui = journeyWorkbench(
    await createProject(join(directory, 'label'), 'Label only', 'Sam repairs bicycles.'),
    directory,
  );
  const labelOnly = await ui.ask('Who repairs bicycles?');
  assert.equal(labelOnly.run.status, 'open', 'A role name is not an asserted premise');
  assert.equal(labelOnly.recording.sources.length, 0);
  console.log(
    'ok actual user AMR warning, inline and detailed review, mouse hierarchy navigation, unchanged acquisition, cold reopen and role-label non-evidence',
  );
} finally {
  ui?.app.dispose();
  globalThis.fetch = oldFetch;
}
