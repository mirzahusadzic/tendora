/** JSON transport to the authored SEMCAT installed beside PENMAN. */
import { spawn } from 'node:child_process';
import { penmanPython, normalizedRoleProfile } from './graph-preparation.mjs';

export const comparisonProfile = 'semcat-runtime-e00a02b-tendora-v3';
export async function compareGraphs(
  comparisons,
  { signal, timeoutMs = 120000, ...parameters } = {},
) {
  if (!Array.isArray(comparisons) || comparisons.length > 128)
    throw new Error('At most 128 comparisons');
  signal?.throwIfAborted();
  const request = JSON.stringify({ comparisons, ...parameters });
  if (Buffer.byteLength(request) > 16 * 1024 * 1024)
    throw new Error('Comparison input exceeds 16 MB');
  const python = await penmanPython();
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-m', 'semcat_bridge'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '',
      errors = '',
      settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(signal.reason ?? new Error('Cancelled'));
    const timer = setTimeout(() => finish(new Error('SEMCAT comparison timed out')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) =>
      finish(new Error(`Authored SEMCAT unavailable: ${error.message}`)),
    );
    child.stdout.on('data', (data) => {
      output += data;
      if (Buffer.byteLength(output) > 32 * 1024 * 1024)
        finish(new Error('Comparison output exceeds 32 MB'));
    });
    child.stderr.on('data', (data) => {
      errors = (errors + data).slice(-4000);
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') finish(error);
    });
    child.on('close', (code) => {
      try {
        if (code) throw new Error(errors.trim() || `Python exited ${code}`);
        const result = JSON.parse(output);
        if (result.error) throw new Error(result.error);
        if (
          result.version !== 1 ||
          result.profile !== comparisonProfile ||
          result.normalizationProfile !== normalizedRoleProfile ||
          result.results?.length !== comparisons.length
        )
          throw new Error('Comparison response mismatch');
        finish(null, result);
      } catch (error) {
        finish(new Error(`Authored SEMCAT: ${error.message}`));
      }
    });
    if (signal?.aborted) abort();
    else child.stdin.end(request);
  });
}
