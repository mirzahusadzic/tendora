/** The Socratic methods off the workbench's thread: on a large corpus they
 * take seconds, and the workbench stays responsive meanwhile. `method` is
 * corpus (the six corpus-wide methods), elenchus, counterexample or maieutics. */
import { parentPort, workerData } from 'node:worker_threads';
import { openProject } from '../authoring/project.mjs';
import { corpusMethodsReport } from './methods.mjs';
import { elenchusReport } from './elenchus.mjs';
import { counterexampleReport } from './counterexample.mjs';
import { maieuticsReport } from './maieutics.mjs';
import { useTrimBackend } from '../../models/trim-backends.mjs';

// The trim backend of the process that started this thread (TENDORA_BACKEND).
useTrimBackend();

const project = await openProject(workerData.directory);
if (project.digest !== workerData.digest)
  throw new Error('The project changed while the methods read it; open it again.');
const methods = {
  corpus: () => corpusMethodsReport(project),
  elenchus: () => elenchusReport(project, { ...workerData.options, offline: true }),
  counterexample: () => counterexampleReport(project, workerData.options),
  maieutics: () => maieuticsReport(project, workerData.options),
};
parentPort.postMessage(await methods[workerData.method]());
