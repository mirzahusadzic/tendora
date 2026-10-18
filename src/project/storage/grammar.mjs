/** Compiled corpus fragments share the bounded artifact store across questions. */
import { readFile, mkdir, access, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  artifactDatabasePath,
  openArtifactDatabase,
  storeArtifact,
  loadArtifact,
} from './engine-artifacts.mjs';

const cacheKey = (context) => createHash('sha256').update(JSON.stringify(context)).digest('hex');
const legacyDirectory = (project) => join(dirname(project.path), 'engine', 'grammars');
async function database(project) {
  try {
    await access(artifactDatabasePath(project));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return openArtifactDatabase(artifactDatabasePath(project));
}
export async function readGrammarCache(project, context) {
  const key = cacheKey(context),
    db = await database(project);
  try {
    const entry = db?.prepare('SELECT ref FROM grammars WHERE key = ?').get(key);
    if (entry) return loadArtifact(db, entry.ref) ?? null;
  } finally {
    db?.close();
  }
  try {
    return JSON.parse(await readFile(join(legacyDirectory(project), key + '.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function writeGrammarCache(project, context, value) {
  const path = artifactDatabasePath(project);
  await mkdir(dirname(path), { recursive: true });
  const db = openArtifactDatabase(path);
  try {
    const ref = storeArtifact(db, value);
    db.prepare('INSERT OR REPLACE INTO grammars VALUES (?, ?, ?)').run(
      cacheKey(context),
      ref,
      Date.now(),
    );
  } finally {
    db.close();
  }
}
export async function listGrammarCaches(project) {
  const db = await database(project);
  let entries;
  try {
    entries = db?.prepare('SELECT * FROM grammars').all() ?? [];
  } finally {
    db?.close();
  }
  const keys = new Set(entries.map((e) => e.key));
  for (const file of await readdir(legacyDirectory(project)).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (!/^[a-f0-9]{64}\.json$/u.test(file) || keys.has(file.slice(0, -5))) continue;
    const path = join(legacyDirectory(project), file);
    entries.push({ key: file.slice(0, -5), path, updated: (await stat(path)).mtimeMs });
  }
  return entries.sort((a, b) => b.updated - a.updated);
}
