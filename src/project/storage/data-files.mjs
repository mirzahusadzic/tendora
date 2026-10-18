/** Durable project files. Logical paths and decoded bytes survive lossless packing. */
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { statSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { withFileLease } from './locks.mjs';
import { loadSqliteVec } from './sqlite-vec.mjs';

export const dataAreas = ['corpora', 'records', 'acquisitions', 'role-matching', 'investigations'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Only vector-index sources need an extra SQL checksum; object reads already verify their hashes.
const indexedChecksum = (key, bytes) => (key.startsWith('role-matching/') ? digest(bytes) : null);
const connections = new Map();
const blockLimit = 4 * 1024 * 1024;
export const dataStorePath = (directory) => join(resolve(directory), 'material.sqlite');
const missing = (path) =>
  Object.assign(new Error(`Project file unavailable: ${path}`), { code: 'ENOENT' });
function keyFor(directory, path) {
  const key = relative(resolve(directory), resolve(path));
  if (!dataAreas.includes(key.split('/')[0]) || key.includes('..') || !key.endsWith('.json'))
    throw new Error('Invalid project data path');
  return key;
}
function database(directory, create = false) {
  const path = dataStorePath(directory);
  let info;
  try {
    info = statSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return null;
    mkdirSync(dirname(path), { recursive: true });
  }
  let entry = connections.get(path);
  if (entry && entry.ino !== info?.ino) {
    entry.db.close();
    connections.delete(path);
    entry = null;
  }
  if (!entry) {
    const db = new DatabaseSync(path, { allowExtension: true });
    // Even schema inspection can race with another process compacting the store.
    db.exec('PRAGMA busy_timeout = 10000');
    db.enableLoadExtension(false);
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'role_embeddings'").get())
      loadSqliteVec(db);
    db.exec(`
      PRAGMA page_size = 1024;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS blocks (
        hash TEXT PRIMARY KEY, payload BLOB NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, block TEXT, checksum TEXT
      ) WITHOUT ROWID;
    `);
    // Older packed projects acquire file checksums when imported or compacted.
    const hasChecksums = () =>
      db
        .prepare('PRAGMA table_info(files)')
        .all()
        .some((column) => column.name === 'checksum');
    if (!hasChecksums()) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!hasChecksums()) db.exec('ALTER TABLE files ADD COLUMN checksum TEXT');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        db.close();
        throw error;
      }
    }
    entry = { db, ino: statSync(path).ino, loaded: new Map(), loadedBytes: 0 };
  }
  const version = entry.db.prepare('PRAGMA data_version').get().data_version;
  if (entry.version !== version) {
    // Another process can add a vec0 index after this connection was opened.
    if (entry.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'role_embeddings'").get())
      loadSqliteVec(entry.db);
    entry.loaded.clear();
    entry.loadedBytes = 0;
    entry.version = version;
  }
  connections.delete(path);
  connections.set(path, entry);
  while (connections.size > 8) {
    const oldest = connections.keys().next().value;
    connections.get(oldest).db.close();
    connections.delete(oldest);
  }
  return entry;
}
/** Synchronous storage operations share the material transaction and connection lifetime. */
export function withDataDatabase(directory, operation) {
  const result = operation(database(directory, true).db);
  if (result?.then) throw new Error('A data database operation must be synchronous');
  return result;
}
function decode(entry, hash) {
  let block = entry.loaded.get(hash);
  if (block) return block.files;
  const row = entry.db.prepare('SELECT payload FROM blocks WHERE hash = ?').get(hash);
  if (!row) throw new Error('Missing project data block');
  const bytes = brotliDecompressSync(row.payload);
  if (digest(bytes) !== hash) throw new Error('Stored project data changed');
  const pairs = JSON.parse(bytes);
  if (
    !Array.isArray(pairs) ||
    pairs.some(
      (pair) =>
        !Array.isArray(pair) || pair.length !== 2 || pair.some((v) => typeof v !== 'string'),
    )
  )
    throw new Error('Invalid project data block');
  const files = new Map(pairs);
  if (files.size !== pairs.length) throw new Error('Duplicate project data path');
  block = { files, bytes: bytes.length };
  // A project with many roles does not hold every decompressed block indefinitely.
  while (entry.loadedBytes && entry.loadedBytes + bytes.length > 16 * 1024 * 1024) {
    const oldest = entry.loaded.keys().next().value;
    entry.loadedBytes -= entry.loaded.get(oldest).bytes;
    entry.loaded.delete(oldest);
  }
  entry.loaded.set(hash, block);
  entry.loadedBytes += bytes.length;
  return files;
}
function stored(entry, key) {
  const row = entry.db.prepare('SELECT block FROM files WHERE path = ?').get(key);
  if (!row) return undefined;
  if (!row.block) return null; // A deletion also masks a loose file left by an interrupted migration.
  const bytes = decode(entry, row.block).get(key);
  if (bytes === undefined) throw new Error('Project data path missing from its block');
  return bytes;
}
function storeBlock(db, pairs) {
  const bytes = JSON.stringify(pairs),
    hash = digest(bytes);
  const payload = brotliCompressSync(Buffer.from(bytes), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
  });
  db.prepare('INSERT OR IGNORE INTO blocks VALUES (?, ?)').run(hash, payload);
  return hash;
}
export async function readDataFile(directory, path) {
  const key = keyFor(directory, path);
  function snapshot() {
    const entry = database(directory);
    if (!entry) return undefined;
    entry.db.exec('BEGIN');
    try {
      const value = stored(entry, key);
      entry.db.exec('COMMIT');
      return value;
    } catch (error) {
      entry.db.exec('ROLLBACK');
      throw error;
    }
  }
  const value = snapshot();
  if (value === null) throw missing(path);
  if (value !== undefined) return value;
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Migration can publish the packed object and remove the loose file between reads.
    const packed = snapshot();
    if (packed === undefined || packed === null) throw missing(path);
    return packed;
  }
}
export async function writeDataFile(directory, path, bytes, { immutable = false } = {}) {
  const key = keyFor(directory, path);
  if (typeof bytes !== 'string') throw new Error('Project data must be UTF-8 text');
  // Check old immutable objects before introducing a packed override.
  if (immutable) {
    try {
      const previous = await readDataFile(directory, path);
      if (previous !== bytes) throw new Error('Stored object changed');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const entry = database(directory, true),
    { db } = entry;
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = stored(entry, key);
    if (immutable && previous !== undefined && previous !== null && previous !== bytes)
      throw new Error('Stored object changed');
    if (previous !== bytes) {
      const hash = storeBlock(db, [[key, bytes]]);
      db.prepare('INSERT OR REPLACE INTO files VALUES (?, ?, ?)').run(
        key,
        hash,
        indexedChecksum(key, bytes),
      );
    } else {
      db.prepare('UPDATE files SET checksum = ? WHERE path = ? AND checksum IS NULL').run(
        indexedChecksum(key, bytes),
        key,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export async function listDataFiles(directory, area) {
  if (!dataAreas.includes(area.split('/')[0]) || area.includes('..'))
    throw new Error('Invalid project data area');
  const names = new Set(
    await readdir(join(directory, area)).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }),
  );
  const entry = database(directory),
    prefix = area + '/';
  if (entry)
    for (const row of entry.db
      .prepare('SELECT path, block FROM files WHERE path >= ? AND path < ?')
      .all(prefix, prefix + '\uffff')) {
      const name = row.path.slice(prefix.length);
      if (name.includes('/')) continue;
      if (row.block) names.add(name);
      else names.delete(name);
    }
  return [...names].sort();
}
export async function removeDataFile(directory, path) {
  return withFileLease(join(directory, '.material-compact.lock'), async () => {
    const key = keyFor(directory, path),
      { db } = database(directory, true);
    db.prepare('INSERT OR REPLACE INTO files VALUES (?, NULL, NULL)').run(key);
    await rm(path, { force: true });
  });
}
export async function removeDataArea(directory, area) {
  if (!dataAreas.includes(area)) throw new Error('Invalid project data area');
  return withFileLease(join(directory, '.material-compact.lock'), async () => {
    const paths = await looseFiles(directory, [area]);
    const entry = database(directory, true),
      prefix = area + '/';
    entry.db.exec('BEGIN IMMEDIATE');
    try {
      entry.db
        .prepare('UPDATE files SET block = NULL, checksum = NULL WHERE path >= ? AND path < ?')
        .run(prefix, prefix + '\uffff');
      const remove = entry.db.prepare('INSERT OR REPLACE INTO files VALUES (?, NULL, NULL)');
      for (const path of paths) remove.run(keyFor(directory, path));
      entry.db.exec('COMMIT');
    } catch (error) {
      entry.db.exec('ROLLBACK');
      throw error;
    }
    await rm(join(directory, area), { recursive: true, force: true });
  });
}
async function looseFiles(directory, areas = dataAreas) {
  const paths = [];
  async function visit(path) {
    for (const item of await readdir(path, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      if (item.name.startsWith('.')) continue;
      const child = join(path, item.name);
      if (item.isDirectory()) await visit(child);
      else if (item.isFile() && item.name.endsWith('.json')) paths.push(child);
    }
  }
  for (const area of areas) await visit(join(directory, area));
  return paths.sort();
}
export async function compactDataFiles(directory) {
  return withFileLease(join(directory, '.material-compact.lock'), async () => {
    const paths = await looseFiles(directory);
    // Reading legacy files precedes the transaction. Packed writes take precedence.
    const loose = new Map();
    for (const path of paths) {
      try {
        const key = keyFor(directory, path),
          bytes = await readFile(path, 'utf8');
        const object =
          /^(?:corpora|records|acquisitions\/objects|role-matching\/(?:objects|vectors))\/([a-f0-9]{64})\.json$/u.exec(
            key,
          );
        if (object && digest(bytes) !== object[1]) throw new Error('Stored object changed');
        loose.set(key, bytes);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const entry = database(directory, true),
      { db } = entry;
    db.exec('BEGIN IMMEDIATE');
    let count;
    try {
      for (const row of db.prepare('SELECT path, block FROM files').all()) {
        if (row.block) loose.set(row.path, stored(entry, row.path));
        else loose.delete(row.path);
      }
      count = loose.size;
      const update = db.prepare('INSERT OR REPLACE INTO files VALUES (?, ?, ?)');
      let pairs = [],
        bytes = 0;
      function flush() {
        if (!pairs.length) return;
        const hash = storeBlock(db, pairs);
        for (const [key, bytes] of pairs) update.run(key, hash, indexedChecksum(key, bytes));
        pairs = [];
        bytes = 0;
      }
      for (const pair of [...loose].sort(([a], [b]) => a.localeCompare(b))) {
        if (bytes + pair[1].length > blockLimit) flush();
        pairs.push(pair);
        bytes += pair[1].length;
      }
      flush();
      // Verify the published representation before removing any legacy file.
      entry.loaded.clear();
      entry.loadedBytes = 0;
      for (const [key, bytes] of loose)
        if (stored(entry, key) !== bytes) throw new Error('Project data changed during packing');
      db.exec(
        'DELETE FROM blocks WHERE hash NOT IN (SELECT block FROM files WHERE block IS NOT NULL); COMMIT;',
      );
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    for (const path of paths) await rm(path, { force: true });
    // Leave tombstones until the loose copies are gone, including across interruptions.
    const current = database(directory);
    current.db.exec('DELETE FROM files WHERE block IS NULL; VACUUM;');
    current.loaded.clear();
    current.loadedBytes = 0;
    return { files: count, bytes: (await stat(dataStorePath(directory))).size };
  });
}
