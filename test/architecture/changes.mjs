/** A change reaches the suites that depend on it, through imports, URLs and
 * named repository paths; the runner, the suite list and the package reach all. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  affectedSuites,
  changedFiles,
  dependencies,
  formatTargets,
  root,
} from '../../tools/changes.mjs';
import { suites } from '../suites.mjs';

// Paths built from parts: a path named whole would make this suite depend on it.
const docs = ['docs', 'setup.md'].join('/');
const reached = (...changed) => affectedSuites(changed, suites.check).map(({ suite }) => suite);

const recoil = reached('src/project/inquiries/recoil.mjs');
assert(recoil.includes('project/recoil.mjs'), 'A module reaches the suite that imports it');
assert(!recoil.includes('tui/scale.mjs'), 'and not suites that never reach it');
const matcher = reached('src/amr/hrg-query.mjs');
assert(matcher.includes('acceptance/payments.mjs'), 'through the modules a suite reaches');
assert(matcher.includes('amr/hrg.mjs'));
const demo = reached('.proj/payments-on-call/material.sqlite');
assert(demo.includes('project/examples.mjs'), 'A named directory reaches its files');
assert(demo.includes('acceptance/payments.mjs'));
assert(!demo.includes('amr/hrg.mjs'));
assert(reached('test/engine/cloze.mjs').includes('engine/cloze.mjs'), 'A suite reaches itself');
assert.deepEqual(reached(docs), [], 'Documentation reaches no suite');
for (const path of ['test/run.mjs', 'package.json', 'tools/changes.mjs'])
  assert.equal(reached(path).length, suites.check.length, `${path} reaches every suite`);
assert(
  reached('test/suites.mjs').length < suites.check.length,
  'The suite list reaches only the suites it adds',
);
assert.deepEqual(
  formatTargets(['src/engine/cloze.mjs', 'tmp/x.mjs', 'notes/draft.md', docs]),
  ['src/engine/cloze.mjs', docs],
  'Only the files the format check covers',
);
// A module deleted or renamed still reaches the suites that import it, so
// check:changed runs them (they fail) instead of passing without them.
const fixture = join('tmp', `changes-deleted-${process.pid}`);
await mkdir(join(root, fixture), { recursive: true });
try {
  // Built from parts, so the layout check does not take it for this file's import.
  const statement = ['import { gone } from', "'./gone.mjs';\n"].join(' ');
  await writeFile(join(root, fixture, 'suite.mjs'), statement);
  assert(
    dependencies(join(fixture, 'suite.mjs')).has(join(fixture, 'gone.mjs')),
    'A missing import is still a dependency',
  );
  // A fixture named in a string and then deleted, file or directory, still
  // reaches the suite that names it (review 2026-10-25, #5).
  const gone = ['test', 'support', `changes-gone-${process.pid}`].join('/');
  await writeFile(
    join(root, fixture, 'names.mjs'),
    `const fixture = '${gone}.json';\nconst directory = '${gone}';\n`,
  );
  const suite = join('..', fixture, 'names.mjs');
  for (const changed of [`${gone}.json`, `${gone}/inside.json`])
    assert.deepEqual(
      affectedSuites([changed], [suite]).map((entry) => entry.suite),
      [suite],
      `A deleted ${changed} reaches the suite that names it`,
    );
} finally {
  await rm(join(root, fixture), { recursive: true, force: true });
}
// Staged deletions and renames are changes; a rename is its old path and its new.
await mkdir(join(root, 'tmp'), { recursive: true });
const repository = await mkdtemp(resolve(root, 'tmp', 'changes-git-'));
try {
  const git = (...args) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' });
  git('init', '-q');
  for (const name of ['kept.mjs', 'deleted.mjs', 'renamed.mjs'])
    await writeFile(join(repository, name), `export const name = '${name}';\n`);
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  git('rm', '-q', 'deleted.mjs');
  git('mv', 'renamed.mjs', 'moved.mjs');
  assert.deepEqual(
    changedFiles({ cwd: repository }).sort(),
    ['deleted.mjs', 'moved.mjs', 'renamed.mjs'],
    'A staged deletion and both sides of a staged rename are changed',
  );
} finally {
  await rm(repository, { recursive: true, force: true });
}
console.log(
  'ok changes reach their suites: imports, URLs, named paths, deleted modules and fixtures, staged deletions and renames; added suites; the runner reaches all',
);
