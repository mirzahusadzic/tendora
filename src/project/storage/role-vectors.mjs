/** Persistent vec0 float32 vectors; SQL cosine scores every scoped text. */
import { createHash } from 'node:crypto';
import { withDataDatabase } from './data-files.mjs';
import { loadSqliteVec } from './sqlite-vec.mjs';
const loaded = new WeakMap();
const schemas = new WeakMap();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourcePath = (ref, origin) =>
  `role-matching/${origin ? 'objects' : 'vectors'}/${origin?.ref ?? ref}.json`;
export const validRoleVector = (v) =>
  Array.isArray(v) &&
  v.length === 128 &&
  v.every(Number.isFinite) &&
  Math.abs(Math.hypot(...v) - 1) < 0.001;
const sourceJoin = `JOIN files source ON
  source.path = 'role-matching/' || CASE WHEN v.origin IS NULL THEN 'vectors/' ELSE 'objects/' END
    || coalesce(v.origin, v.ref) || '.json'
  AND source.checksum = coalesce(v.origin, v.ref) AND source.block IS NOT NULL`;

function database(directory, operation) {
  return withDataDatabase(directory, (db) => {
    if (
      !loaded.has(db) ||
      schemas.get(db) !== db.prepare('PRAGMA schema_version').get().schema_version
    ) {
      const version = loadSqliteVec(db);
      db.exec(`
        CREATE TABLE IF NOT EXISTS role_vector_models (
          id INTEGER PRIMARY KEY, profile TEXT NOT NULL, model TEXT NOT NULL, config TEXT NOT NULL,
          UNIQUE(profile, model, config)
        );
        CREATE TABLE IF NOT EXISTS role_vectors (
          id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, model_id INTEGER NOT NULL,
          text TEXT NOT NULL, acquired TEXT, origin TEXT, slot INTEGER
        );
        CREATE INDEX IF NOT EXISTS role_vectors_origin ON role_vectors(origin);
        CREATE VIRTUAL TABLE IF NOT EXISTS role_embeddings USING vec0(
          id INTEGER PRIMARY KEY, embedding float[128] distance_metric=cosine, chunk_size=8
        );
        CREATE TABLE IF NOT EXISTS role_vector_texts (
          path TEXT PRIMARY KEY, checksum TEXT, ref TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TRIGGER IF NOT EXISTS role_embedding_delete AFTER DELETE ON role_vectors BEGIN
          DELETE FROM role_embeddings WHERE id = old.id;
        END;
      `);
      for (const event of ['INSERT', 'UPDATE'])
        db.exec(`
        CREATE TRIGGER IF NOT EXISTS role_vectors_${event.toLowerCase()} AFTER ${event} ON files BEGIN
          DELETE FROM role_vectors WHERE ref = substr(new.path, 23, 64) AND origin IS NULL
            AND new.path = 'role-matching/vectors/' || ref || '.json'
            AND (new.block IS NULL OR new.checksum IS NOT ref);
          DELETE FROM role_vectors WHERE origin = substr(new.path, 23, 64)
            AND new.path = 'role-matching/objects/' || origin || '.json'
            AND (new.block IS NULL OR new.checksum IS NOT origin);
          DELETE FROM role_vector_texts WHERE path = new.path
            AND (new.block IS NULL OR new.checksum IS NOT checksum);
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS role_vectors_delete AFTER DELETE ON files BEGIN
          DELETE FROM role_vectors WHERE ref = substr(old.path, 23, 64) AND origin IS NULL
            AND old.path = 'role-matching/vectors/' || ref || '.json';
          DELETE FROM role_vectors WHERE origin = substr(old.path, 23, 64)
            AND old.path = 'role-matching/objects/' || origin || '.json';
          DELETE FROM role_vector_texts WHERE path = old.path;
        END;
      `);
      loaded.set(db, {
        profile: 'sqlite-vec-cosine-f32-v1',
        version,
        dimensions: 128,
        metric: 'cosine',
        precision: 'float32',
        selection: 'complete-scope',
      });
      schemas.set(db, db.prepare('PRAGMA schema_version').get().schema_version);
    }
    return operation(db);
  });
}

function metadata(directory, keys, byText) {
  return database(directory, (db) => {
    const rows = db
      .prepare(
        `
      SELECT requested.key AS ordinal, v.ref, v.text, v.acquired, v.origin, v.slot,
        m.profile, m.model, m.config
      FROM json_each(?) requested
      ${
        byText
          ? `JOIN role_vector_texts t ON t.path = requested.value
        LEFT JOIN files idx ON idx.path = t.path
        JOIN role_vectors v ON v.ref = t.ref`
          : 'JOIN role_vectors v ON v.ref = requested.value'
      }
      JOIN role_vector_models m ON m.id = v.model_id
      ${sourceJoin}
      ${
        byText
          ? `WHERE (t.checksum = idx.checksum AND idx.block IS NOT NULL)
        OR (t.checksum IS NULL AND idx.path IS NULL)`
          : ''
      }
    `,
      )
      .all(JSON.stringify(keys));
    const result = Array(keys.length).fill(null);
    for (const row of rows)
      result[row.ordinal] = {
        ref: row.ref,
        text: row.text,
        profile: row.profile,
        model: row.model,
        embedding: JSON.parse(row.config),
        acquiredAt: row.acquired,
        ...(row.origin ? { origin: { ref: row.origin, slot: row.slot } } : {}),
      };
    return result;
  });
}
export const indexedRoleVectors = (directory, refs) => metadata(directory, refs, false);
export const indexedRoleTexts = (directory, paths) => metadata(directory, paths, true);
export const hasRoleVectorIndex = (directory) =>
  database(directory, (db) => Boolean(db.prepare('SELECT 1 FROM role_vectors LIMIT 1').get()));

