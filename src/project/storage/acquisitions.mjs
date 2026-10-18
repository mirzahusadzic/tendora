/** Retained parsing evidence, keyed by exact text; placement and inquiry own their identities. */
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeObject, readObject } from './objects.mjs';
import { withFileLease } from './locks.mjs';
import { readDataFile, writeDataFile } from './data-files.mjs';

const root = (project) => dirname(project.path);
const sentenceRevision = (text) => createHash('sha256').update(text).digest('hex');
const indexPath = (project) => join(root(project), 'acquisitions', 'index.json');
const lockPath = (project) => join(root(project), '.acquisitions-index.lock');

export const withAcquisitionIndexLease = (project, operation) =>
  withFileLease(lockPath(project), operation, {
    busyMessage: 'Retained language is being updated elsewhere.',
  });

export async function readAcquisitions(project) {
  let bytes;
  try {
    bytes = await readDataFile(root(project), indexPath(project));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const index = JSON.parse(bytes);
  if (
    index.version !== 1 ||
    index.projectId !== project.data.id ||
    index.mode !== 'retained' ||
    !index.entries ||
    Object.entries(index.entries).some(
      ([key, ref]) => !/^[a-f0-9]{64}$/u.test(key) || !/^[a-f0-9]{64}$/u.test(ref),
    )
  )
    throw new Error('Invalid retained acquisition index');
  return index;
}

export async function retainAcquisitions(project, captures, { origin = null } = {}) {
  return withAcquisitionIndexLease(project, async () => {
    const previous = await readAcquisitions(project);
    const index = structuredClone(
      previous ?? { version: 1, projectId: project.data.id, mode: 'retained', origin, entries: {} },
    );
    for (const capture of captures) {
      if (
        typeof capture.text !== 'string' ||
        !capture.text.trim() ||
        typeof capture.penman !== 'string' ||
        !capture.penman.trim() ||
        !capture.origin
      )
        throw new Error('An acquisition needs exact text, PENMAN and its origin');
      const key = sentenceRevision(capture.text),
        value = { ...capture, textDigest: key };
      const ref = await writeObject(root(project), 'acquisitions/objects', value);
      if (index.entries[key] && index.entries[key] !== ref)
        throw new Error('This text already has a different retained acquisition');
      index.entries[key] = ref;
    }
    await writeDataFile(root(project), indexPath(project), JSON.stringify(index, null, 2) + '\n');
    return index;
  });
}

export async function acquiredTexts(project, texts) {
  const index = await readAcquisitions(project);
  if (!index) return null;
  return Promise.all(
    texts.map(async (text) => {
      const key = sentenceRevision(text),
        ref = index.entries[key];
      if (!ref)
        return {
          text,
          textDigest: key,
          status: 'missing',
          reason: 'This exact text has no retained AMR. No model acquisition was attempted.',
        };
      const capture = await readObject(root(project), 'acquisitions/objects', ref);
      if (capture.text !== text || capture.textDigest !== key)
        throw new Error('Retained AMR text or revision mismatch');
      return { ...capture, ref, status: 'retained' };
    }),
  );
}
