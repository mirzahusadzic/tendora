/** Existing sentences and developed material share one atomic language editor. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createProject,
  saveProject,
  openProject,
} from '../../../src/project/authoring/project.mjs';
import { sourceCatalog } from '../../../src/project/authoring/sources.mjs';
import { journeyWorkbench, capturedParser } from '../../support/journey-workbench.mjs';
import { recordedAuthors } from '../../../src/project/authoring/provenance.mjs';
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/unified-statements-'));
const fixture = JSON.parse(
  await readFile(new URL('../../support/theatre-acquisitions.json', import.meta.url)),
);
const originalFetch = globalThis.fetch,
  requests = [];
globalThis.fetch = capturedParser(fixture.entries, requests);
let ui;
try {
  let project = await createProject(join(directory, 'project'), 'Mixed sources', 'Workshop');
  const data = structuredClone(project.data);
  data.concepts[0].passages = ['Sam repairs bicycles.', 'The director coordinates the rehearsal.'];
  data.concepts[0].sourceRefs = [{ text: 'Original workshop notes' }];
  project = await saveProject(project, data);
  const original = sourceCatalog(project.data);
  ui = journeyWorkbench(project, directory);
  await ui.key('n');
  await ui.text('The wardrobe assistant stores the costumes.\nThe lights illuminate the stage.');
  await ui.submit();
  const contribution = ui.state.project.data.contributions[0];
  assert.equal(sourceCatalog(ui.state.project.data).length, 4);
  await ui.selectRole('Workshop');
  await ui.key('ENTER');
  assert.deepEqual(
    ui.state.form.fields.map((f) => f.label),
    ['Role name', 'Description'],
  );
  await ui.key('ALT_U');
  await ui.text('Workshop sources');
  await ui.submit();
  assert.equal(sourceCatalog(ui.state.project.data).length, 4, 'Metadata never edits evidence');
  await ui.key('e');
  assert(ui.state.form.roleStatements);
  assert.deepEqual(
    ui.state.form.fields.map((f) => f.value),
    [
      ...data.concepts[0].passages,
      'The wardrobe assistant stores the costumes.\nThe lights illuminate the stage.',
      '',
    ],
  );
  const before = ui.state.project.digest;
  await ui.key('ALT_U');
  await ui.text('The technician inspects the rig.');
  await ui.key('ESCAPE');
  assert.equal(
    ui.state.project.digest,
    before,
    'Cancel preserves all legacy and developed statements',
  );
  await ui.key('e');
  await ui.key('ALT_U');
  await ui.text('The technician inspects the rig.');
  await ui.key('TAB');
  await ui.key('ALT_U');
  await ui.key('TAB');
  await ui.key('ALT_U');
  await ui.text('The wardrobe assistant stores the costumes.');
  await ui.key('TAB');
  await ui.text('An unavailable reading.');
  const form = ui.state.form;
  ui.term.emit('key', 'CTRL_S', [], {});
  await ui.app.idle();
  await form.execution;
  assert(form.error, 'Unacquired input fails explicitly');
  assert.equal(ui.state.project.digest, before, 'All fields publish together, including removal');
  assert.equal((await openProject(join(directory, 'project'))).digest, before);
  assert.equal(form.fields[0].value, 'The technician inspects the rig.');
  await ui.key('ALT_U');
  await ui.text('The rig supports the lights.');
  await ui.submit();
  const sources = sourceCatalog(ui.state.project.data);
  assert.deepEqual(
    sources.map((s) => s.text),
    [
      'The technician inspects the rig.',
      'The wardrobe assistant stores the costumes.',
      'The rig supports the lights.',
    ],
  );
  assert.equal(
    sources[0].sentenceId,
    original[0].sentenceId,
    'Editing a legacy passage retains its identity',
  );
  assert.deepEqual(sources[0].sourceRefs, original[0].sourceRefs);
  const revised = ui.state.project.data.contributions.find((c) => c.id === contribution.id);
  assert.equal(
    revised.responses[0].id,
    contribution.responses[0].id,
    'Untouched developed source retains identity',
  );
  assert(revised.responses[1].withdrawn, 'Removed developed source is withdrawn');
  // Whatever the workbench writes records its actor, through the editor: the
  // edited passage, the added statement and the earlier developed source.
  const authors = recordedAuthors(ui.state.project.data);
  const added = ui.state.project.data.contributions.find((c) =>
    c.responses.some((r) => r.text === 'The rig supports the lights.'),
  );
  for (const id of [
    `${sources[0].nodeId}/s1`,
    `contribution:${added.id}:${added.responses.find((r) => r.text === 'The rig supports the lights.').id}`,
    `contribution:${contribution.id}:${contribution.responses[0].id}`,
  ])
    assert.deepEqual(
      [authors.get(id)?.author, authors.get(id)?.via],
      ['participant', 'editor'],
      id,
    );
  const saved = ui.state.project.digest,
    count = requests.length;
  await ui.key('e');
  await ui.submit();
  assert.equal(ui.state.project.digest, saved, 'No-op save creates no revision');
  assert.equal(requests.length, count, 'No-op save has no acquisition');
  await ui.key('n');
  assert.equal(ui.state.form.index, ui.state.form.fields.length - 1);
  await ui.key('ESCAPE');
  ui.app.dispose();
  ui = journeyWorkbench(await openProject(join(directory, 'project')), directory);
  await ui.key('e');
  assert.equal(ui.state.form.fields.length, 4);
  await ui.key('ESCAPE');
  const answer = await ui.ask('Who inspects the rig?');
  assert.equal(answer.run.answer.answers[0].text, 'technician');
  await ui.key('ESCAPE'); // Unrelated statements remain in their role, outside the answer view.
  const rows = (section) => [
    ...(section.table?.entries ?? []),
    ...(section.groups ?? []).flatMap(rows),
  ];
  await ui.key('HOME');
  for (let count = 0; count < 30; count++) {
    const view = ui.state.workflow.readingView();
    const selected = view.sections.flatMap(rows).find((row) => row.selected);
    if (selected?.source?.text === 'The wardrobe assistant stores the costumes.') break;
    await ui.key('DOWN');
  }
  await ui.key('ENTER');
  assert.match(ui.term.frame, /The wardrobe assistant stores the costumes\./u);
  await ui.key('e');
  assert.equal(ui.state.form.index, 1, 'Review opens the selected source, not the first statement');
  assert.equal(
    ui.state.form.fields[ui.state.form.index].value,
    'The wardrobe assistant stores the costumes.',
  );
  await ui.key('ESCAPE');
  assert.match(ui.term.frame, /Language reading/u);
  await ui.key('ESCAPE');
  await ui.ask('Who inspects the rig?');
  await ui.key('e');
  await ui.key('ALT_U');
  await ui.submit();
  assert.equal(
    ui.state.workflow.current().run.status,
    'open',
    'Removing a legacy source retracts its answer immediately',
  );
  assert.equal(
    sourceCatalog(ui.state.project.data).length,
    2,
    'Unrelated developed material survives',
  );
  const digestBeforeCancel = ui.state.project.digest;
  ui.app.dispose();
  ui = journeyWorkbench(await openProject(join(directory, 'project')), directory, {
    noColor: false,
  });
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  globalThis.fetch = async (_url, options) => {
    began();
    return new Promise((_resolve, reject) =>
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }),
    );
  };
  await ui.key('n');
  await ui.text('The microphones amplify the performers.');
  const pending = ui.state.form;
  ui.term.emit('key', 'CTRL_S', [], {});
  await ui.app.idle();
  await started;
  assert.match(ui.term.frame, /Saving statements/u);
  assert.match(ui.term.frame, /All edits are saved together\./u);
  assert.doesNotMatch(ui.term.frame, /Esc cancels|keeps your text in the editor/u);
  assert(
    ui.state.viewport.actionHits.some(
      (hit) => hit.inputKey === 'ESCAPE' && /cancel/u.test(hit.description),
    ),
    'Cancellation is documented in the action footer',
  );
  assert.doesNotMatch(ui.term.frame, /Inquiry:|State: Running/u);
  const pendingFrames = [];
  for (const [width, height] of [
    [120, 42],
    [80, 24],
  ]) {
    ui.term.width = width;
    ui.term.height = height;
    ui.term.emit('resize');
    const ansi = join(directory, `source-save-pending-${width}.ansi`);
    await writeFile(ansi, ui.term.frame);
    pendingFrames.push({
      name: `source-save-pending-${width}`,
      width,
      height,
      ansi,
      expect: ['Saving statements', 'All edits are saved together.', 'cancel'],
    });
  }
  const pendingManifest = join(directory, 'state-frames.json');
  await writeFile(
    pendingManifest,
    JSON.stringify(
      {
        provenance:
          'Actual renderer during controlled deferred local acquisition; fetch is stubbed, no network request. Escape cancellation preserves the draft and corpus digest.',
        frames: pendingFrames,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`source save pending captures: ${pendingManifest}`);
  ui.term.emit('key', 'ESCAPE', [], {});
  await ui.app.idle();
  await pending.execution;
  assert.equal(ui.state.project.digest, digestBeforeCancel);
  assert.equal(ui.state.form, pending);
  assert.match(pending.error, /Save cancelled/u);
  assert.equal(pending.fields.at(-1).value, 'The microphones amplify the performers.');
  globalThis.fetch = capturedParser(fixture.entries, requests);
  await ui.submit();
  assert(
    sourceCatalog(ui.state.project.data).some(
      (s) => s.text === 'The microphones amplify the performers.',
    ),
  );
  console.log(
    'ok unified statements: mixed old/new evidence, metadata isolation, cancel, atomic retry, identity, no-op, reload and answer retraction',
  );
} finally {
  ui?.app.dispose();
  globalThis.fetch = originalFetch;
}
