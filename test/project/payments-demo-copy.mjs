/** The documented demo copy is repeatable and never nests or clobbers the snapshot. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/payments-demo-copy-'));
const target = join(directory, 'payments-demo'),
  copy = (...args) =>
    run(process.execPath, ['tools/payments-demo.mjs', '--target', target, ...args]);
try {
  const bundled = await readFile('.proj/payments-on-call/project.json');
  await copy();
  assert.deepEqual(await readFile(join(target, 'project.json')), bundled);
  const entries = (await readdir(target)).sort();
  assert.match((await copy()).stdout, /already exists, the same as the bundled demo/u);
  // A copy edited, or made from an older demo, is kept, and says how to renew it.
  await writeFile(join(target, 'project.json'), '{"edited":true}\n');
  const repeated = await copy();
  assert.match(
    repeated.stdout,
    /differs from the bundled demo \(edited, or made from an older one\) and was left unchanged\. The tour expects the bundled demo: run `npm run demo -- --reset`/u,
  );
  assert.deepEqual((await readdir(target)).sort(), entries, 'A repeated copy does not nest');
  assert.equal(await readFile(join(target, 'project.json'), 'utf8'), '{"edited":true}\n');
  await copy('--reset');
  assert.deepEqual(await readFile(join(target, 'project.json')), bundled);
  assert.deepEqual((await readdir(directory)).sort(), ['payments-demo'], 'No staging remains');
  for (const unsafe of ['.proj/payments-on-call', '.proj', '.proj/payments-on-call/engine'])
    await assert.rejects(
      run(process.execPath, ['tools/payments-demo.mjs', '--reset', '--target', unsafe]),
      /cannot replace the bundled snapshot/u,
    );
  console.log('ok payments demo copy: create, repeat without nesting, reset, snapshot guard');
} finally {
  await rm(directory, { recursive: true, force: true });
}
