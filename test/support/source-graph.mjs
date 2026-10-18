/** Inspect literal module imports without loading runtime adapters. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { posix } from 'node:path';

export async function sourceGraph(root) {
  const modules = new Map();
  for (const path of (await readdir(root, { recursive: true }))
    .filter((path) => path.endsWith('.mjs'))
    .sort()) {
    const source = await readFile(new URL(path, root), 'utf8');
    const imports = [
      ...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/gu),
    ].map(([, specifier]) => specifier);
    modules.set(path, imports);
  }
  return modules;
}

const allowed = {
  amr: ['amr'],
  models: ['models', 'amr'],
  inquiry: ['inquiry', 'amr', 'models'],
  recording: ['recording', 'amr'],
  engine: ['engine', 'amr', 'models', 'project', 'recording'],
  project: ['project', 'inquiry', 'models', 'engine', 'recording', 'amr'],
  tui: ['tui', 'engine', 'project', 'recording', 'amr'],
  cli: ['cli', 'engine', 'project', 'recording', 'amr'],
};
const projectAreas = ['authoring', 'inquiries', 'storage'];
const tuiAreas = ['shell', 'concepts', 'inquiries', 'recordings', 'engine', 'interpretations'];

export function checkSourceGraph(modules) {
  const dependencies = new Map();
  for (const [path, imports] of modules) {
    const [owner, area] = path.split('/');
    assert(allowed[owner], 'Unclassified source module: ' + path);
    if (owner === 'project')
      assert(projectAreas.includes(area), 'Unclassified project module: ' + path);
    if (owner === 'tui' && path !== 'tui/workbench.mjs')
      assert(tuiAreas.includes(area), 'Unclassified TUI module: ' + path);
    const targets = [];
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) {
        assert.notEqual(
          owner,
          'amr',
          'AMR operations must be independent of runtime adapters: ' + path + ' → ' + specifier,
        );
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      assert(modules.has(target), 'Missing module: ' + path + ' → ' + specifier);
      const [targetOwner, targetArea] = target.split('/');
      assert(allowed[owner].includes(targetOwner), 'Invalid dependency: ' + path + ' → ' + target);
      if (owner === 'project' && area === 'storage')
        assert(
          target.startsWith('project/storage/'),
          'Storage cannot invoke project workflows: ' + path + ' → ' + target,
        );
      if (owner === 'project' && area === 'authoring' && targetOwner === 'project')
        assert(
          ['authoring', 'storage'].includes(targetArea),
          'Authoring cannot invoke project workflows: ' + path + ' → ' + target,
        );
      if (owner === 'project' && area === 'authoring')
        assert(
          !['models', 'engine', 'inquiry'].includes(targetOwner),
          'Authoring cannot execute acquisition or reasoning: ' + path + ' → ' + target,
        );
      if (owner === 'engine' && targetOwner === 'project')
        assert(
          ['authoring', 'storage'].includes(targetArea),
          'Engine cannot depend on inquiry history: ' + path + ' → ' + target,
        );
      targets.push(target);
    }
    dependencies.set(path, targets);
  }
  const complete = new Set(),
    active = new Set();
  function visit(path, trail) {
    assert(!active.has(path), 'Module cycle: ' + [...trail, path].join(' → '));
    if (complete.has(path)) return;
    active.add(path);
    for (const target of dependencies.get(path)) visit(target, [...trail, path]);
    active.delete(path);
    complete.add(path);
  }
  for (const path of dependencies.keys()) visit(path, []);
  const offline = [...modules.keys()].filter(
    (path) =>
      path === 'inquiry/crossing.mjs' ||
      path.startsWith('recording/') ||
      path.startsWith('project/storage/') ||
      path.startsWith('project/authoring/') ||
      path === 'project/inquiries/scope.mjs' ||
      path === 'engine/answer.mjs',
  );
  for (const entry of offline) {
    const pending = [entry],
      visited = new Set();
    for (const path of pending) {
      if (visited.has(path)) continue;
      visited.add(path);
      assert(
        !path.startsWith('models/'),
        'Offline ' + entry + ' reaches model acquisition through ' + path,
      );
      pending.push(...dependencies.get(path));
    }
  }
  return dependencies;
}
