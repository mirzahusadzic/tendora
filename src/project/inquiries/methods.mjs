/** The Socratic methods that read the whole corpus at once, together: what
 * the workbench shows at the root role. Read-only and offline. */
import { Worker } from 'node:worker_threads';
import { dirname } from 'node:path';
import { aporiaReport } from './aporia.mjs';
import { dilemmaReport } from './dilemma.mjs';
import { analogyReport } from './analogy.mjs';
import { dialogueReport } from './dialogue.mjs';
import { equivocationReport } from './equivocation.mjs';
import { divisionReport } from './division.mjs';

/** Each corpus-wide method's report, by method. */
export async function corpusMethodsReport(project, { signal } = {}) {
  const reports = {};
  for (const [name, report] of [
    ['aporia', aporiaReport],
    ['dilemma', dilemmaReport],
    ['analogy', analogyReport],
    ['dialogue', dialogueReport],
    ['equivocation', equivocationReport],
    ['division', divisionReport],
  ]) {
    signal?.throwIfAborted();
    reports[name] = await report(project, { signal });
  }
  return reports;
}

/** The reports from a worker thread; `signal` stops it. */
export function corpusMethodsInWorker(project, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./methods-worker.mjs', import.meta.url), {
      workerData: { directory: dirname(project.path), digest: project.digest },
    });
    const stop = () => worker.terminate();
    signal?.addEventListener('abort', stop, { once: true });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      signal?.removeEventListener('abort', stop);
      if (code) reject(new Error(signal?.aborted ? 'Stopped.' : `The methods stopped (${code}).`));
    });
  });
}
