import { readSavedRecording } from '../storage/recordings.mjs';
/** Continuation drafts live beside project recordings, never inside source material. */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateContinuation } from '../../recording/continuation.mjs';
import { interpretationRevision } from '../../recording/revisions.mjs';

// Drafts were keyed by query edge. They are no longer written; existing ones only
// prefill a question and are dropped once their project or scope no longer holds.
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
  if (typeof context?.opening?.edge?.id !== 'string') return null;
  let draft;
  try {
    draft = validateContinuation(JSON.parse(await readFile(draftPath(project, context), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (
    draft.parent?.project?.id !== project.data.id ||
    !project.data.placements.some((placement) => placement.id === draft.scopePlacementId)
  )
    return null;
  return draft;
}
export async function readContinuationParent(context) {
  const recording = await readSavedRecording(context.parent.path);
  if (interpretationRevision(recording) !== context.parent.revision)
    throw new Error('Parent recording changed; reopen it before continuing.');
  return recording;
}
