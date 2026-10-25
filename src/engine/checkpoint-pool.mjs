/** Worker threads that check a question's intermediate role checkpoints
 * while its own thread checks the final one. Checkpoints are claimed from one
 * shared counter, by the workers and by the question's thread alike, so a
 * worker that fails leaves its checkpoints to the others; nothing waits for a
 * worker it could do itself. Workers take part only at a project revision they
 * have opened: the first question at a revision is checked in its own thread,
 * and the workers are warmed after it (sent its source records, the project
 * opened, the base built), so no question is slower for them. Off unless a
 * process asks for workers. */
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';

const workerUrl = new URL('./checkpoint-worker.mjs', import.meta.url);
const pool = [];
let size = 0,
  tasks = 0;
// A worker keeps at most this many source records.
const keptItems = 20000;

/** Use this many worker threads for checkpoints (0 for none). */
export function useCheckpointWorkers(count) {
  size = Math.max(0, Math.floor(count));
  while (pool.length > size) pool.pop().worker.terminate();
}
export const checkpointWorkers = () => size;

// Checks made by workers, for measurement.
export const checkpointStats = { byWorkers: 0 };

function spawn() {
  const entry = { worker: new Worker(workerUrl), sent: new Set(), listener: null, failed: false };
  entry.ready = new Promise((resolve) => (entry.onReady = resolve));
  entry.worker.unref();
  entry.worker.on('message', (message) => {
    if (message.ready) return entry.onReady();
    if (message.opened) entry.digest = message.opened;
    if (message.warmed !== undefined) return entry.onWarm?.();
    entry.listener?.(message);
  });
  const fail = () => {
    entry.failed = true;
    entry.listener?.({ id: entry.task, lost: true });
    const at = pool.indexOf(entry);
    if (at >= 0) pool.splice(at, 1);
  };
  entry.worker.on('error', fail);
  entry.worker.on('exit', fail);
  entry.worker.on('exit', () => (entry.onReady(), entry.onWarm?.()));
  return entry;
}
/** Whether every worker has this project revision open. */
export const checkpointsWarm = (project) =>
  size > 0 && pool.length === size && pool.every((entry) => entry.digest === project.digest);
// Source records are named by their content, in pieces, so the thread keeps
// answering while it does.
async function named(items, signal) {
  const keys = [];
  for (let i = 0; i < items.length; i++) {
    keys.push(itemKey(items[i]));
    if (i % 256 === 255) await yieldTurn(undefined, { signal });
  }
  return keys;
}
// Send a worker the records it has not been sent, in pieces.
async function send(entry, records, signal) {
  if (entry.sent.size > keptItems) {
    entry.worker.postMessage({ kind: 'forget' });
    entry.sent.clear();
  }
  const fresh = [...records].filter(([key]) => !entry.sent.has(key));
  for (const [key] of fresh) entry.sent.add(key);
  for (let at = 0; at < fresh.length; at += 256) {
    entry.worker.postMessage({ kind: 'items', items: fresh.slice(at, at + 256) });
    await yieldTurn(undefined, { signal });
  }
}
async function describe(project, input, result, signal) {
  const sourceKeys = await named(input.sources, signal),
    inputKeys = await named(result.inputs, signal);
  return {
    records: new Map([
      ...input.sources.map((item, i) => [sourceKeys[i], item]),
      ...result.inputs.map((item, i) => [inputKeys[i], item]),
    ]),
    task: {
      path: dirname(project.path),
      digest: project.digest,
      input: { ...input, sources: sourceKeys },
      result: { ...result, inputs: inputKeys },
    },
  };
}
// The last question checked without workers because they were cold, to be
// warmed for once the process is idle.
let cold = null;
export const noteColdCheckpoints = (project, input, result) => {
  if (size) cold = { project, input, result };
};
/** Warm the workers for the last question they were cold for; a process calls
 * this when a question is done. */
export async function warmPendingCheckpoints() {
  const pending = cold;
  cold = null;
  if (pending && !checkpointsWarm(pending.project))
    await warmCheckpoints(pending.project, pending.input, pending.result);
}
/** Warm the workers for a question's revision: its source records sent, the
 * project opened and the base built. Resolves when every worker has. */
export async function warmCheckpoints(project, input, result) {
  while (pool.length < size) pool.push(spawn());
  const { records, task } = await describe(project, input, result);
  await Promise.all(
    // A copy, as for checkpoints: a worker that fails leaves the pool.
    [...pool].map(async (entry) => {
      await send(entry, records);
      // One that ended while its records were sent has already been reported;
      // waiting for it to warm would wait forever (review 2026-10-25, #14).
      if (entry.failed) return;
      const warmed = new Promise((resolve) => (entry.onWarm = resolve));
      entry.worker.ref();
      entry.worker.postMessage({ kind: 'warm', ...task });
      await warmed;
      entry.onWarm = null;
      if (!entry.listener) entry.worker.unref();
    }),
  );
}
/** Start the workers and wait until each has loaded the engine. */
export async function readyCheckpointWorkers() {
  while (pool.length < size) pool.push(spawn());
  await Promise.all(pool.map((entry) => entry.ready));
}
const itemKey = (item) => createHash('sha256').update(JSON.stringify(item)).digest('hex');

/** Start checking these checkpoint levels in the workers. `claim()` takes the
 * next unclaimed level for the caller's own thread (or one a worker lost), and
 * `next()` waits for a worker's message. */
export async function startCheckpoints(project, input, result, levels, onCheck, signal) {
  while (pool.length < size) pool.push(spawn());
  const id = ++tasks;
  const counter = new Int32Array(new SharedArrayBuffer(8));
  const { records, task } = await describe(project, input, result, signal);
  const claimed = new Map(),
    retry = [];
  let wake = null,
    running = 0;
  const notify = () => {
    wake?.();
    wake = null;
  };
  // A copy: a worker that fails leaves the pool while records are sent.
  for (const entry of [...pool]) {
    await send(entry, records, signal);
    // One that ended meanwhile is given no task, so nothing waits on it.
    if (entry.failed) continue;
    entry.task = id;
    running++;
    entry.listener = (message) => {
      if (message.id !== id) return;
      if (message.claimed !== undefined) claimed.set(message.claimed, entry);
      else if (message.check) {
        claimed.delete(message.level);
        checkpointStats.byWorkers++;
        onCheck(message.level, message.check);
      } else if (message.level !== undefined) {
        // A checkpoint the worker could not check is checked by the caller.
        claimed.delete(message.level);
        retry.push(message.level);
      }
      if (message.done || message.lost) {
        if (message.lost)
          for (const [level, owner] of claimed)
            if (owner === entry) (claimed.delete(level), retry.push(level));
        entry.listener = null;
        entry.worker.unref();
        running--;
      }
      notify();
    };
    entry.worker.ref();
    entry.worker.postMessage({ id, ...task, levels, counter: counter.buffer });
  }
  return {
    claim() {
      if (retry.length) return retry.shift();
      if (Atomics.load(counter, 1)) return undefined;
      const at = Atomics.add(counter, 0, 1);
      return at < levels.length ? levels[at] : undefined;
    },
    // Whether a worker still holds, or may still claim, a checkpoint.
    pending: () => running > 0 || claimed.size > 0,
    next: () => new Promise((resolve) => (wake = resolve)),
    stop() {
      Atomics.store(counter, 1, 1);
      for (const entry of pool) if (entry.task === id && !entry.listener) entry.worker.unref();
    },
  };
}
