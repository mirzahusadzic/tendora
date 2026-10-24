/** Give durable material priority; budget rebuildable checks against the whole project. */
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compactDataFiles } from '../storage/data-files.mjs';
import { compactEngineStorage, engineStorageBudget, retainRecordings } from './engine-storage.mjs';
import { roleVectorIndexBytes, discardRoleVectorIndex } from '../storage/role-vectors.mjs';
import { activeEngineRunIds, engineDeletionLockPath } from '../storage/engine-runs.mjs';
import { withFileLease } from '../storage/locks.mjs';

// Soft, like the engine cache: compaction aims for it and never fails on it.
export const projectStorageTarget = 512 * 1024 * 1024;
export async function projectStorageUsage(project) {
  const root = dirname(project.path),
    areas = {};
  async function visit(path, area) {
    for (const entry of await readdir(path, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      const child = join(path, entry.name),
        group = area ?? entry.name;
      if (entry.isDirectory()) await visit(child, group);
      else if (entry.isFile()) {
        let info;
        try {
          info = await stat(child);
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        const size = (areas[group] ??= { bytes: 0, allocated: 0, files: 0 });
        size.bytes += info.size;
        size.allocated += info.blocks * 512;
        size.files++;
      }
    }
  }
  await visit(root);
  return {
    bytes: Object.values(areas).reduce((sum, a) => sum + a.bytes, 0),
    allocated: Object.values(areas).reduce((sum, a) => sum + a.allocated, 0),
    areas,
  };
}
export async function compactProjectStorage(
  project,
  { target = projectStorageTarget, cacheBudget = engineStorageBudget, ...options } = {},
) {
  const before = await projectStorageUsage(project);
  const recordings = await retainRecordings(project, { dryRun: options.dryRun });
  const material = await compactDataFiles(dirname(project.path));
  const packed = await projectStorageUsage(project);
  const vectorBytes = roleVectorIndexBytes(dirname(project.path));
  const durable =
    packed.allocated -
    (packed.areas.engine?.allocated ?? 0) -
    (packed.areas.recordings?.allocated ?? 0) -
    vectorBytes;
  // Retaining an answer avoids an expensive recheck when switching questions.
  // Rebuilding the native projection from its retained vectors is much cheaper.
  const budget = Math.max(64 * 1024, Math.min(cacheBudget, target - durable));
  let engine;
  try {
    const force =
      options.force ||
      (packed.areas.engine?.allocated ?? 0) + (packed.areas.recordings?.allocated ?? 0) > budget;
    engine = await compactEngineStorage(project, { ...options, force, budget });
  } catch (error) {
    if (error.code !== 'ENGINE_STORAGE_REQUIRED') throw error;
    // Growing authored material and pinned evidence are never deleted to reach a
    // size target; saved questions beyond the soft bound are kept as they are.
    try {
      engine =
        budget === cacheBudget
          ? { kept: true, reason: error.message }
          : await compactEngineStorage(project, { ...options, budget: cacheBudget });
    } catch (again) {
      if (again.code !== 'ENGINE_STORAGE_REQUIRED') throw again;
      engine = { kept: true, reason: again.message };
    }
  }
  let after = await projectStorageUsage(project),
    vectorsEvicted = false;
  // Keep the persistent index for large corpora. For a small project whose retained
  // material fits the target, cache pressure may evict the derived vectors after use.
  if (
    after.allocated > target &&
    vectorBytes &&
    after.allocated - vectorBytes <= target &&
    !options.dryRun
  ) {
    await withFileLease(engineDeletionLockPath(project), async () => {
      if ((await activeEngineRunIds(project)).length) return;
      discardRoleVectorIndex(dirname(project.path));
      vectorsEvicted = true;
    });
    after = await projectStorageUsage(project);
  }
  return {
    before,
    after,
    material: { ...material, bytes: after.areas['material.sqlite']?.bytes ?? material.bytes },
    recordings,
    engine,
    vectorsEvicted,
    target,
    withinTarget: after.allocated <= target,
  };
}
