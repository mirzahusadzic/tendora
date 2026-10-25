/** Execution profiles consume their own argument and preserve suite arguments. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'test-runner-'));
try {
  const path = join(directory, 'run.mjs');
  await writeFile(path, await readFile(new URL('../run.mjs', import.meta.url), 'utf8'));
  await writeFile(
    join(directory, 'suites.mjs'),
    "export const suites = { check: ['capture.mjs'], terminal: ['capture.mjs'], failing: ['failure.mjs'], network: ['network.mjs'], timed: ['quiet.mjs', 'busy-1.mjs', 'busy-2.mjs', 'busy-3.mjs'] };\nexport const alone = ['quiet.mjs'];\n",
  );
  await writeFile(
    join(directory, 'capture.mjs'),
    'console.log(JSON.stringify(process.argv.slice(2)));\n',
  );
  await writeFile(join(directory, 'failure.mjs'), "throw new Error('Suite failed');\n");
  await writeFile(
    join(directory, 'network.mjs'),
    "try { await fetch('http://127.0.0.1:8001/v1/responses'); } catch {}\n",
  );
  // A suite that measures time runs alone, after the others, even with jobs to
  // spare: it must find every other suite of its profile finished.
  for (const n of [1, 2, 3])
    await writeFile(
      join(directory, `busy-${n}.mjs`),
      `import { writeFileSync } from 'node:fs';\nawait new Promise((done) => setTimeout(done, 300));\nwriteFileSync(import.meta.dirname + '/busy-${n}.end', '');\n`,
    );
  await writeFile(
    join(directory, 'quiet.mjs'),
    "import { existsSync } from 'node:fs';\nfor (const n of [1, 2, 3]) if (!existsSync(`${import.meta.dirname}/busy-${n}.end`)) throw new Error(`ran beside busy-${n}`);\n",
  );
  const run = (...args) => spawnSync(process.execPath, [path, ...args], { encoding: 'utf8' });
  const timed = run('timed', '--jobs', '3');
  assert.equal(timed.status, 0, timed.stderr);
  const defaultRun = run();
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  assert.deepEqual(JSON.parse(defaultRun.stdout), []);
  const terminal = run('terminal', '/tmp/screens', '--width', '220');
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.deepEqual(JSON.parse(terminal.stdout), ['/tmp/screens', '--width', '220']);
  const explicit = run('check', '--only', 'case');
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.deepEqual(JSON.parse(explicit.stdout), ['--only', 'case']);
  const unknown = run('missing');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown test profile: missing/);
  assert.equal(unknown.stdout, '');
  const failed = run('failing');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Suite failed/);
  // A worker count that is not a whole number once ran nothing and passed.
  for (const jobs of ['auto', '0', '1.5']) {
    const invalid = run('check', '--jobs', jobs);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /--jobs takes a whole number of at least 1/u);
  }
  const network = run('network');
  assert.notEqual(network.status, 0);
  assert.match(network.stderr, /network.mjs attempted live requests/u);
  console.log(
    'ok test runner forwards suite arguments and propagates unknown profiles, invalid --jobs and failures',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
