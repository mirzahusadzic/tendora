import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
/** List only captures belonging to this project; loading validates the full snapshot. */
export async function listProjectRecordings(project) {
  const directory = join(dirname(project.path), 'recordings');
  let files;
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = await Promise.all(
    files
      .filter((file) => !file.startsWith('._') && file.endsWith('.json'))
      .map(async (file) => {
        try {
          const recording = JSON.parse(await readFile(join(directory, file), 'utf8'));
          if (
            recording.schema !== 'tendora.workbench.recording' ||
            recording.project?.id !== project.data.id
          )
            return null;
          return {
            path: join(directory, file),
            file,
            id: recording.id,
            continuation: recording.continuation
              ? {
                  parentPath: recording.continuation.parent.path,
                  parentRevision: recording.continuation.parent.revision,
                  occurrenceId: recording.continuation.parent.occurrenceId,
                  edgeId: recording.continuation.opening.edge?.id,
                  openingId: recording.continuation.opening.id,
                }
              : null,
            query: recording.inquiry.text,
            revision: recording.project.digest ?? recording.asset.revision,
          };
        } catch {
          return null;
        }
      }),
  );
  return entries.filter(Boolean).sort((a, b) => b.file.localeCompare(a.file));
}
