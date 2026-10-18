/** Substitute only the text parser HTTP boundary with unedited live captures. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
export const captures = JSON.parse(
  await readFile(new URL('./qa-development-acquisitions.json', import.meta.url)),
).entries;
export function frozenParser(requests = []) {
  return async (url, options) => {
    assert(url.endsWith('/amr/parse-batch'), 'Reasoning must not call a model');
    const { texts } = JSON.parse(options.body);
    const results = texts.map((text) => {
      const item = captures.find((e) => e.text === text);
      assert(item, `No actual retained acquisition for: ${text}`);
      return structuredClone(item.acquisition);
    });
    requests.push(...texts);
    return { ok: true, json: async () => results };
  };
}
