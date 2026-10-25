/** Moving through Development drops a saved check still loading for an earlier
 * selection: it is never presented over the question now selected (review
 * 2026-10-25, #13). */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createProject,
  editConcept,
  saveProject,
} from '../../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../../src/project/storage/acquisitions.mjs';
import { requestProjectInquiry } from '../../../src/project/inquiries/ask-run.mjs';
import { journeyWorkbench } from '../../support/journey-workbench.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/development-glance-'));
const fetch = globalThis.fetch;
globalThis.fetch = () => assert.fail('Saved checks are shown without acquisition');
try {
  const readings = [
    [
      'The technician inspects the lift.',
      '(i / inspect-01 :ARG0 (t / technician) :ARG1 (l / lift))',
    ],
    ['The manager signs the repair.', '(s / sign-01 :ARG0 (m / manager) :ARG1 (r / repair-01))'],
    ['Who inspects the lift?', '(i / inspect-01 :ARG0 (u / amr-unknown) :ARG1 (l / lift))'],
    ['Who signs the repair?', '(s / sign-01 :ARG0 (u / amr-unknown) :ARG1 (r / repair-01))'],
  ];
  let project = await createProject(join(directory, 'workshop'), 'Workshop', 'Work');
  project = await saveProject(
    project,
    editConcept(project.data, project.data.concepts[0].id, 'Work', [
      readings[0][0],
      readings[1][0],
    ]),
  );
  await retainAcquisitions(
    project,
    readings.map(([text, penman]) => ({ text, penman, origin: { kind: 'glance-test' } })),
  );
  for (const [question] of readings.slice(2))
    await requestProjectInquiry(project, {
      scopePlacementId: project.data.placements[0].id,
      question,
      acquireMissing: false,
      engineTrace: false,
    });

  // A selection that never settles on its own, so only the earlier load is in flight.
  const ui = journeyWorkbench(project, directory, { settleMs: 60_000 });
  await ui.app.idle();
  await ui.key('o');
  while (ui.state.focus !== 'development') await ui.key('TAB');
  const items = ui.state.workflow.developmentItems().filter((item) => item.run);
  assert.equal(items.length, 2);
  // The second question's saved check is presented.
  await ui.key('END');
  const second = ui.state.projectEntryId;
  const secondRun = items.find((item) => item.id === second).run.id;
  const firstRun = items.find((item) => item.id !== second).run.id;
  assert.equal(ui.state.workflow.current().run.id, secondRun);
  // The first question's check starts loading, as when the selection rests on
  // it, and the selection moves back before it arrives. (The workflow's own key
  // path: a move reaches the selection at once.)
  const loading = ui.state.workflow.show(firstRun);
  const moved = ui.state.workflow.handleKey('END');
  await loading;
  await moved;
  assert.equal(ui.state.projectEntryId, second, 'The selection stays where it moved');
  assert.equal(
    ui.state.workflow.current().run.id,
    secondRun,
    'The check loaded for the earlier selection is not presented',
  );
  ui.app.dispose();
  console.log('ok Development: a check loading for an earlier selection is dropped');
} finally {
  globalThis.fetch = fetch;
  await rm(directory, { recursive: true, force: true });
}
