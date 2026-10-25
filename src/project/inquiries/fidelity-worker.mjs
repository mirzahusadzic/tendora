/** Corpus fidelity off the workbench's thread: on a large corpus the probes
 * take seconds, and the workbench stays responsive meanwhile. */
import { parentPort, workerData } from 'node:worker_threads';
import { openProject } from '../authoring/project.mjs';
import { fidelityReport } from './fidelity.mjs';
import { useTrimBackend } from '../../models/trim-backends.mjs';

// The trim backend of the process that started this thread (TENDORA_BACKEND).
useTrimBackend();

const project = await openProject(workerData.directory);
if (project.digest !== workerData.digest)
  throw new Error('The project changed while fidelity was read; open the role again.');
parentPort.postMessage(await fidelityReport(project));
