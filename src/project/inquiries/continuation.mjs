import { readSavedRecording } from '../storage/recordings.mjs';
/** Continuation drafts live beside project recordings, never inside source material. */
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateContinuation } from '../../recording/continuation.mjs';
import { interpretationRevision } from '../../recording/revisions.mjs';
import { projectInquiryAsset } from './inquiry.mjs';

function draftPath(project, context) {
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        context.parent.revision,
        context.parent.occurrenceId,
        context.opening.edge.id,
      ]),
    )
    .digest('hex');
  return join(dirname(project.path), '.continuations', `${key}.json`);
}
export async function readContinuationDraft(project, context) {
  try {
    return validateContinuation(JSON.parse(await readFile(draftPath(project, context), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function saveContinuationDraft(
  project,
  context,
  question,
  scopePlacementId,
  { caseState = false } = {},
) {
  validateContinuation(context);
  if (project.data.id !== context.parent.project.id)
    throw new Error('Continuation belongs to another project.');
  projectInquiryAsset(project, scopePlacementId, question);
  const path = draftPath(project, context);
  const draft = {
    ...context,
    question,
    scopePlacementId,
    caseState,
    projectDigest: project.digest,
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(draft, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return draft;
}
export async function readContinuationParent(context) {
  const recording = await readSavedRecording(context.parent.path);
  if (interpretationRevision(recording) !== context.parent.revision)
    throw new Error('Parent recording changed; reopen it before continuing.');
  return recording;
}
