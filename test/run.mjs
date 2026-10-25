/** Run contract suites; each owns its temporary data and cleanup.
 *
 *   node test/run.mjs [profile] [--changed [--since <ref>]] [--jobs <n>] [suite args]
 *
 * Suites run in parallel worker processes (--jobs, default: cores less two, at
 * most 8), slowest first by their last recorded time (tmp/suite-times.json).
 * --changed runs only the suites a change reaches (tools/changes.mjs): files
 * that differ from HEAD, or from <ref>, and new files. --jobs 1 runs every
 * suite in this process, one after another.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as registry from './suites.mjs';

const { suites } = registry;
// Suites that measure time run alone, after the others: a budget measured
// beside other suites measures the machine, not the code.
const alone = new Set(registry.alone ?? []);

const timesPath = fileURLToPath(new URL('../tmp/suite-times.json', import.meta.url));
const take = (name, arity = 1) => {
  const at = process.argv.indexOf(name, 2);
  return at < 0 ? null : process.argv.splice(at, arity + 1).slice(1);
};
const worker = take('--suite')?.[0];
const workerProfile = take('--profile')?.[0] ?? null;
const since = take('--since')?.[0] ?? null;
const changedOnly = Boolean(take('--changed', 0));
const jobsText = take('--jobs')?.[0];
const jobs = jobsText ? Number(jobsText) : Math.max(1, Math.min(8, availableParallelism() - 2));
if (!Number.isInteger(jobs) || jobs < 1)
  throw new Error(`--jobs takes a whole number of at least 1, not ${jobsText}`);
const profile = worker ? null : (process.argv[2] ?? 'check');
if (profile && !Object.hasOwn(suites, profile)) throw new Error(`Unknown test profile: ${profile}`);
// A profile selects suites; remaining arguments belong to those suites.
if (profile && process.argv.length > 2) process.argv.splice(2, 1);

async function runSuite(path) {
  const fetch = globalThis.fetch;
  const unexpected = [];
  globalThis.fetch = async (url) => {
    unexpected.push(String(url));
    throw new Error(`Unexpected network request in an offline test: ${url}`);
  };
  const timeoutMs = ['acceptance:hand', 'acceptance:tendora'].includes(profile ?? workerProfile)
    ? 600_000
    : ['project/background.mjs', 'project/role-matching.mjs'].includes(path)
      ? 180_000
      : 60_000;
  const timeout = setTimeout(() => {
    console.error(`Timed out after ${timeoutMs / 1000} seconds: ${path}`);
    process.exit(1);
  }, timeoutMs);
  try {
    await import(new URL(path, import.meta.url));
    if (unexpected.length)
      throw new Error(`${path} attempted live requests: ${unexpected.join(', ')}`);
  } finally {
    clearTimeout(timeout);
    globalThis.fetch = fetch;
  }
}

if (worker) await runSuite(worker);
else {
  let selected = suites[profile];
  if (changedOnly || since) {
    const { affectedSuites, changedFiles } = await import('../tools/changes.mjs');
    const changed = changedFiles({ since: since ?? 'HEAD' });
    const affected = affectedSuites(changed, selected, { since: since ?? 'HEAD' });
    console.error(
      `${changed.length} changed files reach ${affected.length} of ${selected.length} suites` +
        (affected.length ? ':' : '.'),
    );
    for (const { suite, because } of affected) console.error(`  ${suite}  (${because})`);
    selected = affected.map(({ suite }) => suite);
  }
  if (jobs <= 1 || selected.length <= 1)
    for (const path of selected) {
      console.error(`Running ${path}`);
      await runSuite(path);
    }
  else await runParallel(selected);
}

/** Each suite in its own process; its output is printed whole when it ends. */
async function runParallel(selected) {
  const started = performance.now();
  const failures = [];
  let passed = 0,
    times = {};
  try {
    times = JSON.parse(readFileSync(timesPath, 'utf8'));
  } catch {
    // No record yet: the order is the suite list's.
  }
  const run = (path) =>
    new Promise((done) => {
      const began = performance.now();
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          '--suite',
          path,
          '--profile',
          profile,
          ...process.argv.slice(2),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '',
        err = '';
      child.stdout.on('data', (bytes) => (out += bytes));
      child.stderr.on('data', (bytes) => (err += bytes));
      child.on('close', (code) => {
        const seconds = ((performance.now() - began) / 1000).toFixed(1);
        if (code === 0) {
          times[path] = Number(seconds);
          passed++;
        }
        console.error(`${code === 0 ? 'Passed' : 'FAILED'} ${path} (${seconds} s)`);
        process.stdout.write(out);
        if (code !== 0) {
          process.stderr.write(err);
          failures.push(path);
        }
        done();
      });
    });
  // Slowest first, so the longest suite does not start last.
  const queue = selected
    .filter((path) => !alone.has(path))
    .sort((a, b) => (times[b] ?? Infinity) - (times[a] ?? Infinity));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      while (next < queue.length) await run(queue[next++]);
    }),
  );
  for (const path of selected) if (alone.has(path)) await run(path);
  try {
    mkdirSync(fileURLToPath(new URL('../tmp/', import.meta.url)), { recursive: true });
    writeFileSync(timesPath, JSON.stringify(times, null, 2) + '\n');
  } catch {
    // The record only orders the next run.
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  // Passes are counted, not inferred: a suite that never ran is not a pass.
  console.error(
    `${passed} of ${selected.length} suites passed in ${seconds} s` +
      (failures.length ? `; failed: ${failures.join(', ')}` : ''),
  );
  if (passed !== selected.length) process.exitCode = 1;
}
