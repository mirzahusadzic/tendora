/** A local process owns inquiries one at a time and stays warm between them:
 * the base of a question's sources stays for the next question on the same
 * sources. Corpus writes keep their existing locks. A cancelled inquiry ends
 * the process; an idle one ends after a while, or with its parent. */
import { dirname } from 'node:path';
import { availableParallelism } from 'node:os';
import { openProject } from '../authoring/project.mjs';
import { captureProjectInquiry } from './inquiry.mjs';
import { compactProjectStorage } from './project-storage.mjs';
import {
  readyCheckpointWorkers,
  useCheckpointWorkers,
  warmPendingCheckpoints,
} from '../../engine/checkpoint-pool.mjs';

// Role checkpoints are checked in two worker threads as well (more add
// little), started while the first question is read; each keeps a base of
// its own. TENDORA_CHECKPOINT_WORKERS sets their number, 0 for none.
useCheckpointWorkers(
  Number(process.env.TENDORA_CHECKPOINT_WORKERS ?? Math.min(2, availableParallelism() - 2)),
);
readyCheckpointWorkers().catch(() => {});

const idleMs = 5 * 60 * 1000;
let current = null,
  idle = null,
  served = 0;
const send = (value) =>
  new Promise((resolve) => {
    if (process.connected) process.send(value, () => resolve());
    else resolve();
  });
const rest = () => {
  clearTimeout(idle);
  idle = setTimeout(() => process.connected && process.disconnect(), idleMs);
};
process.on('disconnect', () => {
  current?.controller.abort();
  clearTimeout(idle);
});
process.on('message', async (message) => {
  if (message.cancel) {
    if (current?.id === message.id) current.controller.abort();
    return;
  }
  if (current) {
    await send({ id: message.id, error: { message: 'This question process is busy.' } });
    return;
  }
  clearTimeout(idle);
  const controller = new AbortController();
  current = { id: message.id, controller };
  served++;
  try {
    const project = await openProject(dirname(message.path));
    if (message.maintenance) {
      const result = await compactProjectStorage(project);
      await send({ id: message.id, result, worker: { pid: process.pid, served } });
      return;
    }
    if (project.digest !== message.digest)
      throw new Error('The statements changed before the question started. Check again.');
    const result = await captureProjectInquiry(
      project,
      message.placementId,
      message.query,
      (progress) => send({ id: message.id, progress }),
      controller.signal,
      { ...message.options, onEngineUpdate: (run) => send({ id: message.id, run }) },
    );
    controller.signal.throwIfAborted();
    await send({ id: message.id, result, worker: { pid: process.pid, served } });
  } catch (error) {
    await send({
      id: message.id,
      error: {
        name: error.name,
        message: error.message,
        engineRunId: error.engineRunId,
        client: error.client,
      },
    });
  } finally {
    current = null;
    if (controller.signal.aborted) process.connected && process.disconnect();
    else {
      rest();
      // The answer is sent: warm the checkpoint workers for its revision.
      warmPendingCheckpoints().catch(() => {});
    }
  }
});
