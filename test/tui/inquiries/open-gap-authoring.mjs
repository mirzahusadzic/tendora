/** Explicitly developing an entirely open relation retains an anchor, never a claim. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createProject, openProject } from '../../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../../src/project/storage/acquisitions.mjs';
import { contributionSources } from '../../../src/project/authoring/development.mjs';
import { journeyWorkbench } from '../../support/journey-workbench.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/open-gap-authoring-'));
const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url) => {
  requests.push(String(url));
  throw new Error('Frozen acquisition only');
};
let ui;
try {
  const project = await createProject(join(directory, 'project'), 'Open connection', 'Workshop');
  const fixtures = JSON.parse(
    await readFile(new URL('../../support/theatre-acquisitions.json', import.meta.url)),
  );
  const question = 'Does Sam repair bicycles?';
  const statement = 'The technician inspects the rig.';
  await retainAcquisitions(
    project,
    [question, statement].map((text) => {
      const entry = fixtures.entries.find((e) => e.text === text);
      assert(entry?.acquisition?.penman, text);
      return {
        text,
        penman: entry.acquisition.penman,
        acquisition: entry.acquisition,
        origin: { kind: 'test-replay', file: 'theatre-acquisitions.json' },
      };
    }),
  );
  ui = journeyWorkbench(project, directory);
  const checked = await ui.ask(question);
  assert.equal(checked.run.status, 'open');
  assert.equal(checked.run.answer.partial.parts.length, 0);
  assert.equal(
    (ui.state.project.data.contributions ?? []).length,
    0,
    'Asking does not author a contribution',
  );
  const rows = (section) => [
    ...(section.rowChoices ?? []),
    ...(section.table?.entries ?? []),
    ...(section.groups ?? []).flatMap(rows),
  ];
  const choices = ui.state.workflow
    .readingView()
    .sections.flatMap(rows)
    .filter((r) => r.choiceIndex !== undefined);
  const index = choices.findIndex((r) => r.openings?.some((o) => o.kind === 'relation'));
  assert(index >= 0);
  const opening = choices[index].openings[0];
  const target = checked.run.answer.partial.openings.find((o) => o.id === opening.id);
  assert(target?.anchor?.edgeId);
  await ui.key('HOME');
  for (let i = 0; i < index; i++) await ui.key('DOWN');
  // Selecting the gap presents it and its actions; Enter acts on it.
  assert.equal(ui.state.workflow.readingView().title, 'Develop question');
  assert.doesNotMatch(ui.readingText(), /↳ /u, 'A gap without recorded statements claims nothing');
  assert(
    ui.state.workflow
      .actions()
      .some((a) => a.key === 'ENTER' && a.description === 'add statement here'),
  );
  assert(
    !ui.state.workflow.actions().some((a) => a.key === 'c' && a.pane === 'reading'),
    'Continuation is offered only where a recorded opening can carry it',
  );
  assert.doesNotMatch(ui.term.frame, /c continue question/u);
  await ui.key('ENTER');
  assert.equal(ui.state.form.title, 'Add statements');
  const retained = ui.state.project.data.contributions.find((c) => c.question?.text === question);
  assert(retained);
  assert.equal(retained.partial.parts.length, 0);
  assert(
    retained.partial.aporias.some(
      (o) => o.anchor.edgeId === target.anchor.edgeId && o.state === 'open',
    ),
  );
  assert.deepEqual(retained.responses, []);
  assert(
    contributionSources(ui.state.project.data)
      .filter((s) => s.development.contributionId === retained.id)
      .every((s) => s.development.asserted === false),
  );
  await ui.text(statement);
  await ui.submit();
  const authored = ui.state.project.data.contributions.find((c) =>
    c.responses.some((r) => r.text === statement),
  );
  assert.equal(authored.anchor.contributionId, retained.id);
  assert.equal(authored.anchor.edgeId, target.anchor.edgeId);
  assert.equal(authored.anchor.from, target.anchor.from);
  assert.equal(authored.anchor.to, target.anchor.to);
  assert.equal(authored.anchor.role, target.anchor.role);
  const cold = await openProject(join(directory, 'project'));
  assert.deepEqual(
    cold.data.contributions.find((c) => c.id === retained.id),
    retained,
  );
  assert(
    requests.every((url) => url.endsWith('/embed/texts')),
    'No AMR request is allowed',
  );
  console.log(
    'ok keyboard n retains a wholly open connection and anchors language without asserting its question; no dead continue action; selection presents the gap',
  );
} finally {
  ui?.app.dispose();
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
