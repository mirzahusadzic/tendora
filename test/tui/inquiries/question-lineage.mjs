/** Development groups saved questions by where they came from, the author's own
 * first; one kind needs no heading, and an unknown lineage is refused. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject } from '../../../src/project/authoring/project.mjs';
import {
  addAsk,
  newInvestigation,
  saveInvestigation,
  validateInvestigation,
} from '../../../src/project/inquiries/investigation.mjs';
import { journeyWorkbench } from '../../support/journey-workbench.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/question-lineage-'));
const save = async (project, question, lineage) =>
  saveInvestigation(
    project,
    addAsk(newInvestigation(project, question), {
      question,
      scopePlacementId: project.data.placements[0].id,
      lineage,
    }),
  );
try {
  const project = await createProject(join(directory, 'project'), 'Workshop', 'Work');
  await save(project, 'Who may open the stage door?', { kind: 'outside', by: 'a link' });
  await save(project, 'Who repairs the lift?', { kind: 'drafted', by: 'an assistant' });
  await save(project, 'Who inspects the lift?', null);
  await save(project, 'Who signs the repair?', { kind: 'drafted', by: 'an assistant' });
  const ui = journeyWorkbench(project, directory);
  await ui.app.idle();
  await ui.key('o');
  const items = ui.state.workflow.developmentItems();
  assert.deepEqual(
    items.map((item) => item.section),
    [
      'Asked here (1)',
      'Drafted · an assistant (2)',
      'Drafted · an assistant (2)',
      'From outside · a link (1)',
    ],
  );
  // Within a group, questions keep their saved order.
  assert.deepEqual(
    items
      .slice(1, 3)
      .map((item) => item.question)
      .sort(),
    ['Who repairs the lift?', 'Who signs the repair?'],
  );
  const shown = (heading) => ui.term.frame.split(heading).length - 1;
  for (const heading of ['Asked here (1)', 'Drafted · an assistant (2)'])
    assert.equal(shown(heading), 1, `${heading} is shown once`);
  // Moving follows the grouped order, and a group's heading stays with its first question.
  await ui.key('HOME');
  await ui.key('DOWN');
  assert.equal(ui.state.workflow.selectedQuestion().id, items[1].id);
  await ui.key('END');
  assert.equal(ui.state.workflow.selectedQuestion().id, items[3].id);
  assert.equal(shown('From outside · a link (1)'), 1);
  ui.app.dispose();

  const single = await createProject(join(directory, 'single'), 'Single', 'Work');
  await save(single, 'Who inspects the lift?', null);
  await save(single, 'Who repairs the lift?', null);
  const plain = journeyWorkbench(single, directory);
  await plain.app.idle();
  await plain.key('o');
  assert(plain.state.workflow.developmentItems().every((item) => !item.section));
  assert(!plain.term.frame.includes('Asked here'), 'One kind needs no heading');
  plain.app.dispose();

  const invalid = addAsk(newInvestigation(project, 'Who?'), {
    question: 'Who?',
    scopePlacementId: project.data.placements[0].id,
    lineage: { kind: 'rumour' },
  });
  assert.throws(() => validateInvestigation(invalid), /Invalid ask lineage/u);
  console.log('ok Development groups questions by lineage, own first; one kind is not headed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
