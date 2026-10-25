/** Reports computed off the workbench's thread: a worker gives one message,
 * and its promise settles exactly once. */
import { Worker } from 'node:worker_threads';

/** A worker's one message: the report, the worker's error, or "Stopped."
 * when `signal` stops it, whatever the worker does as it ends. */
export function inWorker(url, { workerData, signal, name }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Stopped.'));
    const worker = new Worker(url, { workerData });
    let settled = false;
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', stop);
      finish(value);
    };
    const stop = () => {
      settle(reject, new Error('Stopped.'));
      worker.terminate();
    };
    signal?.addEventListener('abort', stop, { once: true });
    worker.once('message', (value) => settle(resolve, value));
    worker.once('error', (error) => settle(reject, error));
    worker.once('exit', (code) =>
      settle(reject, new Error(`${name} stopped (${code}) before giving a report.`)),
    );
  });
}
