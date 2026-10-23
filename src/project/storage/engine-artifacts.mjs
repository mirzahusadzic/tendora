/** Shared, compressed fragments. Artifact identities describe their decoded JSON. */
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { readObject } from './objects.mjs';

const encode = (value) => Buffer.from(JSON.stringify(value) + '\n');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validRef = (ref) => typeof ref === 'string' && /^[a-f0-9]{64}$/u.test(ref);
export const artifactDatabasePath = (project) =>
  join(dirname(project.path), 'engine', 'artifacts.sqlite');

export function openArtifactDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 10000;
    CREATE TABLE IF NOT EXISTS fragments (
      hash TEXT PRIMARY KEY,
      payload BLOB NOT NULL,
      refs TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS artifacts (
      hash TEXT PRIMARY KEY REFERENCES fragments(hash)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      payload BLOB NOT NULL,
      checksum TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS grammars (
      key TEXT PRIMARY KEY,
      ref TEXT NOT NULL,
      updated INTEGER NOT NULL
    ) WITHOUT ROWID;
  `);
  return db;
}

export function storeRun(db, run) {
  const bytes = encode(run);
  db.prepare('INSERT OR REPLACE INTO runs VALUES (?, ?, ?)').run(
    run.id,
    brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
    digest(bytes),
  );
}

export function storedRuns(db, id) {
  const rows = id
    ? db.prepare('SELECT payload, checksum FROM runs WHERE id = ?').all(id)
    : db.prepare('SELECT payload, checksum FROM runs').all();
  return rows.map(({ payload, checksum }) => {
    const bytes = brotliDecompressSync(payload);
    if (digest(bytes) !== checksum) throw new Error('Stored engine run changed');
    return JSON.parse(bytes);
  });
}

/** Split on JSON values, so unchanged sources/rules survive ordering and query changes. */
export function storeArtifact(db, value) {
  const exists = db.prepare('SELECT 1 FROM fragments WHERE hash = ?');
  const pending = new Map();
  function fragment(value, bytes = encode(value)) {
    const hash = digest(bytes);
    if (pending.has(hash) || exists.get(hash)) return hash;
    const parts = [];
    function split(value, path) {
      if (value === null || typeof value !== 'object') {
        if (typeof value === 'string' && value.length >= 65536 && path.length) {
          parts.push([path, fragment(value)]);
          return null;
        }
        return value;
      }
      // A value's JSON contains its children's JSON, so nothing below a value
      // under the threshold can reach it: keep that value whole.
      const size = path.length ? encode(value) : bytes;
      if (size.length < 65536) return value;
      if (path.length) {
        parts.push([path, fragment(value, size)]);
        return null;
      }
      return Array.isArray(value)
        ? value.map((item, i) => split(item, [...path, i]))
        : Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, split(item, [...path, key])]),
          );
    }
    const data = split(value, []);
    const payload = brotliCompressSync(encode({ data, parts }), {
      params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
    });
    pending.set(hash, { payload, refs: JSON.stringify(parts.map(([, ref]) => ref)) });
    return hash;
  }
  const hash = fragment(value);
  const insert = db.prepare('INSERT OR IGNORE INTO fragments VALUES (?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [ref, { payload, refs }] of pending) insert.run(ref, payload, refs);
    db.prepare('INSERT OR IGNORE INTO artifacts VALUES (?)').run(hash);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return hash;
}

export function loadArtifact(db, hash) {
  if (!validRef(hash)) throw new Error('Invalid stored object reference');
  if (!db.prepare('SELECT 1 FROM artifacts WHERE hash = ?').get(hash)) return undefined;
  const select = db.prepare('SELECT payload FROM fragments WHERE hash = ?');
  const loaded = new Map(),
    active = new Set();
  function read(ref) {
    if (!validRef(ref) || active.has(ref)) throw new Error('Invalid engine fragment reference');
    if (loaded.has(ref)) return loaded.get(ref);
    const row = select.get(ref);
    if (!row) throw new Error('Missing engine fragment: ' + ref);
    active.add(ref);
    const { data, parts } = JSON.parse(brotliDecompressSync(row.payload));
    if (!Array.isArray(parts)) throw new Error('Invalid engine fragment');
    for (const [path, child] of parts) {
      if (!Array.isArray(path) || !path.length) throw new Error('Invalid engine fragment path');
      let target = data;
      for (const key of path.slice(0, -1)) {
        if (!Object.hasOwn(target, key)) throw new Error('Invalid engine fragment path');
        target = target[key];
      }
      const key = path.at(-1);
      if (!Object.hasOwn(target, key) || target[key] !== null)
        throw new Error('Invalid engine fragment path');
      Object.defineProperty(target, key, {
        value: structuredClone(read(child)),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (digest(encode(data)) !== ref) throw new Error('Stored object changed');
    active.delete(ref);
    loaded.set(ref, data);
    return data;
  }
  // Retained fragments may be shared on disk, but callers receive ordinary JSON values.
  return read(hash);
}

export async function readStoredArtifact(project, hash) {
  if (!validRef(hash)) throw new Error('Invalid stored object reference');
  const path = artifactDatabasePath(project);
  let db;
  try {
    await access(path);
    db = new DatabaseSync(path, { readOnly: true });
    const value = loadArtifact(db, hash);
    if (value !== undefined) return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    db?.close();
  }
  return readObject(dirname(project.path), 'engine/objects', hash);
}

export function pruneArtifacts(db, retained) {
  const refs = db.prepare('SELECT refs FROM fragments WHERE hash = ?');
  const reachable = new Set(),
    pending = [...retained];
  for (const hash of pending) {
    if (reachable.has(hash)) continue;
    reachable.add(hash);
    const row = refs.get(hash);
    if (row) pending.push(...JSON.parse(row.refs));
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const removeRoot = db.prepare('DELETE FROM artifacts WHERE hash = ?');
    for (const { hash } of db.prepare('SELECT hash FROM artifacts').all())
      if (!retained.has(hash)) removeRoot.run(hash);
    const remove = db.prepare('DELETE FROM fragments WHERE hash = ?');
    for (const { hash } of db.prepare('SELECT hash FROM fragments').all())
      if (!reachable.has(hash)) remove.run(hash);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('VACUUM');
}
