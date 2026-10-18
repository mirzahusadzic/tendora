/** Run contract suites sequentially; each owns its temporary data and cleanup. */
import { suites } from './suites.mjs';

const profile = process.argv[2] ?? 'check';
if (!Object.hasOwn(suites, profile)) throw new Error(`Unknown test profile: ${profile}`);
// A profile selects suites; remaining arguments belong to those suites.
if (process.argv.length > 2) process.argv.splice(2, 1);
const fetch = globalThis.fetch;
const unexpected = [];
globalThis.fetch = async (url) => {
  unexpected.push(String(url));
  throw new Error(`Unexpected network request in an offline test: ${url}`);
};
try {
  for (const path of suites[profile]) {
    console.error(`Running ${path}`);
    const timeoutMs = ['acceptance:hand', 'acceptance:tendora'].includes(profile)
      ? 600_000
      : path === 'project/background.mjs'
        ? 180_000
        : 60_000;
    const timeout = setTimeout(() => {
      console.error(`Timed out after ${timeoutMs / 1000} seconds: ${path}`);
      process.exit(1);
    }, timeoutMs);
    try {
      await import(new URL(path, import.meta.url));
      if (unexpected.length)
        throw new Error(`${path} attempted live requests: ${unexpected.join(', ')}`);
    } finally {
      clearTimeout(timeout);
    }
  }
} finally {
  globalThis.fetch = fetch;
}
