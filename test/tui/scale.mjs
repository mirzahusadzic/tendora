/** Exercise actual role navigation and authoring controls at the requested project size. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createProject, saveProject, openProject } from '../../src/project/authoring/project.mjs';
import { journeyWorkbench } from '../support/journey-workbench.mjs';
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/editor-scale-'));
let project = await createProject(directory, 'Large workspace', 'Organization');
const data = structuredClone(project.data),
  root = data.placements[0].id;
for (let i = 1; i < 10000; i++) {
  data.concepts.push({
    id: `c${i}`,
    name: `Responsibility ${i}`,
    passages: [`Team ${i} maintains system ${i}.`],
  });
  data.placements.push({
    id: `p${i}`,
    conceptId: `c${i}`,
    parentId: i < 100 ? root : `p${1 + (i % 99)}`,
  });
}
project = await saveProject(project, data);
let at = performance.now();
project = await openProject(directory);
const coldOpen = performance.now() - at;
at = performance.now();
const ui = journeyWorkbench(project, directory);
await ui.app.idle();
const startup = performance.now() - at;
try {
  const samples = [];
  for (let i = 0; i < 80; i++) {
    at = performance.now();
    await ui.key(i % 2 ? 'DOWN' : 'PAGE_DOWN');
    samples.push(performance.now() - at);
  }
  await ui.key('END');
  assert.equal(ui.state.placementId, ui.state.workflow.roles().at(-1).id);
  await ui.key('ENTER');
  assert.equal(ui.state.form.fields.length, 2);
  await ui.key('ESCAPE');
  await ui.key('e');
  assert.equal(
    ui.state.form.fields[0].value,
    ui.state.project.data.concepts.find((c) => c.id === ui.state.workflow.role().conceptId)
      .passages[0],
  );
  await ui.key('ESCAPE');
  await ui.key('a');
  const typing = [];
  for (const char of 'Who maintains the system?') {
    at = performance.now();
    await ui.text(char);
    typing.push(performance.now() - at);
  }
  await ui.key('ESCAPE');
  await ui.key('o');
  assert.match(ui.term.frame, /Who maintains the system/u);
  const stats = (xs) => {
    xs.sort((a, b) => a - b);
    return {
      medianMs: xs[Math.floor(xs.length / 2)],
      p95Ms: xs[Math.floor(xs.length * 0.95)],
      maxMs: xs.at(-1),
    };
  };
  const result = {
    concepts: 10000,
    sourceStatements: 9999,
    coldOpenMs: coldOpen,
    startupMs: startup,
    navigation: stats(samples),
    typing: stats(typing),
  };
  await writeFile(`${directory}/performance.json`, JSON.stringify(result, null, 2) + '\n');
  // Hosted-runner scheduling varies; report everywhere, enforce the latency target locally.
  if (!process.env.CI) {
    assert(result.navigation.p95Ms < 100, `Navigation p95 ${result.navigation.p95Ms} ms`);
    assert(result.typing.p95Ms < 100, `Typing p95 ${result.typing.p95Ms} ms`);
  }
  console.log(`ok 10,000-concept editor: ${JSON.stringify(result)}; ${directory}/performance.json`);
} finally {
  ui.app.dispose();
}
