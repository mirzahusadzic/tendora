/** Local PENMAN process adapter. No shell, model acquisition or project mutation. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export const preparationProfile = 'amr-roles-v1';
export const normalizedRoleProfile = 'amr-normalized-roles-v1';
export const preparationDigest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const localPython = fileURLToPath(
  new URL(
    process.platform === 'win32' ? '../../.venv/Scripts/python.exe' : '../../.venv/bin/python',
    import.meta.url,
  ),
);
export const penmanPython = async () => {
  if (process.env.PENMAN_PYTHON) return process.env.PENMAN_PYTHON;
  try {
    await access(localPython, constants.X_OK);
    return localPython;
  } catch {
    return 'python3';
  }
};
const setupHint =
  'Run npm run setup:python, or set PENMAN_PYTHON to an interpreter with the declared Python dependencies.';

export async function prepareGraphs(
  graphs,
  { signal, python, timeoutMs = 30000, profile = preparationProfile, roles = [] } = {},
) {
  signal?.throwIfAborted();
  if (!Array.isArray(graphs) || graphs.length > 128)
    throw new Error('Prepare at most 128 graphs per batch');
  const request = JSON.stringify({ profile, graphs, roles });
  if (Buffer.byteLength(request) > 16 * 1024 * 1024)
    throw new Error('Graph preparation input exceeds 16 MB');
  const executable = python ?? (await penmanPython());
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [fileURLToPath(new URL('./prepare_graphs.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '',
      settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(result);
    };
    const abort = () => finish(signal.reason ?? new Error('Cancelled'));
    const timer = setTimeout(() => finish(new Error('Graph preparation timed out')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.on('error', (error) =>
      finish(new Error(`PENMAN unavailable: ${error.message}. ${setupHint}`)),
    );
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 32 * 1024 * 1024)
        finish(new Error('Graph preparation output exceeds 32 MB'));
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') finish(error);
    });
    child.on('close', (code) => {
      try {
        let value;
        try {
          value = JSON.parse(stdout);
        } catch (error) {
          if (code === 0) throw error;
        }
        if (code !== 0 || value.error) {
          const detail = value?.error || stderr.trim() || `Python exited ${code}`;
          const missing = detail.match(/No module named ['"]([^'"]+)['"]/u);
          throw new Error(missing ? `No module named '${missing[1]}'. ${setupHint}` : detail);
        }
        if (
          value.version !== 1 ||
          value.profile !== profile ||
          value.results?.length !== graphs.length
        )
          throw new Error('Preparation response mismatch');
        finish(null, value);
      } catch (error) {
        finish(new Error(`PENMAN preparation failed: ${error.message}`));
      }
    });
    child.stdin.end(request);
  });
}
