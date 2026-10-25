/** The frozen benchmarks run offline on disposable copies. Their questions were
 * held out when written; since the 2026-10-23 diagnosis they are development
 * sets. A committed snapshot records each question's behaviour and the engine
 * time, so a refactor shows any change in answers, evidence, gaps or cost.
 * Regenerate it deliberately: UPDATE_DEVELOPMENT_SNAPSHOT=1 node <this file>.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

// Raise a floor when the engine improves; never lower it to make a change pass.
// reachableFloor counts answers supported automatically or one confirmation away.
// warrantedFloor was lowered once, on 2026-10-25 (review #2 and #3): answers the
// engine had read in through shared wording became proposals a person confirms.
// Each moved to one confirmation away; no reachableFloor changed.
const benchmarks = [
  {
    name: 'independent-domain',
    manifest: 'test/support/independent-domain-benchmark.json',
    acquisitions: 'test/support/independent-domain-acquisitions.json',
    fixtures: ['test/support/evaluation-archive'],
    questions: 5,
    warrantedFloor: 0,
    reachableFloor: 2,
    confirmationFalseSupportCeiling: 0,
  },
  {
    name: 'blind-domain',
    manifest: 'test/support/blind-domain-benchmark.json',
    acquisitions: 'test/support/blind-domain-acquisitions.json',
    fixtures: ['test/support/blind-archive-water', 'test/support/blind-bracken'],
    questions: 20,
    warrantedFloor: 0,
    reachableFloor: 2,
    // “Who had collected the key?” is offered “The freezer van collects booked
    // crates”: a different-word proposal the author must reject.
    confirmationFalseSupportCeiling: 1,
  },
  {
    // The development questions reworded blind (test/support/requestioning/),
    // each keeping its original answer key.
    name: 'requestioned',
    manifest: 'test/support/requestioned-benchmark.json',
    acquisitions: 'test/support/requestioned-acquisitions.json',
    fixtures: [
      'test/support/evaluation-archive',
      'test/support/blind-archive-water',
      'test/support/blind-bracken',
    ],
    questions: 46,
    warrantedFloor: 1,
    reachableFloor: 6,
    confirmationFalseSupportCeiling: 0,
  },
];
const fixtureHash = async (fixtures) => {
  const hash = createHash('sha256');
  for (const fixture of fixtures)
    for (const name of (await readdir(fixture, { recursive: true })).sort())
      hash.update(name).update(await readFile(join(fixture, name)).catch(() => ''));
  return hash.digest('hex');
};
// A fixed workload measures this machine, so the time budget scales with it.
const calibrate = () => {
  const started = performance.now();
  for (let round = 0; round < 5; round++) {
    const index = new Map();
    for (let i = 0; i < 200_000; i++) index.set(`node-${i % 5000}#${i}`, [i, String(i)]);
    let hash = createHash('sha256');
    for (const [key] of index) hash = hash.update(key);
    hash.digest('hex');
  }
  return performance.now() - started;
};
const sorted = (values) => [...values].sort();
// Behaviour that a refactor must keep; an improvement changes it on purpose.
const behaviour = (report) =>
  report.results.map((result) => ({
    id: `${result.project}/${result.id}`,
    status: result.status,
    answers: sorted(result.answers.map((answer) => answer.text)),
    evidence: sorted(new Set(result.sources.map((source) => source.text))),
    openings: sorted(
      new Set(
        (result.openings ?? []).map((opening) =>
          [opening.kind, opening.state, opening.from ?? opening.concept, opening.role, opening.to]
            .filter(Boolean)
            .join(' '),
        ),
      ),
    ),
    ...(result.confirmation
      ? {
          proposals: result.confirmation.trials.map((trial) => ({
            source: trial.source,
            status: trial.status,
            answers: sorted(trial.answers),
          })),
        }
      : {}),
  }));
const snapshotPath = 'test/support/development-snapshot.json';
const updating = process.env.UPDATE_DEVELOPMENT_SNAPSHOT === '1';
const snapshot = updating
  ? { version: 1, calibrationMs: 0, benchmarks: {} }
  : JSON.parse(await readFile(snapshotPath, 'utf8'));
const calibration = Math.min(calibrate(), calibrate(), calibrate());
await mkdir('tmp', { recursive: true });
for (const benchmark of benchmarks) {
  const before = await fixtureHash(benchmark.fixtures);
  const directory = await mkdtemp(resolve(`tmp/${benchmark.name}-`));
  const running = promisify(execFile)(
    process.execPath,
    [
      'tools/evaluate-projects.mjs',
      '--manifest',
      benchmark.manifest,
      '--acquisitions',
      benchmark.acquisitions,
      '--copy-to',
      join(directory, 'run'),
      '--report',
      'report.json',
    ],
    { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
  );
  // The machine's speed while the benchmark runs, sampled beside it about once
  // a second: a busy moment (other suites, a shared runner) slows both, so the
  // budget measures the engine, not the moment.
  const samples = [];
  let finished = false;
  running.then(
    () => (finished = true),
    () => (finished = true),
  );
  while (!finished) {
    samples.push(calibrate());
    await new Promise((done) => setTimeout(done, 1000));
  }
  await running;
  const during = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? calibration;
  const report = JSON.parse(await readFile(join(directory, 'run', 'evidence', 'report.json')));
  const { summary } = report;
  assert.equal(report.mode, 'disposable-copy');
  assert.equal(
    report.results.length,
    benchmark.questions,
    `${benchmark.name}: every predeclared question is evaluated`,
  );
  assert(
    report.results.every((result) => !result.error),
    `${benchmark.name}: every question reaches a decision`,
  );
  assert.equal(summary.modelRequests, 0);
  assert.equal(summary.falseSupport, 0, `${benchmark.name}: no unwarranted answer is supported`);
  assert.equal(summary.wrongSupport, 0, `${benchmark.name}: no supported answer is wrong`);
  assert.equal(
    summary.unknownsPreserved,
    summary.unknowns,
    `${benchmark.name}: unknowns stay open`,
  );
  assert(
    summary.warrantedPassed >= benchmark.warrantedFloor,
    `${benchmark.name}: warranted answers regressed: ${summary.warrantedPassed} < ${benchmark.warrantedFloor}`,
  );
  // Answers supported automatically or one confirmation away; an answer moving
  // from the second to the first keeps this total.
  const reachable = summary.warrantedPassed + summary.oneConfirmationAway;
  assert(
    reachable >= benchmark.reachableFloor,
    `${benchmark.name}: reachable answers regressed: ${reachable} < ${benchmark.reachableFloor}`,
  );
  assert(
    summary.confirmationFalseSupport <= benchmark.confirmationFalseSupportCeiling,
    `${benchmark.name}: more proposals would turn an unknown into an answer: ${summary.confirmationFalseSupport}`,
  );
  const engineMs = report.results.reduce((total, result) => total + result.elapsedMs, 0);
  if (updating) snapshot.benchmarks[benchmark.name] = { engineMs, results: behaviour(report) };
  else {
    const recorded = snapshot.benchmarks[benchmark.name];
    assert.deepEqual(
      behaviour(report),
      recorded.results,
      `${benchmark.name}: behaviour changed; if intended, regenerate ${snapshotPath}`,
    );
    // Twice the recorded engine time, scaled to this machine's speed as it
    // was while the benchmark ran.
    const speed = Math.max(calibration, during);
    const budget = 2 * recorded.engineMs * Math.max(1, speed / snapshot.calibrationMs);
    assert(
      engineMs <= budget,
      `${benchmark.name}: engine time ${Math.round(engineMs)} ms exceeds its budget of ${Math.round(budget)} ms`,
    );
  }
  assert.equal(
    await fixtureHash(benchmark.fixtures),
    before,
    `${benchmark.name}: the bundled benchmark projects are unchanged`,
  );
  console.log(
    `ok ${benchmark.name} benchmark: ${summary.warrantedPassed}/${summary.warranted} warranted, ` +
      `${summary.unknownsPreserved}/${summary.unknowns} unknowns open, no false support; ` +
      `${summary.oneConfirmationAway} more one confirmation away; ` +
      `engine ${Math.round(engineMs)} ms (${directory})`,
  );
}
if (updating) {
  snapshot.calibrationMs = Math.round(calibration);
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Wrote ${snapshotPath}`);
}
