/** Project storage stays inside its project. A store, its journal, a lease or
 * a storage directory that is a symbolic link would read and write wherever it
 * points, so it is refused. The project directory itself may be reached
 * through a link. */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export function refuseLinks(paths) {
  for (const path of paths) {
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
      throw error;
    }
    if (info.isSymbolicLink())
      throw Object.assign(
        new Error(
          `Project storage is a symbolic link: ${path}. Replace it with the file or directory itself.`,
        ),
        { code: 'STORAGE_LINK' },
      );
  }
}

/** A SQLite store and the files SQLite keeps beside it. */
export const sqliteFiles = (path) =>
  ['', '-journal', '-wal', '-shm'].map((suffix) => path + suffix);

/** What a project keeps beside its manifest. */
export const projectStorage = (directory) => [
  ...sqliteFiles(join(directory, 'material.sqlite')),
  join(directory, 'engine'),
  join(directory, 'engine', 'active'),
  join(directory, 'engine', 'objects'),
  ...sqliteFiles(join(directory, 'engine', 'artifacts.sqlite')),
  join(directory, 'recordings'),
  join(directory, 'investigations'),
  join(directory, 'provenance.json'),
];
