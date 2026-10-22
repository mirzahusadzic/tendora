/** Real process isolation, cancellation and bounded reasoning at 10,000 sourced roles. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProject, saveProject } from '../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import { backgroundProjectInquiry, stopChild } from '../../src/project/inquiries/background.mjs';
import { activeEngineRunIds } from '../../src/project/storage/engine-runs.mjs';
import { journeyWorkbench } from '../support/journey-workbench.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/background-question-'));
let project = await createProject(directory, 'Large question workspace', 'Organization');
const data = structuredClone(project.data),
  root = data.placements[0].id;
for (let i = 1; i < 10000; i++) {
  data.concepts.push({
    id: `c${i}`,
    name: i === 1 ? 'Rigging' : `Responsibility ${i}`,
    passages: [
      i === 1 ? 'The technician inspects the rig.' : 'The microphones amplify the performers.',
    ],
  });
  data.placements.push({ id: `p${i}`, conceptId: `c${i}`, parentId: root });
}
project = await saveProject(project, data);
const captured = JSON.parse(
  await readFile(new URL('../support/theatre-acquisitions.json', import.meta.url)),
);
await retainAcquisitions(
  project,
  captured.entries.map((entry) => ({
    text: entry.text,
    penman: entry.acquisition.penman,
    acquisition: entry.acquisition,
    origin: { kind: 'parser', profile: 'amr-text-acquisition-v1' },
  })),
);
const query = 'Who inspects the rig?',
  progress = [],
  updates = [],
  gaps = [];
let previous = performance.now();
const heartbeat = setInterval(() => {
  const now = performance.now();
  gaps.push(Math.max(0, now - previous - 20));
  previous = now;
}, 20);
const started = performance.now();
let large;
try {
  large = await backgroundProjectInquiry(
    project,
    root,
    query,
    (text) => progress.push(text),
    undefined,
    {
      acquireMissing: false,
      onEngineUpdate: (run) => updates.push(run.status),
    },
  );
  // Include delivery/deserialization of the final result in the responsiveness measurement.
  await delay(30);
} finally {
  clearInterval(heartbeat);
}
assert.equal(large.recording.nodes.length, 10000);
assert.equal(large.recording.sources.length, 9999);
assert.equal(
  large.recording.reasoning.status,
  'limited',
  'The existing inference bound is not disguised as completeness',
);
assert.equal(large.recording.reasoning.answer.complete, false);
assert(
  large.recording.reasoning.calls.every((call) => !['AMR', 'embedding'].includes(call.client)),
);
assert(progress.some((text) => text.startsWith('Checking ')));
assert(updates.includes('limited'));
assert(gaps.length > 20, 'Terminal event-loop heartbeats continue throughout graph work');
const ordered = [...gaps].sort((a, b) => a - b);
const timing = {
  roles: 10000,
  statements: 9999,
  elapsedMs: performance.now() - started,
  heartbeatP95Ms: ordered[Math.floor(ordered.length * 0.95)],
  maxHeartbeatDelayMs: ordered.at(-1),
  fixture: 'Repeated retained statement under distinct roles; no acquisition or embedding service',
};
assert(timing.heartbeatP95Ms < 100, `Terminal responsiveness ${timing.heartbeatP95Ms} ms`);

const ui = journeyWorkbench(project, directory);
try {
  await ui.app.idle();
  const opened = performance.now();
  await ui.state.workflow.show(large.recording.reasoning.runId);
  timing.openResultMs = performance.now() - opened;
  assert.match(ui.term.frame, /Check stopped/u);
  assert.match(ui.term.frame, /some connections were not examined/u);
  assert.doesNotMatch(ui.term.frame, /Select a smaller role|Press [a-z]/u);
  while (ui.state.focus !== 'nodes') await ui.key('TAB');
  const navigation = [];
  for (let i = 0; i < 30; i++) {
    const at = performance.now();
    await ui.key(i % 2 ? 'HOME' : 'DOWN');
    navigation.push(performance.now() - at);
    assert.equal(ui.state.placementId, i % 2 ? root : 'p1');
  }
  navigation.sort((a, b) => a - b);
  timing.resultNavigationP95Ms = navigation[Math.floor(navigation.length * 0.95)];
  // Hosted-runner scheduling varies. Report timings everywhere and enforce the
  // local latency target outside CI; navigation and responsiveness remain checked.
  if (!process.env.CI)
    assert(
      timing.resultNavigationP95Ms < 100,
      `Large result navigation ${timing.resultNavigationP95Ms} ms (budget 100 ms)`,
    );
} finally {
  ui.app.dispose();
}

const scoped = await backgroundProjectInquiry(project, 'p1', query, undefined, undefined, {
  acquireMissing: false,
});
assert.equal(scoped.recording.reasoning.status, 'supported');
const answer = scoped.recording.reasoning.answer.answers[0];
assert.equal(answer.text, 'technician');
assert(answer.derivation.tree);
assert.equal(answer.sourceIds.length, 1);

const controller = new AbortController();
let cancelledAt;
await assert.rejects(
  backgroundProjectInquiry(
    project,
    root,
    query,
    (text) => {
      if (text.startsWith('Checking ') && !controller.signal.aborted) {
        cancelledAt = performance.now();
        controller.abort();
      }
    },
    controller.signal,
    { acquireMissing: false },
  ),
  { name: 'AbortError' },
);
assert(performance.now() - cancelledAt < 100, 'Cancelling does not wait for compilation');
for (let i = 0; i < 150 && (await activeEngineRunIds(project)).length; i++) await delay(20);
assert.deepEqual(await activeEngineRunIds(project), [], 'Cancellation releases the inquiry lease');
await assert.rejects(
  backgroundProjectInquiry({ ...project, digest: 'changed' }, root, query),
  /changed before the question/u,
);
await assert.rejects(
  backgroundProjectInquiry({ ...project, path: `${directory}/absent/project.json` }, root, query),
  /ENOENT/u,
);
// A cancelled child that ignores SIGTERM is still reclaimed within a bounded time.
const stubborn = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); process.send?.('ready'); setInterval(() => {}, 1000);"],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
);
await new Promise((ready) => stubborn.once('message', ready));
const exited = new Promise((done) => stubborn.once('exit', (code, signal) => done(signal)));
stopChild(stubborn, { termAfterMs: 0, killAfterMs: 200 });
assert.equal(
  await Promise.race([exited, delay(5000).then(() => 'alive')]),
  'SIGKILL',
  'A child ignoring SIGTERM is killed',
);
await writeFile(`${directory}/performance.json`, JSON.stringify(timing, null, 2) + '\n');
console.log(
  `ok background questions: 10,000 sourced roles, live progress, bounded completeness, scoped proof, immediate cancellation, SIGKILL escalation, lease cleanup and errors; ${JSON.stringify(timing)}; ${directory}/performance.json`,
);
