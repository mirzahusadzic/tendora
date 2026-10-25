/** Shared, compressed fragments. Artifact identities describe their decoded JSON. */
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, constants } from 'node:zlib';
import { readObject } from './objects.mjs';
import { refuseLinks, sqliteFiles } from './links.mjs';
import { decodedBudget, decompress, writable } from './decoded.mjs';

const encode = (value) => Buffer.from(JSON.stringify(value) + '\n');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validRef = (ref) => typeof ref === 'string' && /^[a-f0-9]{64}$/u.test(ref);
export const artifactDatabasePath = (project) =>
  join(dirname(project.path), 'engine', 'artifacts.sqlite');

// The store and its engine directory stay inside the project.
const storeFiles = (path) => [dirname(path), ...sqliteFiles(path)];

export function openArtifactDatabase(path) {
  refuseLinks(storeFiles(path));
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
  writable(bytes.length, 'An engine run');
  db.prepare('INSERT OR REPLACE INTO runs VALUES (?, ?, ?)').run(
    run.id,
    brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
    digest(bytes),
  );
}

/** Saved runs, each checked against its digest. A damaged one fails the read;
 * a listing given `damaged` leaves it out instead and names it there. It is
 * never rewritten. */
export function storedRuns(db, id, damaged) {
  const rows = id
    ? db.prepare('SELECT id, payload, checksum FROM runs WHERE id = ?').all(id)
    : db.prepare('SELECT id, payload, checksum FROM runs').all();
  const runs = [];
  for (const row of rows)
    try {
      const bytes = decompress(row.payload, 'A stored engine run');
      if (digest(bytes) !== row.checksum) throw new Error(`Stored engine run changed: ${row.id}`);
      runs.push(JSON.parse(bytes));
    } catch (error) {
      if (!damaged) throw Object.assign(error, { runId: row.id });
      damaged.push({ id: row.id, reason: error.message });
    }
  return runs;
}

// A fragment is named by the digest of its own bytes: its value, with each
// large child left as a reference to that child's fragment. A value is
// stringified and hashed once, an unchanged part costs one lookup, and loading
// checks each fragment by its bytes alone. The prefix keeps these names apart
// from the earlier fragments, named by the digest of their whole decoded JSON
// (still read). A child becomes its own fragment from about 4 KB of JSON, by a
// deterministic estimate, so the same part of two artifacts is stored once.
const fragmentText = 'F2\n',
  fragmentPrefix = Buffer.from(fragmentText);
const splitSize = 4096;
const plainValue = (value) =>
  value !== null &&
  typeof value === 'object' &&
  (Array.isArray(value) ||
    Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null) &&
  typeof value.toJSON !== 'function';
function estimate(value, sizes) {
  if (typeof value === 'string') return value.length + 2;
  if (typeof value === 'number') return 8;
  if (value === null || typeof value === 'boolean') return 5;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 0;
  if (!plainValue(value)) return JSON.stringify(value)?.length ?? 0;
  let size = 2;
  if (Array.isArray(value)) for (const item of value) size += estimate(item, sizes) + 1;
  else for (const key of Object.keys(value)) size += key.length + 4 + estimate(value[key], sizes);
  sizes.set(value, size);
  return size;
}

