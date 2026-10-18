/** Every runnable test is registered once and every fixture import resolves. */
import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { suites } from '../suites.mjs';

const root = new URL('..', import.meta.url);
const registered = Object.values(suites).flat();
assert.equal(
  new Set(registered).size,
  registered.length,
  'A test must belong to exactly one execution profile',
);
const files = (await readdir(root, { recursive: true })).filter((path) => path.endsWith('.mjs'));
const runnable = files.filter(
  (path) => !path.startsWith('support/') && !['run.mjs', 'suites.mjs'].includes(path),
);
assert.deepEqual(
  [...registered].sort(),
  runnable.sort(),
  'Every runnable test must appear in test/suites.mjs',
);
for (const path of files) {
  const url = new URL(path, root),
    source = await readFile(url, 'utf8');
  const references = [
    ...source.matchAll(
      /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s*|\bnew URL\(\s*)['"]([^'"]+)['"]/gu,
    ),
  ]
    .map(([, reference]) => reference)
    .filter((reference) => reference.startsWith('.'));
  for (const reference of references)
    await assert.doesNotReject(access(new URL(reference, url)), `${path} → ${reference}`);
}
const packageJson = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);
assert.equal(packageJson.scripts.check, 'node test/run.mjs');
console.log('ok every test profile is complete, unique and resolves its modules and fixtures');
