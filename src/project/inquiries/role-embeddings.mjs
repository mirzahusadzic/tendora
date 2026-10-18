/** Retain exact-text acquisitions; import only missing vectors into the native SQL index. */
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readObject, writeObject } from '../storage/objects.mjs';
import { readDataFile, writeDataFile, listDataFiles } from '../storage/data-files.mjs';
import {
  indexedRoleVectors,
  indexedRoleTexts,
  retainRoleVectors,
  retainRoleTexts,
  validRoleVector,
  hasRoleVectorIndex,
} from '../storage/role-vectors.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const textKey = (profile, text) =>
  `role-matching/texts/${digest(JSON.stringify([profile, text]))}.json`;
const modelKey = (entry) => JSON.stringify([entry.model, entry.embedding]);
async function bounded(items, fn) {
  const values = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(32, items.length) }, async () => {
      for (let i; (i = next++) < items.length;) values[i] = await fn(items[i], i);
    }),
  );
  return values;
}

async function saveVectors(directory, values, signal) {
  const links = [];
  const entries = await bounded(values, async (value) => {
    signal?.throwIfAborted();
    const ref = await writeObject(directory, 'role-matching/vectors', value);
    const path = textKey(value.profile, value.text);
    const bytes = JSON.stringify({ ref }) + '\n';
    signal?.throwIfAborted();
    await writeDataFile(directory, join(directory, path), bytes);
    links.push({ path, bytes, ref });
    return { ...value, ref };
  });
  signal?.throwIfAborted();
  retainRoleVectors(directory, entries);
  retainRoleTexts(directory, links);
  return entries;
}

async function vectorMetadata(directory, refs, signal, origins = []) {
  const entries = indexedRoleVectors(directory, refs),
    imported = [],
    parents = new Map();
  await bounded(refs, async (ref, i) => {
    if (entries[i]) return;
    signal?.throwIfAborted();
    const origin = origins[i];
    let value, source;
    if (origin) {
      if (!parents.has(origin.ref))
        parents.set(origin.ref, readObject(directory, 'role-matching/objects', origin.ref));
      const parent = await parents.get(origin.ref);
      value = inlineVector(parent, origin.slot);
      if (digest(JSON.stringify(value) + '\n') !== ref) throw new Error('Stored object changed');
      source = {
        path: join(directory, 'role-matching/objects', `${origin.ref}.json`),
        value: parent,
      };
    } else {
      value = await readObject(directory, 'role-matching/vectors', ref);
      source = { path: join(directory, 'role-matching/vectors', `${ref}.json`), value };
    }
    if (!validRoleVector(value.vector) || typeof value.text !== 'string' || !value.model)
      throw new Error('Invalid saved role-matching vector');
    // Also imports loose legacy files and backfills pre-index file checksums.
    await writeDataFile(directory, source.path, JSON.stringify(source.value) + '\n');
    entries[i] = { ...value, ref, ...(origin ? { origin } : {}) };
    imported.push(entries[i]);
  });
  signal?.throwIfAborted();
  retainRoleVectors(directory, imported);
  return entries;
}
const inlineVector = (captured, slot) => ({
  profile: captured.profile,
  text: captured.texts[slot],
  vector: captured.vectors[slot],
  model: captured.model,
  embedding: captured.embedding,
  acquiredAt: captured.acquiredAt,
});

/** Old inline cohorts become referenced records without replacing newer exact-text mappings. */
export async function indexRoleEmbeddings(project, captured, signal) {
  const directory = dirname(project.path);
  if (captured.vectors) {
    if (
      captured.vectors.length !== captured.texts.length ||
      captured.vectors.some((v) => !validRoleVector(v))
    )
      throw new Error('Invalid role-matching embeddings');
    const bytes = JSON.stringify(captured) + '\n',
      parentRef = digest(bytes);
    // The original cohort is the canonical source. Do not duplicate it into hundreds
    // of vector and text-index files just to build a derived native index.
    await writeDataFile(
      directory,
      join(directory, 'role-matching/objects', `${parentRef}.json`),
      bytes,
      { immutable: true },
    );
    const entries = captured.texts.map((text, slot) => {
      const value = inlineVector(captured, slot);
      return {
        ...value,
        ref: digest(JSON.stringify(value) + '\n'),
        origin: { ref: parentRef, slot },
      };
    });
    retainRoleVectors(directory, entries);
    retainRoleTexts(
      directory,
      entries.map((e) => ({ path: textKey(e.profile, e.text), ref: e.ref })),
    );
    const { vectors, ...metadata } = captured;
    captured = {
      ...metadata,
      vectorRefs: entries.map((entry) => entry.ref),
      vectorOrigins: entries.map((entry) => entry.origin),
    };
  }
  if (captured.vectorRefs?.length !== captured.texts?.length)
    throw new Error('Invalid retained role-matching cohort');
  if (captured.vectorOrigins && captured.vectorOrigins.length !== captured.vectorRefs.length)
    throw new Error('Invalid retained vector origins');
  const entries = await vectorMetadata(
    directory,
    captured.vectorRefs,
    signal,
    captured.vectorOrigins,
  );
  if (
    entries.some(
      (v, i) =>
        v.text !== captured.texts[i] ||
        v.profile !== captured.profile ||
        modelKey(v) !== modelKey(captured),
    )
  )
    throw new Error('Retained role-matching vectors do not match this cohort');
  return captured;
}

