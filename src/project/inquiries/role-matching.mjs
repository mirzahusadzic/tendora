/** Similarity orders exploration. It never establishes an answer or removes a branch. */
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { embedTexts } from '../../models/acquisition.mjs';
import { readObject, writeObject } from '../storage/objects.mjs';
import { readDataFile, writeDataFile } from '../storage/data-files.mjs';
import { captureRoleEmbeddings, indexRoleEmbeddings } from './role-embeddings.mjs';
import { scoreRoleVectors } from '../storage/role-vectors.mjs';
import { acquireEngineRunLease } from '../storage/engine-runs.mjs';

export const roleMatchingProfile = 'question-role-similarity-v1';
export function roleMatchingTexts(asset) {
  return [
    ...new Set([
      asset.query,
      ...asset.nodes.flatMap((node) => [
        [node.label, node.description].filter(Boolean).join('\n'),
        ...node.sentences,
      ]),
    ]),
  ];
}

export async function matchQuestionRoles(project, asset, options = {}) {
  options.signal?.throwIfAborted();
  const release = await acquireEngineRunLease(project, randomUUID());
  try {
    options.signal?.throwIfAborted();
    return await matchRoles(project, asset, options);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error.code !== 'ROLE_MATCHING_UNAVAILABLE') throw error;
    return {
      profile: roleMatchingProfile,
      status: 'unavailable',
      reason: 'Role matching is unavailable. Roles follow their original order.',
      error: error.message,
    };
  } finally {
    await release();
  }
}

async function matchRoles(
  project,
  asset,
  { acquire = true, embed = embedTexts, progress = () => {}, signal } = {},
) {
  const texts = roleMatchingTexts(asset);
  const key = createHash('sha256')
    .update(JSON.stringify([roleMatchingProfile, texts]))
    .digest('hex');
  const directory = dirname(project.path);
  const path = join(directory, 'role-matching', `${key}.json`);
  let captured, ref;
  try {
    const index = JSON.parse(await readDataFile(directory, path));
    ref = index.ref;
    captured = await readObject(directory, 'role-matching/objects', ref);
    if (JSON.stringify(captured.texts) !== JSON.stringify(texts))
      throw new Error('Retained role matching does not match these texts');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (ref)
      throw new Error(
        'Saved role-matching data is missing. Restore the project data before checking again.',
        {
          cause: error,
        },
      );
  }
  if (!captured) {
    progress('Matching the question to roles');
    captured = await captureRoleEmbeddings(project, roleMatchingProfile, texts, {
      acquire,
      embed,
      progress,
      signal,
    });
    if (!captured)
      return {
        profile: roleMatchingProfile,
        status: 'unavailable',
        reason: 'No saved role matches for these texts. Roles follow their original order.',
      };
  }
  signal?.throwIfAborted();
  if (captured.profile !== roleMatchingProfile || !captured.model)
    throw new Error('Invalid role-matching embeddings');
  const indexed = await indexRoleEmbeddings(project, captured, signal);
  if (indexed !== captured) ref = null;
  captured = indexed;
  if (!ref) {
    ref = await writeObject(directory, 'role-matching/objects', captured);
    signal?.throwIfAborted();
    await writeDataFile(directory, path, JSON.stringify({ ref }) + '\n');
  }
  signal?.throwIfAborted();
  const { scores, scoring } = scoreRoleVectors(directory, captured.vectorRefs);
  const byText = new Map(texts.map((text, i) => [text, scores[i]]));
  const score = (text) => byText.get(text);
  const nodes = new Map(asset.nodes.map((node) => [node.id, node]));
  const matches = new Map();
  const complete = (id) => {
    const node = nodes.get(id);
    const local = [[node.label, node.description].filter(Boolean).join('\n'), ...node.sentences]
      .map((text) => ({ nodeId: id, text, score: score(text) }))
      .sort((a, b) => b.score - a.score);
    const children = node.crossings.map((child) => matches.get(child));
    const best = [local[0], ...children.map((child) => child.best)].sort(
      (a, b) => b.score - a.score,
    )[0];
    const match = {
      nodeId: id,
      local,
      best,
      children: children.sort((a, b) => b.best.score - a.best.score).map((child) => child.nodeId),
    };
    matches.set(id, match);
    return match;
  };
  const active = new Set();
  for (const node of asset.nodes) {
    const stack = [{ id: node.id, finish: false }];
    while (stack.length) {
      const item = stack.pop();
      if (matches.has(item.id)) continue;
      if (item.finish) {
        complete(item.id);
        active.delete(item.id);
        continue;
      }
      if (active.has(item.id)) throw new Error('Role matching requires an acyclic hierarchy');
      const at = nodes.get(item.id);
      if (!at) throw new Error('Role matching found an unavailable child');
      active.add(item.id);
      stack.push({ id: item.id, finish: true });
      for (const child of [...at.crossings].reverse()) stack.push({ id: child, finish: false });
    }
  }
  return {
    profile: roleMatchingProfile,
    status: 'matched',
    model: captured.model,
    embedding: captured.embedding,
    scoring,
    evidenceRef: ref,
    matches: [...matches.values()],
  };
}
