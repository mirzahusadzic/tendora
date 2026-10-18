/** Current work survives a source edit; checks expose progress, failure and cancellation. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject } from '../../../src/project/authoring/project.mjs';
import { captureProjectInquiry } from '../../../src/project/inquiries/inquiry.mjs';
import { frozenParser } from '../../support/development-acquisition.mjs';
import { journeyWorkbench } from '../../support/journey-workbench.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/development-flow-'));
const oldFetch = globalThis.fetch,
  requests = [];
globalThis.fetch = frozenParser(requests);
let ui,
  held,
  announce,
  behavior = 'normal';
const captureInquiry = async (...args) => {
  const [, , , progress, signal, options] = args;
  if (options.acquireMissing === false && behavior !== 'normal') {
    progress('Checking the changed sources');
    if (behavior === 'fail') throw new Error('Source check unavailable');
    await new Promise((done, reject) => {
      held = done;
      announce();
      signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
    });
  }
  return captureProjectInquiry(...args);
};
try {
  ui = journeyWorkbench(
    await createProject(join(directory, 'project'), 'Workshop', 'Workshop'),
    directory,
    { captureInquiry },
  );
  await ui.key('n');
  await ui.text('Sam repairs bicycles. A simulation rehearses possibilities in the digital work.');
  await ui.submit();
  const initial = await ui.ask('Who repairs bicycles?');
  assert.equal(initial.run.status, 'supported');
  const acquired = requests.length;
  behavior = 'hold';
  const started = new Promise((resolve) => {
    announce = resolve;
  });
  await ui.key('e');
  await ui.key('ALT_U');
  await ui.text('A simulation rehearses possibilities in the digital work.');
  const saving = ui.submit();
  await started;
  assert(ui.state.workflow.activity());
  assert.match(ui.term.frame, /Checking corpus/u);
  assert.match(ui.term.frame, /Checking the changed sources/u);
  assert.doesNotMatch(
    ui.term.frame,
    /Answer: Sam|Would answer|Proposed answer/u,
    'An old result never appears during the check',
  );
  await ui.app.handleKey('d', {});
  assert.equal(ui.state.form, null, 'Clarification cannot use an obsolete result');
  await ui.app.handleKey('ESCAPE', {});
  await saving;
  assert.equal(ui.state.workflow.activity(), null);
  assert.equal(ui.state.workflow.current(), null);
  ui.app.draw();
  assert.doesNotMatch(ui.term.frame, /Checking corpus/u);
  assert.equal(requests.length, acquired);
  // Reopening the saved question sees the changed source set and retries safely.
  behavior = 'fail';
  await ui.key('o');
  await ui.choose('Who repairs bicycles?');
  assert.match(ui.term.frame, /Could not check: Source check unavailable/u);
  assert.equal(ui.state.workflow.current(), null);
  assert.equal(ui.state.workflow.activity(), null);
  behavior = 'normal';
  await ui.key('r');
  assert.equal(ui.state.workflow.current().run.status, 'open');
  assert.match(ui.term.frame, /Answer: Still open\./u);
  assert.equal(
    requests.length,
    acquired,
    'Retry has no missing acquisition and makes no model request',
  );
  assert.equal(ui.state.workflow.current().run.projectDigest, ui.state.project.digest);
  console.log(
    'ok background progress, stale proof suppression, disabled confirmation, cancellation, failed-check recovery and frozen-input refresh',
  );
} finally {
  ui?.app.dispose();
  globalThis.fetch = oldFetch;
}
