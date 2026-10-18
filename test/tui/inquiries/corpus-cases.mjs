/** Natural-language policies in a role, with independently selected case evidence. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, openProject } from '../../../src/project/authoring/project.mjs';
import { journeyWorkbench, capturedParser } from '../../support/journey-workbench.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/policy-workflow-'));
const data = JSON.parse(
  await readFile(new URL('../../support/qa-tendora-developed-acquisitions.json', import.meta.url)),
);
const oldFetch = globalThis.fetch,
  requests = [];
globalThis.fetch = capturedParser(data.entries, requests);
let ui;
try {
  const path = join(directory, 'service');
  ui = journeyWorkbench(await createProject(path, 'Service', 'Customer service'), directory);
  await ui.key('n');
  await ui.text(data.material.join(' '));
  await ui.submit();
  assert.equal(ui.state.project.data.contributions[0].question, null);
  assert.equal(
    (await ui.ask(data.questions[1])).run.status,
    'open',
    'Policies are not facts about every ticket',
  );
  for (const [index, expected] of [
    [0, 'billing'],
    [1, 'billing'],
    [2, 'account'],
    [3, 'account'],
    [4, null],
    [5, null],
    [6, null],
  ]) {
    await ui.key('a');
    await ui.text(data.questions[1]);
    await ui.key('ALT_C');
    await ui.choose('Write a case');
    await ui.text(data.cases[index]);
    await ui.submit();
    assert(ui.state.form.workspace);
    const selected = structuredClone(ui.state.form.caseSelection);
    await ui.submit('ENTER');
    const current = ui.state.workflow.current();
    assert(current, 'Current question and independent case are shown');
    assert.deepEqual(current.input.caseSelection, selected);
    if (expected) {
      assert.equal(current.run.status, 'supported');
      assert.match(current.run.answer.answers[0].text, new RegExp(expected));
      assert(current.run.answer.answers[0].ruleIds.length >= 2);
      assert(current.run.answer.answers[0].derivation.tree);
    } else
      assert.notEqual(
        current.run.status,
        'supported',
        'Absent urgency, modality and reversed participants do not license an unconditional answer',
      );
    assert.equal(
      ui.state.project.data.contributions.length,
      1,
      'A selected case does not become a general corpus assertion',
    );
    assert(current.input.cases.length);
  }
  const before = requests.length;
  ui.app.dispose();
  ui = journeyWorkbench(await openProject(path), directory);
  await ui.key('o');
  const caseChoices = ui.state.workflow
    .developmentItems()
    .filter((c) => c.run.questions[0].text === data.questions[1]);
  assert(caseChoices.length >= 7, 'Cases keep their distinct scopes in saved questions');
  await ui.choose((choice) => choice.run.status === 'supported');
  assert.equal(ui.state.workflow.current().run.status, 'supported');
  assert.equal(requests.length, before, 'Reopening the case reuses its exact snapshot');
  console.log(
    'ok language policies, seven independent cases, two generated rule steps, modal/role controls and cold reopen',
  );
} finally {
  ui?.app.dispose();
  globalThis.fetch = oldFetch;
}