export function storeArtifact(db, value) {
  const sizes = new Map();
  estimate(value, sizes);
  writable(sizes.get(value) ?? 0, 'An engine artifact');
  // Bottom up: every fragment's bytes and name.
  const fragments = new Map(),
    named = new Map();
  const large = (child) => plainValue(child) && sizes.get(child) >= splitSize;
  function fragment(node) {
    if (named.has(node)) return named.get(node);
    const parts = [];
    let data = node;
    if (Array.isArray(node))
      data = node.map((item, i) =>
        large(item) ? (parts.push([[i], fragment(item)]), null) : item,
      );
    else if (plainValue(node)) {
      data = {};
      for (const key of Object.keys(node)) {
        const child = node[key];
        Object.defineProperty(data, key, {
          value: large(child) ? (parts.push([[key], fragment(child)]), null) : child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    // Hashed as text; bytes are made only for a fragment not yet stored.
    const text = JSON.stringify({ data, parts }) + '\n';
    const hash = createHash('sha256').update(fragmentText).update(text).digest('hex');
    if (!fragments.has(hash)) fragments.set(hash, { text, children: parts.map(([, ref]) => ref) });
    if (plainValue(node)) named.set(node, hash);
    return hash;
  }
  const hash = fragment(value);
  // Top down: a stored fragment's children are stored with it.
  const exists = db.prepare('SELECT 1 FROM fragments WHERE hash = ?');
  const fresh = new Map();
  (function keep(ref) {
    if (fresh.has(ref) || exists.get(ref)) return;
    const { text, children } = fragments.get(ref);
    fresh.set(ref, {
      payload: brotliCompressSync(Buffer.from(fragmentText + text), {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      }),
      refs: JSON.stringify(children),
    });
    for (const child of children) keep(child);
  })(hash);
  const insert = db.prepare('INSERT OR IGNORE INTO fragments VALUES (?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [ref, { payload, refs }] of fresh) insert.run(ref, payload, refs);
    db.prepare('INSERT OR IGNORE INTO artifacts VALUES (?)').run(hash);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return hash;
}

/** Copy an artifact's fragments from one database to another as they are
 * stored: names, bytes and shared parts unchanged, whichever format named
 * them. False when the source does not hold the artifact. The copy is checked
 * when it is loaded. */
export function copyArtifact(source, target, ref) {
  if (!source || !validRef(ref)) return false;
  if (!source.prepare('SELECT 1 FROM artifacts WHERE hash = ?').get(ref)) return false;
  const select = source.prepare('SELECT payload, refs FROM fragments WHERE hash = ?'),
    exists = target.prepare('SELECT 1 FROM fragments WHERE hash = ?');
  const rows = [],
    seen = new Set(),
    pending = [ref];
  for (const hash of pending) {
    if (seen.has(hash) || exists.get(hash)) continue;
    seen.add(hash);
    const row = select.get(hash);
    if (!row) throw new Error('Missing engine fragment: ' + hash);
    rows.push(row);
    row.hash = hash;
    pending.push(...JSON.parse(row.refs));
  }
  const insert = target.prepare('INSERT OR IGNORE INTO fragments VALUES (?, ?, ?)');
  target.exec('BEGIN IMMEDIATE');
  try {
    for (const { hash, payload, refs } of rows) insert.run(hash, payload, refs);
    target.prepare('INSERT OR IGNORE INTO artifacts VALUES (?)').run(ref);
    target.exec('COMMIT');
  } catch (error) {
    target.exec('ROLLBACK');
    throw error;
  }
  return true;
}

/** Store a value again under the name it already has. A name of the earlier
 * format (the digest of the whole decoded JSON, as files of the older layout
 * are named) is kept as one fragment of that format. */
export function restoreArtifact(db, ref, value) {
  const bytes = encode(value);
  if (digest(bytes) !== ref) {
    if (storeArtifact(db, value) !== ref) throw new Error('Engine artifact identity changed');
    return ref;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO fragments VALUES (?, ?, ?)').run(
      ref,
      brotliCompressSync(encode({ data: value, parts: [] }), {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      }),
      '[]',
    );
    db.prepare('INSERT OR IGNORE INTO artifacts VALUES (?)').run(ref);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return ref;
}

export function loadArtifact(db, hash) {
  if (!validRef(hash)) throw new Error('Invalid stored object reference');
  if (!db.prepare('SELECT 1 FROM artifacts WHERE hash = ?').get(hash)) return undefined;
  const select = db.prepare('SELECT payload FROM fragments WHERE hash = ?');
  const loaded = new Map(),
    texts = new Map(),
    active = new Set(),
    // Every use of a fragment is parsed again; together they stay bounded.
    spend = decodedBudget('An engine artifact');
  // A fragment named by its bytes is checked by them once, and each of its uses
  // is parsed on its own, so callers receive ordinary values without copying.
  function parsed(ref) {
    active.add(ref);
    spend(texts.get(ref).length);
    const { data, parts } = JSON.parse(texts.get(ref));
    if (!Array.isArray(parts)) throw new Error('Invalid engine fragment');
    for (const [path, child] of parts) {
      if (!Array.isArray(path) || path.length !== 1)
        throw new Error('Invalid engine fragment path');
      if (!Object.hasOwn(data, path[0]) || data[path[0]] !== null)
        throw new Error('Invalid engine fragment path');
      Object.defineProperty(data, path[0], {
        value: read(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    active.delete(ref);
    return data;
  }
  function read(ref) {
    if (!validRef(ref) || active.has(ref)) throw new Error('Invalid engine fragment reference');
    if (texts.has(ref)) return parsed(ref);
    if (loaded.has(ref)) return loaded.get(ref);
    const row = select.get(ref);
    if (!row) throw new Error('Missing engine fragment: ' + ref);
    const bytes = decompress(row.payload, 'An engine fragment');
    if (bytes.subarray(0, fragmentPrefix.length).equals(fragmentPrefix)) {
      if (digest(bytes) !== ref) throw new Error('Stored object changed');
      texts.set(ref, bytes.subarray(fragmentPrefix.length).toString());
      return parsed(ref);
    }
    // An earlier fragment: named by the digest of its whole decoded JSON.
    spend(bytes.length);
    active.add(ref);
    const { data, parts } = JSON.parse(bytes);
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

/** The project's artifact database, read-only, or null when it has none. */
export async function openStoredArtifacts(project) {
  const path = artifactDatabasePath(project);
  try {
    await access(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  refuseLinks(storeFiles(path));
  return new DatabaseSync(path, { readOnly: true });
}

export async function readStoredArtifact(project, hash) {
  if (!validRef(hash)) throw new Error('Invalid stored object reference');
  const path = artifactDatabasePath(project);
  let db;
  try {
    await access(path);
    refuseLinks(storeFiles(path));
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
