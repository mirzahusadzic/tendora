/** The frozen held-out benchmarks run offline on disposable copies. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
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
  assert.equal(
    await fixtureHash(benchmark.fixtures),
    before,
    `${benchmark.name}: the bundled benchmark projects are unchanged`,
  );
  console.log(
    `ok ${benchmark.name} benchmark: ${summary.warrantedPassed}/${summary.warranted} warranted, ` +
      `${summary.unknownsPreserved}/${summary.unknowns} unknowns open, no false support; ` +
      `${summary.oneConfirmationAway} more one confirmation away (${directory})`,
  );
}
