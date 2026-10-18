/** Load the pinned local extension once per connection, then disable extension loading. */
import { load } from 'sqlite-vec';
const loaded = new WeakMap();
export function loadSqliteVec(db) {
  if (loaded.has(db)) return loaded.get(db);
  try {
    db.enableLoadExtension(true);
    load(db);
    const version = db.prepare('SELECT vec_version() AS version').get().version;
    loaded.set(db, version);
    return version;
  } catch (cause) {
    throw Object.assign(
      new Error('SQLite vector matching is unavailable. Run npm install.', { cause }),
      {
        code: 'ROLE_MATCHING_UNAVAILABLE',
      },
    );
  } finally {
    db.enableLoadExtension(false);
  }
}
