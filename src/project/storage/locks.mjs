/** Small cross-process file leases for project indexes that use read/modify/write updates. */
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function fileLeaseActive(path) {
  let owner;
  try {
    owner = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    return true;
  }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code !== 'ESRCH') throw error;
  }
  await unlink(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return false;
}

export async function withFileLease(
  path,
  operation,
  { timeoutMs = 10_000, retryMs = 10, busyMessage = 'Project data is busy.' } = {},
) {
  await mkdir(dirname(path), { recursive: true });
  const started = performance.now();
  let handle;
  while (!handle) {
    try {
      handle = await open(path, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await fileLeaseActive(path))) continue;
      if (performance.now() - started >= timeoutMs) throw new Error(busyMessage);
      await delay(retryMs);
    }
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
    );
    return await operation();
  } finally {
    await handle.close();
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
