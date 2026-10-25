/** Trimming a capture's rules against its store, in JS: the oracle and the
 * fastest JS version known. See README.md for the definition; the approach is
 * Cuckoo Cycle's edge trimming (John Tromp, github.com/tromp/cuckoo).
 *
 *   node bench/lean-core/trim.mjs <capture-dir> [--oracle] [--out <file>] [--warmup <n>] [--repeat <n>]
 *
 * `--repeat 0` loads and indexes only, for the footprint before any trim.
 *
 * For every rule, each pattern keeps the facts that can still take part in a
 * match of the whole rule by arc consistency: a fact survives when it fits the
 * pattern's constants and repeated variables, and every value it gives a
 * variable is one that every other pattern holding that variable also gives
 * from its own survivors; repeated to the greatest fixpoint. A rule with a
 * pattern left empty keeps nothing (it cannot match). Injectivity is not
 * trimmed: the survivors are a superset of the facts the matcher's matches use.
 *
 * Output (little-endian u32): pattern count P, P + 1 offsets, then each
 * pattern's surviving fact positions in ascending order.
 */
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MISSING,
  buildIndex,
  encodeTrim,
  narrowest,
  trimFast,
  trimReference,
} from '../../src/amr/trim.mjs';

// The algorithms live in the engine (src/amr/trim.mjs); this is their bench CLI.
export { buildIndex, encodeTrim, trimFast, trimReference };

export async function readCapture(dir) {
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  const bytes = await readFile(join(dir, 'columns.bin'));
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const stride = meta.columnBytes / 4;
  const columns = [0, 1, 2].map((c) => words.subarray(c * stride, c * stride + meta.facts));
  const r = new Uint32Array((await readFile(join(dir, 'rules.bin'))).buffer.slice(0));
  const rules = [];
  let at = 1;
  for (let i = 0; i < r[0]; i++) {
    const count = r[at++],
      vars = r[at++];
    const patterns = [];
    for (let p = 0; p < count; p++, at += 3) patterns.push([r[at], r[at + 1], r[at + 2]]);
    rules.push({ patterns, vars });
  }
  return { meta, columns, rules, terms: meta.terms, facts: meta.facts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, arity = 1) => {
    const at = args.indexOf(name);
    return at < 0 ? null : args.splice(at, arity + 1).slice(1);
  };
  const oracle = Boolean(flag('--oracle', 0));
  const outPath = flag('--out')?.[0];
  const repeat = Number(flag('--repeat')?.[0] ?? 1);
  const warmup = Number(flag('--warmup')?.[0] ?? 0);
  const capture = await readCapture(args[0]);
  let t = performance.now();
  const index = buildIndex(capture);
  const indexMs = performance.now() - t;
  const times = [];
  let lists;
  for (let i = 0; i < warmup; i++) (oracle ? trimReference : trimFast)(capture, index);
  for (let i = 0; i < repeat; i++) {
    t = performance.now();
    lists = (oracle ? trimReference : trimFast)(capture, index);
    times.push(performance.now() - t);
  }
  const before = capture.rules.reduce(
    (n, { patterns }) =>
      n +
      patterns.reduce(
        (m, p) => m + (p.includes(MISSING) ? 0 : narrowest(index, p, capture.facts).length),
        0,
      ),
    0,
  );
  const kept = lists?.reduce((n, list) => n + list.length, 0) ?? 0;
  if (outPath && lists) {
    const file = await open(outPath, 'w');
    await file.write(new Uint8Array(encodeTrim(lists).buffer));
    await file.close();
  }
  console.log(
    JSON.stringify({
      version: oracle ? 'js-oracle' : 'js-fast',
      facts: capture.facts,
      rules: capture.rules.length,
      patterns: lists?.length ?? 0,
      candidates: before,
      kept,
      indexMs: +indexMs.toFixed(2),
      trimMs: times.map((x) => +x.toFixed(2)),
    }),
  );
}
