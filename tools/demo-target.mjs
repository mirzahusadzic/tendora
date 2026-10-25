/** Which directory `npm run demo` may write the working copy into. It replaces
 * only a copy of the demo: a directory whose manifest has the demo's id.
 * The snapshot, anything inside it, any folder holding the repository, and a
 * directory of anything else are refused, so a reset never deletes what is
 * not the demo's. Pure: the tool and its test share it. */
import { relative } from 'node:path';

const within = (parent, child) => {
  const path = relative(parent, child);
  return !path.startsWith('..') && !path.startsWith('/');
};

/** Why the target cannot take the copy, or null. `manifest` is the target's
 * project.json text (null when it has none), `entries` its files. */
export function refuseTarget({ target, root, source, demoId, exists, manifest, entries = [] }) {
  if (within(target, source) || within(source, target))
    return 'The working copy cannot replace the bundled snapshot.';
  if (within(target, root))
    return 'The working copy cannot replace a folder holding the repository.';
  if (!exists || !entries.length) return null;
  let id = null;
  try {
    id = manifest && JSON.parse(manifest).id;
  } catch {
    // An unreadable manifest is not the demo's.
  }
  return id === demoId ? null : 'It is not a copy of the demo, so it was left unchanged.';
}
