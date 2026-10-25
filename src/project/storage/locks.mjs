/** Small cross-process file leases for project indexes that use read/modify/write updates. */
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { refuseLinks } from './links.mjs';

const ignoreMissing = (error) => {
  if (error.code !== 'ENOENT') throw error;
};
// Leases are published whole, but older releases and failing disks can leave an
// unreadable file. Once it outlives any ordinary write, it cannot be an owner.
export const malformedLeaseStaleMs = 30_000;

async function removeIfUnchanged(path, text) {
  // Another process may have replaced a stale lease with its own since it was read.
  if ((await readFile(path, 'utf8').catch(() => null)) !== text) return;
  await unlink(path).catch(ignoreMissing);
}

export async function fileLeaseActive(path, { staleMs = malformedLeaseStaleMs } = {}) {
  // Only a regular file the project owns can be a lease.
  refuseLinks([path]);
  let text, owner;
  try {
    text = await readFile(path, 'utf8');
    owner = JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) {
    let modified;
    try {
      modified = (await stat(path)).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (Date.now() - modified < staleMs) return true;
    await removeIfUnchanged(path, text);
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code !== 'ESRCH') throw error;
  }
  await removeIfUnchanged(path, text);
  return false;
}

/** Publish an owner record in one step; false when another lease already exists. */
async function publishLease(path, text) {
  const staged = `${path}.${randomUUID()}.tmp`;
  await writeFile(staged, text, { flag: 'wx' });
  try {
    await link(staged, path);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP'].includes(error.code)) throw error;
  } finally {
    await unlink(staged).catch(ignoreMissing);
  }
  // Filesystems without hard links fall back to exclusive creation; a reader
  // treats the brief empty interval as a live, recent owner.
  try {
    await writeFile(path, text, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

/** Acquire a lease and return its idempotent release. */
export async function acquireFileLease(
  path,
  {
    timeoutMs = 10_000,
    retryMs = 10,
    staleMs = malformedLeaseStaleMs,
    busyMessage = 'Project data is busy.',
    owner = {},
  } = {},
) {
  refuseLinks([path]);
  await mkdir(dirname(path), { recursive: true });
  const text = `${JSON.stringify({ ...owner, pid: process.pid, token: randomUUID(), at: new Date().toISOString() })}\n`;
  const started = performance.now();
  while (!(await publishLease(path, text))) {
    if (!(await fileLeaseActive(path, { staleMs }))) continue;
    if (performance.now() - started >= timeoutMs) throw new Error(busyMessage);
    await delay(retryMs);
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await removeIfUnchanged(path, text);
  };
}

export async function withFileLease(path, operation, options = {}) {
  const release = await acquireFileLease(path, options);
  let result;
  try {
    result = await operation();
  } catch (error) {
    // Cleanup must not replace the failure the caller needs to see.
    await release().catch((cleanup) => {
      if (error && typeof error === 'object' && !('leaseCleanupError' in error))
        error.leaseCleanupError = cleanup;
    });
    throw error;
  }
  await release();
  return result;
}
