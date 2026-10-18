/** Keep graph compilation and chart work off the terminal's input/rendering loop. */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function backgroundProjectInquiry(
  project,
  placementId,
  query,
  progress,
  signal,
  options = {},
) {
  signal?.throwIfAborted();
  const { onEngineUpdate, ...settings } = options;
  const configuration = structuredClone(settings);
  return projectProcess(
    project,
    { placementId, query, options: configuration },
    progress,
    signal,
    onEngineUpdate,
  );
}

export function backgroundEngineStorage(project, signal) {
  return projectProcess(project, { maintenance: true }, undefined, signal);
}

function projectProcess(project, request, progress, signal, onEngineUpdate) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./inquiry-process.mjs', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      execArgv: [],
    });
    let settled = false,
      failure = '',
      killTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      error ? reject(error) : resolve(value);
    };
    const cancel = () => {
      if (child.connected) child.send({ cancel: true }, () => {});
      killTimer = setTimeout(() => child.kill('SIGTERM'), 2000);
      killTimer.unref();
      finish(signal.reason ?? new DOMException('Question cancelled', 'AbortError'));
    };
    child.stderr.on('data', (chunk) => {
      failure = (failure + chunk.toString()).slice(-4000);
    });
    child.on('message', (message) => {
      if (settled) return;
      if (message.progress !== undefined) progress?.(message.progress);
      else if (message.run) onEngineUpdate?.(message.run);
      else if (message.error) {
        const error = Object.assign(new Error(message.error.message), message.error);
        finish(error);
      } else if (message.result) finish(null, message.result);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, stopped) => {
      clearTimeout(killTimer);
      finish(
        new Error(failure.trim() || `Question process ended (${stopped ?? code}). Check again.`),
      );
    });
    signal?.addEventListener('abort', cancel, { once: true });
    child.send(
      {
        path: project.path,
        digest: project.digest,
        ...request,
      },
      (error) => {
        if (error) {
          child.kill();
          finish(error);
        }
      },
    );
    if (signal?.aborted) cancel();
  });
}
