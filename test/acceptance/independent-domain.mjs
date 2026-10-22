/** The frozen independent-domain benchmark runs offline on a disposable copy. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

// Raise this floor when the engine improves; never lower it to make a change pass.
const warrantedFloor = 0;
const fixture = 'test/support/evaluation-archive';
const fixtureHash = async () => {
  const hash = createHash('sha256');
  for (const name of (await readdir(fixture, { recursive: true })).sort())
    hash.update(name).update(await readFile(join(fixture, name)).catch(() => ''));
  return hash.digest('hex');
};
const before = await fixtureHash();
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/independent-domain-'));
await promisify(execFile)(
  process.execPath,
  [
    'tools/evaluate-projects.mjs',
    '--manifest',
    'test/support/independent-domain-benchmark.json',
    '--acquisitions',
    'test/support/independent-domain-acquisitions.json',
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
assert.equal(report.results.length, 5, 'Every predeclared question is evaluated');
assert(
  report.results.every((result) => !result.error),
  'Every question reaches a decision',
);
assert.equal(summary.modelRequests, 0);
assert.equal(summary.falseSupport, 0, 'No unwarranted answer is supported');
assert.equal(summary.unknownsPreserved, summary.unknowns, 'Unknowns stay open');
assert(
  summary.warrantedPassed >= warrantedFloor,
  `Warranted answers regressed: ${summary.warrantedPassed} < ${warrantedFloor}`,
);
assert.equal(await fixtureHash(), before, 'The bundled benchmark project is unchanged');
console.log(
  `ok independent-domain benchmark: ${summary.warrantedPassed}/${summary.warranted} warranted, ` +
    `${summary.unknownsPreserved}/${summary.unknowns} unknowns open, no false support (${directory})`,
);
