/** The Python SEMCAT adapter and the PropBank resource match their pins: the
 * adapter's own tests, the installed adapter and runtime against their
 * sources, and the lexicon against what it is built from. Offline. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { penmanPython } from '../../src/models/graph-preparation.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
// What the checks read; a change to any of it reaches this suite.
for (const path of ['python/semcat/adapter', 'python/semcat/UPSTREAM.json', 'vendor/propbank'])
  await access(join(root, path));
const python = await penmanPython();
const run = (...args) => {
  try {
    return execFileSync(python, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    assert.fail(`${args.join(' ')} failed:\n${error.stdout}${error.stderr}`);
  }
};
run('python/semcat/test_manage.py');
assert.match(run('python/semcat/manage.py', 'verify'), /Verified adapter/u);
assert.match(run('vendor/propbank/build.py', '--check'), /verified/u);
console.log('ok dependency sources: SEMCAT adapter and runtime, PropBank lexicon');
