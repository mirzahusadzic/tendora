/** Development can be made taller than Roles by dragging its divider past the
 * middle; the height is kept for that project, and another project keeps its own. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject } from '../../../src/project/authoring/project.mjs';
import {
  addAsk,
  newInvestigation,
  saveInvestigation,
} from '../../../src/project/inquiries/investigation.mjs';
import { journeyWorkbench } from '../../support/journey-workbench.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/development-height-'));
const withQuestions = async (path, name) => {
  const project = await createProject(join(directory, path), name, 'Work');
  for (const question of ['Who inspects the lift?', 'Who repairs the lift?'])
    await saveInvestigation(
      project,
      addAsk(newInvestigation(project, question), {
        question,
        scopePlacementId: project.data.placements[0].id,
      }),
    );
  return project;
};
try {
  const project = await withQuestions('workshop', 'Workshop');
  const other = await withQuestions('theatre', 'Theatre');
  const ui = journeyWorkbench(project, directory);
  await ui.app.idle();
  await ui.key('o');
  const { bodyHeight, developmentHeight, recordingsTop } = ui.state.viewport;
  assert(developmentHeight <= bodyHeight / 2 + 1, 'By default Development takes about half');
  const drag = (event, y) => ui.term.emit('mouse', event, { x: 4, y });
  drag('MOUSE_LEFT_BUTTON_PRESSED', recordingsTop);
  await ui.app.idle();
  drag('MOUSE_DRAG', recordingsTop - Math.floor(bodyHeight * 0.4));
  drag('MOUSE_LEFT_BUTTON_RELEASED', recordingsTop - Math.floor(bodyHeight * 0.4));
  await ui.app.idle();
  const taller = ui.state.viewport.developmentHeight;
  assert(taller > bodyHeight * 0.75, `Development passes the middle: ${taller} of ${bodyHeight}`);
  assert(bodyHeight - taller >= 8, 'Roles keep room for their title, a few rows and their hints');
  const saved = JSON.parse(await readFile(join(directory, '.layout'), 'utf8'));
  assert(
    Math.abs(saved.projects[project.data.id].developmentFraction * bodyHeight - taller) <= 1,
    'The height is saved for this project',
  );
  ui.app.dispose();

  // A new session restores it; another project keeps the default.
  const restore = (opened) =>
    journeyWorkbench(opened, directory, {}, { projectLayouts: saved.projects });
  const again = restore(project);
  await again.app.idle();
  await again.key('o');
  assert.equal(again.state.viewport.developmentHeight, taller);
  again.app.dispose();
  const elsewhere = restore(other);
  await elsewhere.app.idle();
  await elsewhere.key('o');
  assert.equal(elsewhere.state.viewport.developmentHeight, developmentHeight);
  elsewhere.app.dispose();
  console.log(
    `ok Development grows past the middle (${developmentHeight} → ${taller} of ${bodyHeight} rows), saved per project`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
