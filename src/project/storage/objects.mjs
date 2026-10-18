/** Immutable corpus/record objects, with one atomic project index. */
import { readFile, writeFile, mkdir, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataAreas, readDataFile, writeDataFile } from './data-files.mjs';

const encode = (value) => JSON.stringify(value) + '\n';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const collections = [
  'knowledge',
  'sourceScopes',
  'authoring',
  'interpretationMappings',
  'inquiryTests',
  'contributions',
  'semanticReadings', // Read/write old experiment records as history; never used by reasoning.
];
async function mapBounded(values, fn) {
  const output = new Array(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(32, values.length) }, async () => {
      for (let index; (index = cursor++) < values.length;) output[index] = await fn(values[index]);
    }),
  );
  return output;
}
export async function writeObject(directory, area, value) {
  const bytes = encode(value),
    hash = digest(bytes),
    folder = join(directory, area);
  if (dataAreas.includes(area.split('/')[0])) {
    await writeDataFile(directory, join(folder, `${hash}.json`), bytes, { immutable: true });
    return hash;
  }
  await mkdir(folder, { recursive: true });
  const target = join(folder, `${hash}.json`);
  try {
    if ((await readFile(target, 'utf8')) !== bytes) throw new Error('Stored object changed');
    return hash;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = join(folder, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    try {
      await link(temporary, target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if ((await readFile(target, 'utf8')) !== bytes) throw new Error('Stored object changed');
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return hash;
}
export async function readObject(directory, area, hash) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash))
    throw new Error('Invalid stored object reference');
  const path = join(directory, area, `${hash}.json`);
  const bytes = dataAreas.includes(area.split('/')[0])
    ? await readDataFile(directory, path)
    : await readFile(path, 'utf8');
  if (digest(bytes) !== hash) throw new Error('Stored object changed');
  return JSON.parse(bytes);
}

export async function storeProject(directory, data, previous) {
  const { concepts, ...index } = data;
  const unchanged = new Map(
    (previous?.data.concepts ?? []).map((concept, i) => [
      concept.id,
      {
        bytes: encode(concept),
        ref: previous.storage?.corpora?.[i],
      },
    ]),
  );
  const corpora = await mapBounded(concepts, (concept) => {
    const old = unchanged.get(concept.id);
    return old?.ref && old.bytes === encode(concept)
      ? old.ref
      : writeObject(directory, 'corpora', concept);
  });
  const records = {};
  for (const key of collections) {
    delete index[key];
    if (data[key]?.length) {
      const retained = new Map(
        (previous?.data[key] ?? []).map((value, i) => [
          encode(value),
          previous.storage?.records?.[key]?.[i],
        ]),
      );
      records[key] = await mapBounded(
        data[key],
        (value) => retained.get(encode(value)) ?? writeObject(directory, 'records', value),
      );
    }
  }
  return { ...index, version: 2, corpora, ...(Object.keys(records).length ? { records } : {}) };
}

export async function loadProject(directory, index) {
  if (index.version !== 2) return index;
  if (
    !Array.isArray(index.corpora) ||
    !index.corpora.length ||
    index.concepts ||
    collections.some((key) => index[key] !== undefined) ||
    Object.keys(index.records ?? {}).some((key) => !collections.includes(key))
  )
    throw new Error('Invalid project index');
  const { corpora, records, ...header } = index;
  const concepts = await mapBounded(corpora, (hash) => readObject(directory, 'corpora', hash));
  const data = { ...header, version: 1, concepts };
  for (const [key, refs] of Object.entries(records ?? {})) {
    if (!Array.isArray(refs)) throw new Error('Invalid project record references');
    data[key] = await mapBounded(refs, (hash) => readObject(directory, 'records', hash));
  }
  return data;
}
