/** What changed, and which suites and formatted files it reaches.
 *
 * A change is a file that differs from a base revision (HEAD by default) or is
 * new and not ignored. A suite is reached when a changed file is among its
 * dependencies: what it imports, what it names with `new URL(…,
 * import.meta.url)`, and the repository paths it names in strings (fixtures,
 * spawned tools, bundled projects), followed through every module it reaches.
 * A change to the runner or the package reaches every suite; a change to the
 * suite list reaches the suites it adds and the layout check. A file no suite
 * depends on reaches every suite, unless it is documentation.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const everything = new Set([
  'package.json',
  'package-lock.json',
  '.prettierrc.json',
  'test/run.mjs',
  'tools/changes.mjs',
]);
const suiteList = 'test/suites.mjs',
  layoutSuite = 'architecture/test-layout.mjs';
// A pattern, not a quoted path: a quoted path here would be a dependency.
const documentation = (path) => /\.md$|^docs\/|^(LICENSE|THIRD_PARTY_NOTICES)/u.test(path);

// A deleted file is a change, staged or not, and a rename is two: its old path
// and its new (review 2026-10-25, #5).
export function changedFiles({ since = 'HEAD', cwd = root } = {}) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
  return [
    ...new Set([
      ...git('diff', '--name-only', '--no-renames', since),
      ...git('ls-files', '--others', '--exclude-standard'),
    ]),
  ];
}

const imports = [
  /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gu,
  /\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/gu,
  /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/gu,
];
const named = /['"`]((?:src|test|tools|\.proj|demo|python|vendor|docs)\/[^'"`$]*)['"`]/gu;

/** Repository paths a file depends on, followed through the modules it reaches. */
export function dependencies(start, cache = new Map()) {
  const found = new Set();
  const visit = (path) => {
    if (found.has(path)) return;
    found.add(path);
    if (!/\.(m?js)$/u.test(path)) return;
    let source;
    try {
      source = readFileSync(join(root, path), 'utf8');
    } catch {
      return;
    }
    if (!cache.has(path)) {
      const here = dirname(join(root, path));
      // An import or a named path is kept even when it is gone, so deleting
      // or renaming a module or a fixture reaches the suites that still name it.
      const next = [];
      for (const pattern of imports)
        for (const [, target] of source.matchAll(pattern))
          next.push(relative(root, resolve(here, target)));
      for (const [, target] of source.matchAll(named)) next.push(target.replace(/\/$/u, ''));
      cache.set(
        path,
        next.filter((target) => !target.startsWith('..')),
      );
    }
    for (const target of cache.get(path)) visit(target);
  };
  visit(start);
  return found;
}

// A path beneath a dependency is in it: the dependency is a directory, or was.
const reaches = (dependency, changed) =>
  dependency === changed || changed.startsWith(`${dependency}/`);

/** Suites the suite list names now but did not name at the base revision. */
export function addedSuites({ since = 'HEAD' } = {}) {
  const named = (source) =>
    new Set(source.match(/'[\w./-]+\.mjs'/gu)?.map((name) => name.slice(1, -1)));
  let base = '';
  try {
    base = execFileSync('git', ['show', `${since}:${suiteList}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // A new suite list adds every suite it names.
  }
  const before = named(base);
  return [...named(readFileSync(join(root, suiteList), 'utf8'))].filter(
    (name) => !before.has(name),
  );
}

/** The suites a set of changed files reaches, each with the change that reaches it. */
export function affectedSuites(changed, suites, { since = 'HEAD' } = {}) {
  const all = (because) => suites.map((suite) => ({ suite, because }));
  const global = changed.find((path) => everything.has(path));
  if (global) return all(global);
  const listed = changed.includes(suiteList);
  const added = new Set(listed ? addedSuites({ since }) : []);
  const cache = new Map(),
    reached = new Set();
  const affected = suites.flatMap((suite) => {
    const deps = [...dependencies(`test/${suite}`, cache)];
    const hits = changed.filter(
      (path) => path !== suiteList && deps.some((dep) => reaches(dep, path)),
    );
    for (const path of hits) reached.add(path);
    if (added.has(suite)) return [{ suite, because: `${suiteList} (added)` }];
    // Any edit to the list, a removal too, is checked against the test files.
    if (listed && suite === layoutSuite) return [{ suite, because: suiteList }];
    return hits.length ? [{ suite, because: hits[0] }] : [];
  });
  // What no suite depends on could still break a check: everything runs.
  const unreached = changed.find(
    (path) => path !== suiteList && !reached.has(path) && !documentation(path),
  );
  return unreached ? all(`${unreached} (no suite depends on it)`) : affected;
}

// The files `npm run format:check` covers.
const formatted = [
  /^(src|test|tools)\/.*\.mjs$/u,
  /^docs\/.*\.md$/u,
  /^[^/]+\.md$/u,
  /^\.github\/workflows\/[^/]+\.yml$/u,
  /^package\.json$/u,
  /^\.prettierrc\.json$/u,
];
export const formatTargets = (changed) =>
  changed.filter(
    (path) => formatted.some((pattern) => pattern.test(path)) && existsSync(join(root, path)),
  );

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // node tools/changes.mjs format [--since <ref>]: check the formatting of what changed.
  const args = process.argv.slice(2);
  const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : 'HEAD';
  if (args[0] !== 'format') throw new Error('Usage: changes.mjs format [--since <ref>]');
  const targets = formatTargets(changedFiles({ since }));
  if (!targets.length) console.log('No changed files to check.');
  else
    try {
      execFileSync(join(root, 'node_modules/.bin/prettier'), ['--check', ...targets], {
        cwd: root,
        stdio: 'inherit',
      });
    } catch (error) {
      // Prettier has already named the files; its status is the answer.
      if (typeof error.status !== 'number') throw error;
      process.exitCode = error.status;
    }
}
