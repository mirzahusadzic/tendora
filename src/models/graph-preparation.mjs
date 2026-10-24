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

// Normalization is a function of the reading, the profile and the roles, for
// one interpreter: a reading prepared once in this process is not sent to
// Python again, and each reading is prepared on its own, so only the new ones
// of a batch are sent. An empty batch, or one for an interpreter named by the
// caller, always goes to Python.
const preparedItems = new Map(),
  preparedScopes = new Map(),
  preparedLimit = 50000;
const usage = { reused: 0, sent: 0, servers: 0 };
/** How readings were prepared in this process, for tests. */
export const preparationUsage = () => ({ ...usage });

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
  const shared = !python && graphs.length > 0;
  const scope = JSON.stringify([executable, profile, roles]);
  const itemKey = (graph) => `${scope}\u0000${JSON.stringify(graph)}`;
  const known = shared ? graphs.map((graph) => preparedItems.get(itemKey(graph))) : [];
  const missing = shared ? graphs.filter((_, i) => !known[i]) : graphs;
  if (shared) usage.reused += graphs.length - missing.length;
  if (shared && preparedScopes.has(scope) && !missing.length) {
    const { penmanVersion, roles: roleMap } = preparedScopes.get(scope);
    return {
      version: 1,
      profile,
      penmanVersion,
      results: known.map((item) => structuredClone(item)),
      roles: structuredClone(roleMap),
    };
  }
  const sent = shared && preparedScopes.has(scope) ? missing : graphs;
  usage.sent += sent.length;
  const options = {
    signal,
    executable,
    timeoutMs,
    profile,
    request: JSON.stringify({ profile, graphs: sent, roles }),
  };
  const prepared = python
    ? await spawnPreparation(sent, options)
    : await servePreparation(sent, options);
  if (!shared) return prepared;
  preparedScopes.set(scope, { penmanVersion: prepared.penmanVersion, roles: prepared.roles });
  prepared.results.forEach((item, i) => {
    if (preparedItems.size >= preparedLimit)
      preparedItems.delete(preparedItems.keys().next().value);
    preparedItems.set(itemKey(sent[i]), structuredClone(item));
  });
  if (sent === graphs) return prepared;
  const fresh = new Map(sent.map((graph, i) => [graph, prepared.results[i]]));
  return {
    ...prepared,
    results: graphs.map((graph, i) => (known[i] ? structuredClone(known[i]) : fresh.get(graph))),
  };
}

const script = fileURLToPath(new URL('./prepare_graphs.py', import.meta.url));
const failure = (detail) => {
  const missing = detail.match(/No module named ['"]([^'"]+)['"]/u);
  return new Error(missing ? `No module named '${missing[1]}'. ${setupHint}` : detail);
};
const checked = (value, graphs, profile) => {
  if (value.error) throw failure(value.error);
  if (value.version !== 1 || value.profile !== profile || value.results?.length !== graphs.length)
    throw new Error('Preparation response mismatch');
  return value;
};

// One preparation process per interpreter stays open: starting Python and
// loading PENMAN cost more than preparing a question's reading. It answers
// one request per line, in turn; it holds no process open while idle, and a
// failed, cancelled or timed-out one is replaced by a new one.
const servers = new Map();
function preparationServer(executable) {
  const open = servers.get(executable);
  if (open && !open.closed) return open;
  const child = spawn(executable, [script, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  usage.servers++;
  const server = { child, pending: [], buffer: '', stderr: '', closed: false };
  const handles = [child, child.stdin, child.stdout, child.stderr];
  server.hold = (held) => handles.forEach((handle) => (held ? handle.ref?.() : handle.unref?.()));
  server.close = (error) => {
    if (server.closed) return;
    server.closed = true;
    if (servers.get(executable) === server) servers.delete(executable);
    child.kill();
    for (const waiting of server.pending.splice(0)) waiting.settle(error);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    server.buffer += chunk;
    for (let at; (at = server.buffer.indexOf('\n')) >= 0;) {
      const line = server.buffer.slice(0, at);
      server.buffer = server.buffer.slice(at + 1);
      server.pending.shift()?.settle(null, line);
    }
    if (!server.pending.length) server.hold(false);
  });
  child.stderr.on('data', (chunk) => {
    if (server.stderr.length < 4096) server.stderr += chunk;
  });
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') server.close(error);
  });
  child.on('error', (error) =>
    server.close(new Error(`PENMAN unavailable: ${error.message}. ${setupHint}`)),
  );
  child.on('close', (code) =>
    server.close(failure(server.stderr.trim() || `Python exited ${code}`)),
  );
  servers.set(executable, server);
  return server;
}

function servePreparation(graphs, { signal, executable, timeoutMs, profile, request }) {
  return new Promise((resolve, reject) => {
    // Cancelled before it was sent: it settles at once, and the shared process
    // is left serving.
    if (signal?.aborted) return reject(signal.reason ?? new Error('Cancelled'));
    const server = preparationServer(executable);
    let timer;
    // A cancelled request stops the process; another request it was serving
    // fails with an error of its own, not with this one's cancellation.
    const abort = () => {
      const at = server.pending.indexOf(entry);
      if (at >= 0) server.pending.splice(at, 1);
      settle(signal.reason ?? new Error('Cancelled'));
      server.close(new Error('PENMAN preparation stopped: another request was cancelled.'));
    };
    const settle = (error, line) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        if (error) throw error;
        resolve(checked(JSON.parse(line), graphs, profile));
      } catch (problem) {
        reject(
          problem.message.startsWith('PENMAN')
            ? problem
            : new Error(`PENMAN preparation failed: ${problem.message}`),
        );
      }
    };
    const entry = { settle };
    timer = setTimeout(() => server.close(new Error('Graph preparation timed out')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    server.pending.push(entry);
    server.hold(true);
    server.child.stdin.write(request + '\n');
  });
}

function spawnPreparation(graphs, { signal, executable, timeoutMs, profile, request }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
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
        if (code !== 0 && !value?.error) throw failure(stderr.trim() || `Python exited ${code}`);
        finish(null, checked(value, graphs, profile));
      } catch (error) {
        finish(new Error(`PENMAN preparation failed: ${error.message}`));
      }
    });
    child.stdin.end(request);
  });
}
