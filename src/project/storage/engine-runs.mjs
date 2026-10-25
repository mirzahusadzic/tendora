/** Durable engine runs and immutable input/client artifacts, owned by a project. */
import { readFile, mkdir, readdir, access } from 'node:fs/promises';
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
import { acquireFileLease, fileLeaseActive } from './locks.mjs';

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
    const release = await acquireFileLease(activeRunPath(project, id), {
      timeoutMs,
      owner: { id },
    });
    try {
      if (!(await fileLeaseActive(engineDeletionLockPath(project)))) return release;
    } catch (error) {
      await release().catch(() => {});
      throw error;
    }
    await release();
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
async function retainedRuns(project, id, damaged) {
  const path = artifactDatabasePath(project);
  try {
    await access(path);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const db = openArtifactDatabase(path);
  try {
    return storedRuns(db, id, damaged);
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
    !Array.isArray(run.stages) ||
    typeof run.startedAt !== 'string'
  )
    throw new Error(`Invalid engine run: ${id}`);
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
/** Every saved run, newest first. A damaged one (changed bytes, or a run
 * that is not one: another id, no calls, no start) fails the listing, unless
 * the caller collects it in `damaged`: a listing to read, never to rewrite. */
export async function listEngineRuns(project, { damaged } = {}) {
  let names = [];
  try {
    names = await readdir(join(root(project), 'engine', 'runs'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const valid = (id, read) => {
    try {
      return [validateRun(project, read(), id)];
    } catch (error) {
      if (!damaged) throw Object.assign(error, { runId: id });
      damaged.push({ id, reason: error.message });
      return [];
    }
  };
  const saved = await retainedRuns(project, undefined, damaged);
  const ids = new Set(saved.map((run) => run.id));
  const legacy = await Promise.all(
    names
      .filter((id) => /^[a-f0-9-]{36}$/u.test(id) && !ids.has(id))
      .map(async (id) => {
        let text;
        try {
          text = await readFile(join(runDirectory(project, id), 'run.json'), 'utf8');
        } catch (error) {
          if (!damaged) throw error;
          damaged.push({ id, reason: error.message });
          return [];
        }
        return valid(id, () => JSON.parse(text));
      }),
  );
  return [...saved.flatMap((run) => valid(run.id, () => run)), ...legacy.flat()].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}
