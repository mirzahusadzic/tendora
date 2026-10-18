/** Durable engine runs and immutable input/client artifacts, owned by a project. */
import { open, readFile, mkdir, readdir, unlink, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  artifactDatabasePath,
  openArtifactDatabase,
  storeArtifact,
  readStoredArtifact,
  storeRun,
  storedRuns,
} from './engine-artifacts.mjs';
import { fileLeaseActive } from './locks.mjs';

const root = (project) => dirname(project.path);
export const engineDeletionLockPath = (project) => join(root(project), '.engine-delete.lock');
const activeRunDirectory = (project) => join(root(project), 'engine', 'active');
const activeRunPath = (project, id) => join(activeRunDirectory(project), `${id}.lock`);
const runDirectory = (project, id) => {
  if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('Invalid engine run identity');
  return join(root(project), 'engine', 'runs', id);
};

export async function activeEngineRunIds(project) {
  let names;
  try {
    names = await readdir(activeRunDirectory(project));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const active = [];
  for (const name of names.filter((candidate) => /^[a-f0-9-]{36}\.lock$/u.test(candidate))) {
    if (await fileLeaseActive(join(activeRunDirectory(project), name)))
      active.push(name.slice(0, -5));
  }
  return active;
}

export async function acquireEngineRunLease(project, id, { timeoutMs = 10_000 } = {}) {
  if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('Invalid engine run identity');
  const started = performance.now();
  while (true) {
    while (await fileLeaseActive(engineDeletionLockPath(project))) {
      if (performance.now() - started >= timeoutMs)
        throw new Error('Engine data is being deleted. Try the inquiry again when it finishes.');
      await delay(10);
    }
    await mkdir(activeRunDirectory(project), { recursive: true });
    const path = activeRunPath(project, id);
    let handle;
    try {
      handle = await open(path, 'wx');
      await handle.writeFile(
        `${JSON.stringify({ id, pid: process.pid, at: new Date().toISOString() })}\n`,
      );
      if (await fileLeaseActive(engineDeletionLockPath(project))) {
        await handle.close();
        handle = null;
        await unlink(path).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        continue;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close();
        await unlink(path).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      };
    } catch (error) {
      if (handle) {
        await handle.close();
        await unlink(path).catch((failure) => {
          if (failure.code !== 'ENOENT') throw failure;
        });
      }
      throw error;
    }
  }
}
export async function putEngineArtifact(project, value) {
  const path = artifactDatabasePath(project);
  await mkdir(dirname(path), { recursive: true });
  const db = openArtifactDatabase(path);
  try {
    return storeArtifact(db, value);
  } finally {
    db.close();
  }
}
export const readEngineArtifact = readStoredArtifact;

export async function saveEngineRun(project, run) {
  if (run.projectId !== project.data.id) throw new Error('Engine run belongs to another project');
  runDirectory(project, run.id);
  delete run.cache;
  const path = artifactDatabasePath(project);
  await mkdir(dirname(path), { recursive: true });
  const db = openArtifactDatabase(path);
  try {
    storeRun(db, run);
  } finally {
    db.close();
  }
  return run;
}
async function retainedRuns(project, id) {
  const path = artifactDatabasePath(project);
  try {
    await access(path);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const db = openArtifactDatabase(path);
  try {
    return storedRuns(db, id);
  } finally {
    db.close();
  }
}
export async function readEngineRun(project, id) {
  const directory = runDirectory(project, id);
  const run =
    (await retainedRuns(project, id))[0] ??
    JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
  return validateRun(project, run, id);
}
function validateRun(project, run, id) {
  if (
    run.version !== 1 ||
    run.id !== id ||
    run.projectId !== project.data.id ||
    !Array.isArray(run.calls) ||
    !Array.isArray(run.stages)
  )
    throw new Error('Invalid engine run');
  if (run.status === 'running') {
    let alive = false;
    if (Number.isInteger(run.pid) && run.pid > 0) {
      try {
        process.kill(run.pid, 0);
        alive = true;
      } catch (error) {
        alive = error.code === 'EPERM';
      }
    }
    if (!alive)
      return {
        ...run,
        status: 'interrupted',
        error:
          'The previous engine process ended before recording an outcome. Inspect its retained calls or rerun.',
      };
  }
  return run;
}
export async function listEngineRuns(project) {
  let names = [];
  try {
    names = await readdir(join(root(project), 'engine', 'runs'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const saved = await retainedRuns(project);
  const ids = new Set(saved.map((run) => run.id));
  const legacy = await Promise.all(
    names
      .filter((id) => /^[a-f0-9-]{36}$/u.test(id) && !ids.has(id))
      .map(async (id) =>
        validateRun(
          project,
          JSON.parse(await readFile(join(runDirectory(project, id), 'run.json'), 'utf8')),
          id,
        ),
      ),
  );
  return [...saved.map((run) => validateRun(project, run, run.id)), ...legacy].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}
