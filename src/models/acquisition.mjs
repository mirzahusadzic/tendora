/** eGemma acquisition: request exact texts, validate cohorts, and adapt returned AMRs. */
import { graphView } from '../amr/graph.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';

const base = process.env.EGEMMA_URL ?? 'http://127.0.0.1:8000';
/** The service key: a file named by EGEMMA_API_KEY_FILE, which keeps it out of
 * the environment child processes and logs inherit, else EGEMMA_API_KEY. */
export function serviceKey(env = process.env) {
  if (env.EGEMMA_API_KEY_FILE) {
    try {
      const value = readFileSync(env.EGEMMA_API_KEY_FILE, 'utf8').trim();
      if (value) return value;
    } catch (error) {
      throw new Error(`EGEMMA_API_KEY_FILE cannot be read: ${error.message}`);
    }
    throw new Error('EGEMMA_API_KEY_FILE names an empty file.');
  }
  return env.EGEMMA_API_KEY ?? 'dummy-key';
}
const retryDelay = (response, detail) => {
  const header = response.headers?.get('Retry-After');
  if (header !== null && header !== undefined) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  // eGemma's limiter supplies its delay in JSON detail instead of Retry-After.
  const seconds = detail.match(/\bTry again in (\d+(?:\.\d+)?) seconds?\b/iu)?.[1];
  return seconds === undefined ? null : Number(seconds) * 1000;
};
async function post(path, body, signal, progress = () => {}) {
  let socketRetries = 0,
    rateRetries = 0;
  while (true) {
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceKey()}`,
          Connection: 'close',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (
        socketRetries === 0 &&
        ['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code)
      ) {
        socketRetries++;
        continue;
      }
      const operation = path === '/amr/parse-batch' ? 'AMR parsing' : 'Embeddings';
      const reason =
        error.name === 'TimeoutError'
          ? 'timed out after 60 seconds'
          : [error.message, error.cause?.code ?? error.cause?.message].filter(Boolean).join(': ');
      throw new Error(`${operation}: ${reason}`, { cause: error });
    }
    if (response.ok) return response.json();
    let detail = '';
    try {
      const body = await response.json();
      if (typeof body.detail === 'string') detail = body.detail.slice(0, 512);
    } catch {
      // An HTTP error can have a non-JSON body.
    }
    const waitMs = response.status === 429 ? retryDelay(response, detail) : null;
    if (waitMs !== null && waitMs <= 120000 && rateRetries === 0) {
      rateRetries++;
      progress(`eGemma rate limit: retrying in ${Math.ceil(waitMs / 1000)} s (1 retry maximum)`);
      await delay(waitMs, undefined, signal ? { signal } : undefined);
      continue;
    }
    throw new Error(`eGemma ${path}: HTTP ${response.status}${detail ? ': ' + detail : ''}`);
  }
}

const normalize = (row) => {
  if (!Array.isArray(row) || row.length !== 768 || row.some((n) => !Number.isFinite(n)))
    throw new Error('expected a finite 768d embedding');
  const cut = row.slice(0, 128);
  const length = Math.hypot(...cut);
  if (row.length !== 768 || !(length > 0)) throw new Error('expected a nonzero 768d embedding');
  return cut.map((value) => value / length);
};
const identity = (value) => typeof value === 'string' && value.trim() !== '';
// Model identities become provenance; malformed responses must not become "undefined@undefined".
function modelIdentity(response, service) {
  if (!identity(response?.model) || !identity(response?.revision))
    throw new Error(`${service} response lacks a model identity`);
  return `${response.model}@${response.revision}`;
}
function parsedItem(item) {
  modelIdentity(item, 'AMR');
  if (!identity(item.decode_status)) throw new Error('AMR response lacks a decode status');
  if (item.decode_status === 'ok' && !identity(item.penman))
    throw new Error('AMR response marked ok without PENMAN');
  return item;
}
export const dot = (left, right) => left.reduce((sum, value, i) => sum + value * right[i], 0);

export async function embedTexts(texts, signal) {
  if (
    !Array.isArray(texts) ||
    !texts.length ||
    texts.some((text) => typeof text !== 'string' || !text.trim())
  )
    throw new Error('embedTexts needs nonempty strings');
  const embedded = await post(
    '/embed/texts',
    { texts, dimensions: 768, prompt_name: 'STS' },
    signal,
  );
  if (embedded?.embeddings?.length !== texts.length || embedded.dimensions !== 768)
    throw new Error('embedding cohort mismatch');
  const model = modelIdentity(embedded, 'Embedding');
  return {
    vectors: embedded.embeddings.map(normalize),
    model,
    embedding: {
      prompt: 'STS',
      acquiredDimensions: 768,
      usedDimensions: 128,
      normalization: 'L2 after leading 128d cut',
    },
  };
}

/** Parse exact texts without requesting embeddings or an answer model. */
export async function parseTexts(texts, progress = () => {}, signal) {
  if (
    !Array.isArray(texts) ||
    !texts.length ||
    texts.some((value) => typeof value !== 'string' || !value.trim())
  ) {
    throw new Error('parseTexts needs nonempty English strings');
  }
  const parsed = [];
  for (let i = 0; i < texts.length; i += 10) {
    signal?.throwIfAborted();
    progress(`PARSING ${i + 1}–${Math.min(i + 10, texts.length)} of ${texts.length}`);
    const batch = await post(
      '/amr/parse-batch',
      { texts: texts.slice(i, i + 10) },
      signal,
      progress,
    );
    signal?.throwIfAborted();
    if (!Array.isArray(batch) || batch.length !== Math.min(10, texts.length - i)) {
      throw new Error('AMR batch size mismatch');
    }
    parsed.push(...batch.map(parsedItem));
  }
  if (new Set(parsed.map((item) => `${item.model}@${item.revision}`)).size !== 1) {
    throw new Error('AMR model revision changed during acquisition');
  }
  return {
    profile: 'amr-text-acquisition-v1',
    results: parsed,
    versions: { amr: `${parsed[0].model}@${parsed[0].revision}` },
  };
}

/** One AMR and one normalized embedding per exact input, in input order. */
export async function acquire(texts, progress = () => {}, signal) {
  const { results: parsed } = await parseTexts(texts, progress, signal);
  progress(`EMBEDDING ${texts.length} exact sentences and inquiries`);
  const embedded = await embedTexts(texts, signal);
  return {
    parsed,
    views: parsed.map(graphView),
    vectors: embedded.vectors,
    models: { amr: `${parsed[0].model}@${parsed[0].revision}`, embedding: embedded.model },
    embedding: embedded.embedding,
  };
}
