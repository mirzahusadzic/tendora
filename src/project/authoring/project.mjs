/** Local authored material. Placements are context, not crossings or evidence. */
import { readFile, readdir, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

import { reconcileSources } from './sources.mjs';
import { loadProject, storeProject } from '../storage/objects.mjs';
import { validateContributions } from './development.mjs';
import { withFileLease } from '../storage/locks.mjs';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const encode = (data) => JSON.stringify(data, null, 2) + '\n';
const id = () => randomUUID();
const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;
const label = (s) => nonempty(s) && !/[\r\n\x00-\x1f\x7f]/u.test(s);
export function validateProject(data) {
  const fail = (message) => {
    throw new Error(`Invalid project: ${message}`);
  };
  if (data?.version !== 1 || !label(data.name) || !nonempty(data.id))
    fail('expected version 1, name and identity');
  if (!Array.isArray(data.concepts) || !data.concepts.length || !Array.isArray(data.placements))
    fail('missing concepts or placements');
  const concepts = new Map(),
    placements = new Map();
  for (const concept of data.concepts) {
    if (
      !nonempty(concept.id) ||
      concepts.has(concept.id) ||
      !label(concept.name) ||
      !Array.isArray(concept.passages) ||
      concept.passages.some((p) => !nonempty(p) || /[\x00-\x08\x0b-\x1f\x7f]/u.test(p))
    )
      fail('invalid or duplicate concept');
    concepts.set(concept.id, concept);
    if (
      concept.sourceRecords !== undefined &&
      (!Array.isArray(concept.sourceRecords) ||
        new Set(concept.sourceRecords.map((source) => source.id)).size !==
          concept.sourceRecords.length ||
        concept.sourceRecords.some(
          (source) =>
            !nonempty(source.id) ||
            !nonempty(source.text) ||
            source.conceptId !== concept.id ||
            source.revision !== digest(source.text),
        ))
    )
      fail('invalid sentence identity');
    if (
      concept.description !== undefined &&
      (typeof concept.description !== 'string' ||
        /[\x00-\x08\x0b-\x1f\x7f]/u.test(concept.description))
    )
      fail('invalid concept description');
  }
  for (const placement of data.placements) {
    if (
      !nonempty(placement.id) ||
      placements.has(placement.id) ||
      !concepts.has(placement.conceptId)
    )
      fail('invalid or duplicate placement');
    placements.set(placement.id, placement);
  }
  const placed = new Set(),
    complete = new Set();
  for (const placement of placements.values()) {
    placed.add(placement.conceptId);
    const path = new Set();
    let current = placement;
    while (current && !complete.has(current.id)) {
      if (path.has(current.id)) fail('parent placements form a cycle');
      path.add(current.id);
      if (current.parentId !== null && !placements.has(current.parentId))
        fail('missing parent placement');
      current = placements.get(current.parentId);
    }
    for (const item of path) complete.add(item);
  }
  if (placed.size !== concepts.size) fail('every concept needs a placement');
  if (
    data.sourceScopes !== undefined &&
    (!Array.isArray(data.sourceScopes) ||
      data.sourceScopes.some(
        (scope) =>
          !nonempty(scope.placementId) ||
          !nonempty(scope.text) ||
          !nonempty(scope.attribution) ||
          !Array.isArray(scope.caseTexts) ||
          scope.caseTexts.some((value) => !nonempty(value)),
      ))
  )
    fail('invalid sentence scope');

  return validateContributions(data);
}
export async function openProject(directory) {
  const path = join(resolve(directory), 'project.json');
  const text = await readFile(path, 'utf8');
  const storage = JSON.parse(text);
  return {
    path,
    data: validateProject(await loadProject(dirname(path), storage)),
    digest: digest(text),
    storage,
  };
}
export async function createProject(directory, name, rootName) {
  const concept = {
    id: id(),
    name: rootName?.trim() || name,
    passages: [],
    ...(!rootName?.trim() ? { workspace: true } : {}),
  };
  const data = validateProject({
    version: 1,
    id: id(),
    name,
    concepts: [concept],
    placements: [{ id: id(), conceptId: concept.id, parentId: null }],
  });
  await mkdir(resolve(directory), { recursive: true });
  const path = join(resolve(directory), 'project.json'),
    storage = await storeProject(resolve(directory), data),
    text = encode(storage);
  await writeFile(path, text, { flag: 'wx' });
  return { path, data, digest: digest(text), storage };
}
export async function saveProject(project, data) {
  data = reconcileSources(data, project.data);
  validateProject(data);
  if (data.id !== project.data.id) throw new Error('Cannot change project identity while saving.');
  return withFileLease(
    project.path + '.lock',
    async () => {
      const temporary = `${project.path}.${id()}.tmp`;
      try {
        if (digest(await readFile(project.path, 'utf8')) !== project.digest)
          throw Object.assign(
            new Error('Project changed on disk. Reload before applying further edits.'),
            { code: 'PROJECT_CHANGED' },
          );
        const storage = await storeProject(dirname(project.path), data, project),
          text = encode(storage);
        await writeFile(temporary, text, { flag: 'wx' });
        await rename(temporary, project.path);
        return { ...project, data, digest: digest(text), storage };
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
    { busyMessage: 'Project is being saved elsewhere. Retry after that save completes.' },
  );
}
export function addConcept(data, parentId, name) {
  if (parentId !== null && !data.placements.some((p) => p.id === parentId))
    throw new Error('Choose a parent concept first.');
  const next = structuredClone(data),
    concept = { id: id(), name, passages: [] };
  const placement = { id: id(), conceptId: concept.id, parentId };
  next.concepts.push(concept);
  next.placements.push(placement);
  return { data: validateProject(next), placementId: placement.id };
}
export function editConcept(data, conceptId, name, passages, description) {
  const next = structuredClone(data),
    concept = next.concepts.find((c) => c.id === conceptId);
  if (!concept) throw new Error('Unknown concept.');
  Object.assign(concept, { name, passages });
  if (description !== undefined) concept.description = description;
  return validateProject(next);
}
export function projectTree(data) {
  const concepts = new Map(data.concepts.map((c) => [c.id, c]));
  const children = new Map();
  for (const p of data.placements) {
    if (!children.has(p.parentId)) children.set(p.parentId, []);
    children.get(p.parentId).push(p);
  }
  const stack = (children.get(null) ?? [])
    .slice()
    .reverse()
    .map((p) => ({ placement: p, depth: 0 }));
  const result = [];
  while (stack.length) {
    const item = stack.pop();
    result.push({ ...item, concept: concepts.get(item.placement.conceptId) });
    for (const child of (children.get(item.placement.id) ?? []).slice().reverse())
      stack.push({ placement: child, depth: item.depth + 1 });
  }
  return result;
}
/** Move a placement with its descendants, leaving all concept material intact. */
export function moveConcept(data, placementId, parentId) {
  const next = structuredClone(data);
  const placement = next.placements.find((p) => p.id === placementId);
  if (!placement) throw new Error('Choose a concept to move.');
  if (parentId !== null && !next.placements.some((p) => p.id === parentId))
    throw new Error('Choose an existing parent.');
  placement.parentId = parentId;
  return validateProject(next);
}
/** Discover projects directly within a location; never crawl their contents. */
export async function listProjects(directory, knownPaths = []) {
  const root = resolve(directory);
  const entries = await readdir(root, { withFileTypes: true });
  const paths = new Set([
    root,
    ...entries
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules',
      )
      .map((entry) => join(root, entry.name)),
    ...knownPaths,
  ]);
  const projects = [];
  for (const path of paths) {
    try {
      const index = JSON.parse(await readFile(join(path, 'project.json'), 'utf8'));
      if (!label(index.name) || ![1, 2].includes(index.version))
        throw new Error('Invalid project index');
      projects.push({
        path,
        name: index.name,
        count: (index.corpora ?? index.concepts)?.length ?? 0,
        contributionCount: (index.records?.contributions ?? index.contributions)?.length ?? 0,
      });
    } catch (error) {
      if (error.code !== 'ENOENT')
        projects.push({ path, name: path.split('/').at(-1), error: error.message });
    }
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/** Remove one placement branch; concepts still placed elsewhere retain their sources. */
export function removeBranch(data, placementId) {
  const selected = data.placements.find((p) => p.id === placementId);
  if (!selected) throw new Error('Choose a concept to delete.');
  const children = new Map();
  for (const placement of data.placements) {
    if (!children.has(placement.parentId)) children.set(placement.parentId, []);
    children.get(placement.parentId).push(placement.id);
  }
  const removed = new Set(),
    pending = [placementId];
  while (pending.length) {
    const current = pending.pop();
    removed.add(current);
    pending.push(...(children.get(current) ?? []));
  }
  const placements = data.placements.filter((p) => !removed.has(p.id));
  if (!placements.length)
    throw new Error('Keep the final root concept; select a child branch to delete.');
  const retained = new Set(placements.map((p) => p.conceptId));
  const next = { ...data, placements, concepts: data.concepts.filter((c) => retained.has(c.id)) };
  if (next.contributions)
    next.contributions = next.contributions.filter((c) => !removed.has(c.scopePlacementId));
  return {
    data: validateProject(next),
    count: removed.size,
    nextPlacementId: selected.parentId ?? placements[0].id,
  };
}
