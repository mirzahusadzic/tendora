/** The documented demo copy is repeatable, never nests, and a reset replaces
 * only a copy of the demo: never the snapshot, a folder holding the
 * repository, or a directory of anything else (on 2026-10-25 a reset given
 * `.proj` replaced a checkout's projects). Resets run only inside this
 * test's temporary directory; the repository's own paths are checked through
 * the guard, never by running a reset on them. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { refuseTarget } from '../../tools/demo-target.mjs';

const run = promisify(execFile);
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/payments-demo-copy-'));
const target = join(directory, 'payments-demo'),
  copy = (...args) =>
    run(process.execPath, ['tools/payments-demo.mjs', '--target', target, ...args]);
try {
  // Help, and an unknown option refused without a stack (docs review 2026-10-25, #6).
  const help = await run(process.execPath, ['tools/payments-demo.mjs', '--help']);
  assert.match(help.stdout, /^Usage: npm run demo -- \[--reset\] \[--target <directory>\]\n/u);
  await assert.rejects(
    run(process.execPath, ['tools/payments-demo.mjs', '--nope']),
    (error) =>
      error.code === 2 &&
      error.stdout === '' &&
      /^Error: Unknown option '--nope'/u.test(error.stderr) &&
      !/\n\s+at /u.test(error.stderr),
  );
  const bundled = await readFile('demo/payments-on-call/project.json', 'utf8');
  const demoId = JSON.parse(bundled).id;
  await copy();
  assert.equal(await readFile(join(target, 'project.json'), 'utf8'), bundled);
  const entries = (await readdir(target)).sort();
  assert.match((await copy()).stdout, /already exists, the same as the bundled demo/u);
  // A copy edited, or made from an older demo, is kept, and says how to renew it.
  const edited = JSON.stringify({ ...JSON.parse(bundled), name: 'Edited' }) + '\n';
  await writeFile(join(target, 'project.json'), edited);
  const repeated = await copy();
  assert.match(
    repeated.stdout,
    /differs from the bundled demo \(edited, or made from an older one\) and was left unchanged\. The tour expects the bundled demo: run `npm run demo -- --reset`/u,
  );
  assert.deepEqual((await readdir(target)).sort(), entries, 'A repeated copy does not nest');
  assert.equal(await readFile(join(target, 'project.json'), 'utf8'), edited);
  await copy('--reset');
  assert.equal(await readFile(join(target, 'project.json'), 'utf8'), bundled);
  assert.deepEqual((await readdir(directory)).sort(), ['payments-demo'], 'No staging remains');

  // A reset leaves anything that is not a copy of the demo as it is.
  for (const [name, files] of [
    ['other-project', { 'project.json': JSON.stringify({ id: 'another', name: 'Mine' }) }],
    ['a-folder', { 'notes.txt': 'kept' }],
    ['unreadable', { 'project.json': '{' }],
  ]) {
    const at = join(directory, name);
    await mkdir(at);
    for (const [file, text] of Object.entries(files)) await writeFile(join(at, file), text);
    await assert.rejects(
      run(process.execPath, ['tools/payments-demo.mjs', '--reset', '--target', at]),
      /not a copy of the demo, so it was left unchanged/u,
    );
    for (const [file, text] of Object.entries(files))
      assert.equal(await readFile(join(at, file), 'utf8'), text, `${name} is unchanged`);
  }

  // The repository's own paths, through the guard alone.
  const root = resolve('.'),
    source = resolve('demo/payments-on-call');
  const guard = (path, extra = {}) =>
    refuseTarget({ target: resolve(path), root, source, demoId, exists: false, ...extra });
  for (const path of ['demo/payments-on-call', 'demo/payments-on-call/engine', 'demo'])
    assert.match(guard(path), /cannot replace the bundled snapshot/u, path);
  for (const path of ['.', dirname(root)])
    assert.match(guard(path), /bundled snapshot|a folder holding the repository/u, path);
  assert.match(
    refuseTarget({ target: dirname(root), root, source: '/elsewhere', demoId, exists: false }),
    /a folder holding the repository/u,
  );
  assert.match(
    guard('.proj', { exists: true, entries: ['my-project'], manifest: null }),
    /not a copy of the demo/u,
    'A reset of .proj itself is refused',
  );
  assert.equal(guard('.proj/payments-demo'), null);
  assert.equal(
    guard('.proj/payments-demo', { exists: true, entries: ['project.json'], manifest: bundled }),
    null,
  );
  console.log(
    'ok payments demo copy: create, repeat without nesting, reset only a copy of the demo, guards',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
