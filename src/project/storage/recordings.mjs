/** Old JSON captures and compact handles share one reader. */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readStoredArtifact } from './engine-artifacts.mjs';
import { readEngineRun } from './engine-runs.mjs';

export async function readSavedRecording(path, { allowHeader = false } = {}) {
  const header = JSON.parse(await readFile(path, 'utf8'));
  const project = { path: join(dirname(dirname(path)), 'project.json'), data: header.project };
  let reference = header.artifactRef,
    evicted = header.cache === 'recheck';
  if (header.reasoning?.runId) {
    try {
      const run = await readEngineRun(project, header.reasoning.runId);
      // The database is published atomically, before its small file handles.
      // Consult it first so interrupted cleanup cannot expose an obsolete handle.
      if (run.cache && run.recording?.path === path) {
        reference = run.recording?.artifactRef;
        evicted = !reference;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (reference && !evicted) return readStoredArtifact(project, reference);
  if (evicted && !allowHeader)
    throw Object.assign(new Error('Check this question again to rebuild its current support.'), {
      code: 'RECORDING_CACHE_MISS',
      runId: header.reasoning?.runId,
    });
  return header;
}
