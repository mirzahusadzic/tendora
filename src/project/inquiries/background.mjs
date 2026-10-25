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

/** Ask a child to stop, then escalate; a child that ignores SIGTERM is still reclaimed. */
export function stopChild(child, { termAfterMs = 2000, killAfterMs = 2000 } = {}) {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  let killTimer;
  const termTimer = setTimeout(() => {
    if (exited()) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (!exited()) child.kill('SIGKILL');
    }, killAfterMs);
  }, termAfterMs);
  const clear = () => {
    clearTimeout(termTimer);
    clearTimeout(killTimer);
  };
  child.once('exit', clear);
  return clear;
}

// One idle question process is kept warm: what it built for the last
// question's sources (their base) serves the next. It never holds the
// terminal open, and a cancelled or failed process is never reused.
let spare = null,
  requests = 0;
const alive = (child) => child.connected && child.exitCode === null && child.signalCode === null;
function takeWorker() {
  const child = spare && alive(spare) ? spare : null;
  spare = null;
  if (child) {
    child.ref();
    child.channel?.ref?.();
    return child;
  }
  return fork(fileURLToPath(new URL('./inquiry-process.mjs', import.meta.url)), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
    execArgv: [],
  });
}
function keepWorker(child) {
  if (spare || !alive(child)) {
    if (child.connected) child.disconnect();
    return;
  }
  child.unref();
  child.channel?.unref?.();
  child.stderr?.unref?.();
  spare = child;
  child.once('exit', () => {
    if (spare === child) spare = null;
  });
}
/** The idle question process, for tests: its process id. */
export const spareWorker = () => (spare && alive(spare) ? { pid: spare.pid } : null);

function projectProcess(project, request, progress, signal, onEngineUpdate) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = takeWorker();
    const id = ++requests;
    let settled = false,
      failure = '',
      stopping = null,
      reusable = false;
    const detach = () => {
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('close', onClose);
      child.stderr?.off('data', onData);
      signal?.removeEventListener('abort', cancel);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      detach();
      if (reusable) keepWorker(child);
      // A failed process is let go: without its channel it ends by itself.
      else if (!stopping && child.connected) child.disconnect();
      error ? reject(error) : resolve(value);
    };
    const cancel = () => {
      if (child.connected) child.send({ id, cancel: true }, () => {});
      stopping ??= stopChild(child);
      finish(signal.reason ?? new DOMException('Question cancelled', 'AbortError'));
    };
    const onData = (chunk) => {
      failure = (failure + chunk.toString()).slice(-4000);
    };
    const onMessage = (message) => {
      if (settled || message.id !== id) return;
      if (message.progress !== undefined) progress?.(message.progress);
      else if (message.run) onEngineUpdate?.(message.run);
      else if (message.error)
        finish(Object.assign(new Error(message.error.message), message.error));
      else if (message.result) {
        reusable = true;
        finish(null, message.result);
      }
    };
    const onError = (error) => finish(error);
    const onClose = (code, stopped) => {
      stopping?.();
      finish(
        new Error(failure.trim() || `Question process ended (${stopped ?? code}). Check again.`),
      );
    };
    child.stderr?.on('data', onData);
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('close', onClose);
    signal?.addEventListener('abort', cancel, { once: true });
    child.send(
      {
        id,
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
