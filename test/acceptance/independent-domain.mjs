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
const benchmarks = [
  {
    name: 'independent-domain',
    manifest: 'test/support/independent-domain-benchmark.json',
    acquisitions: 'test/support/independent-domain-acquisitions.json',
    fixtures: ['test/support/evaluation-archive'],
    questions: 5,
    warrantedFloor: 0,
    confirmationFloor: 2,
    confirmationFalseSupportCeiling: 0,
  },
  {
    name: 'blind-domain',
    manifest: 'test/support/blind-domain-benchmark.json',
    acquisitions: 'test/support/blind-domain-acquisitions.json',
    fixtures: ['test/support/blind-archive-water', 'test/support/blind-bracken'],
    questions: 20,
    warrantedFloor: 0,
    confirmationFloor: 2,
    // “Who had collected the key?” is offered “The freezer van collects booked
    // crates”: a different-word proposal the author must reject.
    confirmationFalseSupportCeiling: 1,
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
  await promisify(execFile)(
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
  assert.equal(
    summary.unknownsPreserved,
    summary.unknowns,
    `${benchmark.name}: unknowns stay open`,
  );
  assert(
    summary.warrantedPassed >= benchmark.warrantedFloor,
    `${benchmark.name}: warranted answers regressed: ${summary.warrantedPassed} < ${benchmark.warrantedFloor}`,
  );
  assert(
    summary.oneConfirmationAway >= benchmark.confirmationFloor,
    `${benchmark.name}: answers one confirmation away regressed: ${summary.oneConfirmationAway} < ${benchmark.confirmationFloor}`,
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
    // Twice the recorded engine time, scaled to this machine's speed.
    const budget = 2 * recorded.engineMs * Math.max(1, calibration / snapshot.calibrationMs);
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
