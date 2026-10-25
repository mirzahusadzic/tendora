/** Paragraph authoring, source revision and atomic acquisition recovery in the minimal UI. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, openProject } from '../../../src/project/authoring/project.mjs';
import { journeyWorkbench, capturedParser } from '../../support/journey-workbench.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/paragraph-workflow-'));
const data = JSON.parse(
  await readFile(new URL('../../support/qa-editor-pilot-acquisitions.json', import.meta.url)),
);
const originalFetch = globalThis.fetch,
  requests = [];
const parser = capturedParser(data.entries, requests);
let rejectText = null,
  ui;
globalThis.fetch = (url, options) => {
  if (rejectText && JSON.parse(options.body).texts.includes(rejectText))
    throw new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  return parser(url, options);
};
try {
  const path = join(directory, 'service');
  ui = journeyWorkbench(await createProject(path, 'Service', 'Customer service'), directory);
  await ui.key('n');
  await ui.text(data.statements.join(' '));
  await ui.submit();
  assert.equal(ui.state.project.data.contributions[0].responses.length, 5);
  assert.deepEqual(
    [
      ...new Set(
        ui.state.project.data.contributions[0].responses.map((r) => `${r.actor}/${r.via}`),
      ),
    ],
    ['participant/editor'],
    'Statements written in the workbench record its actor and the editor',
  );
  assert.equal(ui.state.project.data.contributions[0].question, null);
  assert.equal(
    ui.state.project.data.placements.length,
    1,
    'Reading a paragraph does not replace the authored hierarchy with an AMR tree',
  );
  const billing = await ui.ask(data.questions[3]);
  assert.equal(billing.run.status, 'supported');
  assert.match(billing.run.answer.answers[0].text, /failures.*and.*processing/u);
  const originalId = billing.run.id;
  const acquired = requests.length;
  await ui.key('e');
  assert.equal(ui.state.form.title, 'Edit statements');
  await ui.key('ALT_U');
  await ui.text(data.statements.filter((_, index) => index !== 3).join(' '));
  await ui.submit();
  const revised = ui.state.workflow.current();
  assert(revised);
  assert.equal(revised.input.question.text, data.questions[3]);
  assert.equal(revised.run.status, 'open');
  assert.notEqual(revised.run.id, originalId);
  assert.equal(revised.run.projectDigest, ui.state.project.digest);
  assert.equal(
    requests.length,
    acquired,
    'Removing support and refreshing does not reacquire text',
  );
  assert.match(ui.term.frame, /Answer: Still open\./u);
  assert.doesNotMatch(ui.term.frame, /Earlier assessment|Check pending|Saved result:/u);
  assert(ui.state.project.data.contributions[0].responses[3].withdrawn);
  assert.equal(
    (await ui.ask(data.questions[6])).run.answer.answers[0].text,
    'issues',
    'Unrelated evidence remains usable',
  );
  const beforeReopen = requests.length;
  ui.app.dispose();
  ui = journeyWorkbench(await openProject(path), directory);
  await ui.key('o');
  await ui.choose(data.questions[3]);
  assert.equal(ui.state.workflow.current().run.status, 'open');
  assert.equal(requests.length, beforeReopen);
  ui.app.dispose();
  ui = journeyWorkbench(
    await createProject(join(directory, 'retry'), 'Retry', 'Sources'),
    directory,
  );
  rejectText = data.statements[1];
  await ui.key('n');
  await ui.text(data.statements.slice(0, 2).join(' '));
  const form = ui.state.form;
  ui.term.emit('key', 'CTRL_S', [], {});
  await ui.app.idle();
  await form.execution;
  assert.match(form.error, /ECONNREFUSED/u);
  assert.equal(
    ui.state.project.data.contributions?.length ?? 0,
    0,
    'A partially acquired paragraph is not partially published',
  );
  assert.equal(form.fields[0].value, data.statements.slice(0, 2).join(' '));
  rejectText = null;
  const before = requests.length;
  await ui.submit();
  assert.equal(ui.state.project.data.contributions[0].responses.length, 2);
  assert.deepEqual(
    requests.slice(before),
    [data.statements[1]],
    'Retry keeps the already acquired first sentence',
  );
  console.log(
    'ok source paragraph authoring, support withdrawal, automatic offline refresh, unaffected evidence, cold reopen and atomic acquisition retry',
  );
} finally {
  ui?.app.dispose();
  globalThis.fetch = originalFetch;
}
