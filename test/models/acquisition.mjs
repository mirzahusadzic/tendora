/** Transport regressions from the real UI run: closed sockets and visible failure stage. */
import assert from 'node:assert/strict';
import { embedTexts, acquire, parseTexts } from '../../src/models/acquisition.mjs';

const fetch = globalThis.fetch;
try {
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert(options.headers.Authorization === `Bearer ${process.env.EGEMMA_API_KEY ?? 'dummy-key'}`);
    assert.equal(options.headers.Connection, 'close');
    if (calls === 1) throw new Error('fetch failed', { cause: { code: 'EPIPE' } });
    return {
      ok: true,
      json: async () => ({
        embeddings: [Array.from({ length: 768 }, (_, i) => (i ? 0 : 1))],
        dimensions: 768,
        model: 'transport-fixture',
        revision: 'v1',
      }),
    };
  };
  assert.equal((await embedTexts(['Exact source.'])).vectors[0][0], 1);
  assert.equal(calls, 2, 'a read-only request retries one closed socket');
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('fetch failed', { cause: { code: 'EPIPE' } });
  };
  await assert.rejects(() => embedTexts(['Exact source.']), /Embeddings: fetch failed: EPIPE/u);
  assert.equal(calls, 2, 'retry is bounded');
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  };
  await assert.rejects(
    () => acquire(['Exact source.']),
    /AMR parsing: fetch failed: ECONNREFUSED/u,
  );
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw controller.signal.reason;
  };
  await assert.rejects(() => embedTexts(['Exact source.'], controller.signal), {
    name: 'AbortError',
  });
  assert.equal(calls, 1, 'cancellation does not retry');

  const success = {
    ok: true,
    json: async () => [
      { penman: '(t / test-01)', decode_status: 'ok', model: 'test', revision: '1' },
    ],
  };
  for (const headers of [new Headers({ 'Retry-After': '0' }), new Headers()]) {
    calls = 0;
    const bodies = [],
      messages = [];
    globalThis.fetch = async (_url, options) => {
      calls++;
      bodies.push(options.body);
      return calls === 1
        ? {
            ok: false,
            status: 429,
            headers,
            json: async () => ({ detail: 'Rate limit exceeded. Try again in 0 seconds.' }),
          }
        : success;
    };
    assert.equal(
      (await parseTexts(['Exact source.'], (message) => messages.push(message))).results.length,
      1,
    );
    assert.equal(calls, 2);
    assert.equal(bodies[0], bodies[1], 'A rate retry preserves exact authored text');
    assert(messages.some((message) => message.includes('rate limit')));
  }
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: false,
      status: 429,
      json: async () => ({ detail: 'Rate limit exceeded. Try again in 0 seconds.' }),
    };
  };
  await assert.rejects(parseTexts(['Exact source.']), /HTTP 429: Rate limit exceeded/u);
  assert.equal(calls, 2, 'HTTP rate retries are bounded');

  const waiting = new AbortController();
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '60' }),
      json: async () => ({}),
    };
  };
  await assert.rejects(
    parseTexts(
      ['Exact source.'],
      (message) => {
        if (message.includes('rate limit')) waiting.abort();
      },
      waiting.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1, 'Cancellation during backoff prevents a second request');

  for (const status of [401, 403]) {
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status, json: async () => ({ detail: 'Unauthorized' }) };
    };
    await assert.rejects(parseTexts(['Exact source.']), /Unauthorized/u);
    assert.equal(calls, 1, 'Authentication failures are never retried');
  }
  // Every returned item carries its own provenance; malformed items fail at the boundary.
  for (const [item, message] of [
    [{ penman: '(t / test-01)', decode_status: 'ok' }, /AMR response lacks a model identity/u],
    [{ penman: '(t / test-01)', model: 'test', revision: '1' }, /lacks a decode status/u],
    [{ decode_status: 'ok', model: 'test', revision: '1' }, /marked ok without PENMAN/u],
    [null, /AMR response lacks a model identity/u],
  ]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => [item] });
    await assert.rejects(parseTexts(['Exact source.']), message);
  }
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [{ penman: null, decode_status: 'failed', model: 'test', revision: '1' }],
  });
  assert.equal((await parseTexts(['Exact source.'])).versions.amr, 'test@1');
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      embeddings: [Array.from({ length: 768 }, (_, i) => (i ? 0 : 1))],
      dimensions: 768,
      model: 'transport-fixture',
    }),
  });
  await assert.rejects(embedTexts(['Exact source.']), /Embedding response lacks a model identity/u);
  console.log(
    'ok model transport retries a closed socket once and identifies the failed stage without losing cancellation',
  );
} finally {
  globalThis.fetch = fetch;
}
