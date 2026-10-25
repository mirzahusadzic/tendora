/** The Socratic methods that read the whole corpus at once, together: what
 * the workbench shows at the root role. Read-only and offline. */
import { dirname } from 'node:path';
import { aporiaReport } from './aporia.mjs';
import { dilemmaReport } from './dilemma.mjs';
import { analogyReport } from './analogy.mjs';
import { dialogueReport } from './dialogue.mjs';
import { equivocationReport } from './equivocation.mjs';
import { divisionReport } from './division.mjs';
import { inWorker } from './worker.mjs';

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

/** A method's report from a worker thread (`method`: corpus, elenchus,
 * counterexample or maieutics, with its `options`). The promise settles once:
 * with the report, with the worker's error, or with "Stopped." when `signal`
 * stops it, whatever the worker does as it ends. */
export function methodInWorker(project, method, options = {}, { signal } = {}) {
  return inWorker(new URL('./methods-worker.mjs', import.meta.url), {
    workerData: { directory: dirname(project.path), digest: project.digest, method, options },
    signal,
    name: 'The methods',
  });
}

/** The corpus-wide reports from a worker thread; `signal` stops it. */
export const corpusMethodsInWorker = (project, { signal } = {}) =>
  methodInWorker(project, 'corpus', {}, { signal });