export async function captureRoleEmbeddings(
  project,
  profile,
  texts,
  { embed, acquire, signal, progress },
) {
  const directory = dirname(project.path),
    paths = texts.map((text) => textKey(profile, text));
  if (!hasRoleVectorIndex(directory)) {
    // Recover old inline acquisitions once when building a missing native index.
    for (const file of await listDataFiles(directory, 'role-matching/objects')) {
      signal?.throwIfAborted();
      const captured = await readObject(directory, 'role-matching/objects', file.slice(0, -5));
      if (captured.profile === profile && captured.vectors)
        await indexRoleEmbeddings(project, captured, signal);
    }
  }
  let entries = indexedRoleTexts(directory, paths);
  const pending = [];
  await bounded(texts, async (text, i) => {
    if (entries[i]) return;
    signal?.throwIfAborted();
    let bytes;
    try {
      bytes = await readDataFile(directory, join(directory, paths[i]));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    pending.push({ i, path: paths[i], bytes, ref: JSON.parse(bytes).ref });
  });
  if (pending.length) {
    const values = await vectorMetadata(
      directory,
      pending.map((entry) => entry.ref),
      signal,
    );
    await bounded(pending, async (item, i) => {
      entries[item.i] = values[i];
      await writeDataFile(directory, join(directory, item.path), item.bytes);
    });
    retainRoleTexts(directory, pending);
  }
  if (entries.some((value, i) => value && (value.text !== texts[i] || value.profile !== profile)))
    throw new Error('Saved role text does not match');
  let missing = texts.flatMap((text, i) => (entries[i] ? [] : [i]));
  if (new Set(entries.filter(Boolean).map(modelKey)).size > 1) missing = texts.map((_, i) => i);
  if (missing.length && !acquire) return null;
  let activeModel = entries.some(Boolean) ? modelKey(entries.find(Boolean)) : null;
  for (let at = 0; at < missing.length; at += 128) {
    signal?.throwIfAborted();
    const indexes = missing.slice(at, at + 128);
    progress(
      `Matching roles: reading ${Math.min(at + indexes.length, missing.length)} of ${missing.length} new texts`,
    );
    const acquired = await embed(
      indexes.map((i) => texts[i]),
      signal,
    ).catch((error) => {
      signal?.throwIfAborted();
      throw Object.assign(new Error(error.message, { cause: error }), {
        code: 'ROLE_MATCHING_UNAVAILABLE',
      });
    });
    if (
      !acquired.model ||
      acquired.vectors?.length !== indexes.length ||
      acquired.vectors.some((v) => !validRoleVector(v))
    )
      throw new Error('Invalid role-matching embeddings');
    if (activeModel && modelKey(acquired) !== activeModel) {
      if (at) throw new Error('The embedding model changed during role matching. Check again.');
      entries = Array(texts.length).fill(null);
      missing = texts.map((_, i) => i);
      activeModel = modelKey(acquired);
      at = -128;
      continue;
    }
    activeModel = modelKey(acquired);
    const saved = await saveVectors(
      directory,
      indexes.map((i, k) => ({
        profile,
        text: texts[i],
        model: acquired.model,
        embedding: acquired.embedding,
        vector: acquired.vectors[k],
        acquiredAt: new Date().toISOString(),
      })),
      signal,
    );
    for (let k = 0; k < indexes.length; k++) entries[indexes[k]] = saved[k];
  }
  return {
    profile,
    texts,
    vectorRefs: entries.map((e) => e.ref),
    ...(entries.some((e) => e.origin)
      ? { vectorOrigins: entries.map((e) => e.origin ?? null) }
      : {}),
    model: entries[0].model,
    embedding: entries[0].embedding,
    acquiredAt: new Date().toISOString(),
  };
}
