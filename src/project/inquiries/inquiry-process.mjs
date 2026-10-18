/** One disposable local process owns an inquiry; corpus writes keep their existing locks. */
import { dirname } from 'node:path';
import { openProject } from '../authoring/project.mjs';
import { captureProjectInquiry } from './inquiry.mjs';
import { compactProjectStorage } from './project-storage.mjs';

const controller = new AbortController();
let started = false;
const send = (value) =>
  new Promise((resolve) => {
    if (process.connected) process.send(value, () => resolve());
    else resolve();
  });
process.on('disconnect', () => controller.abort());
process.on('message', async (message) => {
  if (message.cancel) return controller.abort();
  if (started) return;
  started = true;
  try {
    const project = await openProject(dirname(message.path));
    if (message.maintenance) {
      const result = await compactProjectStorage(project);
      await send({ result });
      return;
    }
    if (project.digest !== message.digest)
      throw new Error('The statements changed before the question started. Check again.');
    const result = await captureProjectInquiry(
      project,
      message.placementId,
      message.query,
      (progress) => send({ progress }),
      controller.signal,
      { ...message.options, onEngineUpdate: (run) => send({ run }) },
    );
    controller.signal.throwIfAborted();
    await send({ result });
  } catch (error) {
    await send({
      error: {
        name: error.name,
        message: error.message,
        engineRunId: error.engineRunId,
        client: error.client,
      },
    });
  } finally {
    if (process.connected) process.disconnect();
  }
});