export function retainRoleVectors(directory, entries) {
  if (!entries.length) return;
  database(directory, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const source = db.prepare('SELECT checksum FROM files WHERE path = ? AND block IS NOT NULL');
      const model = db.prepare(
        'INSERT OR IGNORE INTO role_vector_models(profile,model,config) VALUES(?,?,?)',
      );
      const modelId = db.prepare(
        'SELECT id FROM role_vector_models WHERE profile=? AND model=? AND config=?',
      );
      const insert = db.prepare(
        'INSERT OR IGNORE INTO role_vectors(ref,model_id,text,acquired,origin,slot) VALUES(?,?,?,?,?,?)',
      );
      const embedding = db.prepare(
        'INSERT INTO role_embeddings(id,embedding) SELECT id,? FROM role_vectors WHERE ref=?',
      );
      for (const { ref, origin, ...value } of entries) {
        if (
          !validRoleVector(value.vector) ||
          digest(JSON.stringify(value) + '\n') !== ref ||
          source.get(sourcePath(ref, origin))?.checksum !== (origin?.ref ?? ref)
        )
          throw new Error('Stored role vector changed');
        const config = JSON.stringify(value.embedding ?? null);
        model.run(value.profile, value.model, config);
        const id = modelId.get(value.profile, value.model, config).id;
        if (
          insert.run(
            ref,
            id,
            value.text,
            value.acquiredAt ?? null,
            origin?.ref ?? null,
            origin?.slot ?? null,
          ).changes
        )
          embedding.run(new Uint8Array(new Float32Array(value.vector).buffer), ref);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

export function retainRoleTexts(directory, entries) {
  if (!entries.length) return;
  database(directory, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const source = db.prepare('SELECT checksum FROM files WHERE path = ?');
      const insert = db.prepare('INSERT OR REPLACE INTO role_vector_texts VALUES (?, ?, ?)');
      for (const { path, bytes, ref } of entries) {
        const current = source.get(path);
        if (bytes === undefined) {
          if (current) continue; // Inline legacy readings never override an authored text index.
          db.prepare('INSERT OR IGNORE INTO role_vector_texts VALUES (?, NULL, ?)').run(path, ref);
          continue;
        }
        const checksum = digest(bytes);
        if (JSON.parse(bytes).ref !== ref) throw new Error('Stored role text changed');
        if (current?.checksum !== checksum) continue; // A newer concurrent inquiry owns the mapping.
        insert.run(path, checksum, ref);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

/** Full-scope scoring uses native cosine over vec0 storage, without a top-k cutoff. */
export function scoreRoleVectors(directory, refs) {
  if (!Array.isArray(refs) || !refs.length) throw new Error('Role matching needs a query vector');
  return database(directory, (db) => {
    const rows = db
      .prepare(
        `
      WITH query AS MATERIALIZED (
        SELECT e.embedding FROM role_vectors v JOIN role_embeddings e ON e.id=v.id
        ${sourceJoin} WHERE v.ref=?
      )
      SELECT requested.key AS ordinal,
        max(-1.0, min(1.0, 1.0-vec_distance_cosine(e.embedding, query.embedding))) AS score
      FROM json_each(?) requested JOIN role_vectors v ON v.ref=requested.value
      JOIN role_embeddings e ON e.id=v.id ${sourceJoin} CROSS JOIN query
      ORDER BY requested.key
    `,
      )
      .all(refs[0], JSON.stringify(refs));
    if (rows.length !== refs.length || rows.some((row) => !Number.isFinite(row.score)))
      throw new Error('Role matching requires every retained vector');
    return { scores: rows.map((row) => row.score), scoring: loaded.get(db) };
  });
}

/** Native vectors are a rebuildable projection, included in the project's cache budget. */
export function roleVectorIndexBytes(directory) {
  return withDataDatabase(directory, (db) => {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'role_vectors'").get()) return 0;
    const bytes = db
      .prepare(
        `
      SELECT coalesce(sum(pgsize), 0) AS bytes FROM dbstat
      WHERE name GLOB 'role_*' OR name GLOB 'sqlite_autoindex_role_*'
        OR name IN ('sqlite_schema', 'sqlite_sequence')
    `,
      )
      .get().bytes;
    return bytes - db.prepare('PRAGMA page_size').get().page_size;
  });
}
export function discardRoleVectorIndex(directory) {
  withDataDatabase(directory, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const name of [
        'role_vectors_insert',
        'role_vectors_update',
        'role_vectors_delete',
        'role_embedding_delete',
      ])
        db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      for (const name of [
        'role_embeddings',
        'role_vectors',
        'role_vector_models',
        'role_vector_texts',
      ])
        db.exec(`DROP TABLE IF EXISTS ${name}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    loaded.delete(db);
    schemas.delete(db);
    db.exec('VACUUM');
  });
}
