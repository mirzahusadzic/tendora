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
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VAR = 0x80000000,
  MISSING = 0xffffffff;

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

/** Per column, the facts with each term as one run in fact order (CSR). */
export function buildIndex({ columns, terms, facts }) {
  return columns.map((column) => {
    const offsets = new Uint32Array(terms + 1);
    for (let f = 0; f < facts; f++) offsets[column[f] + 1]++;
    for (let t = 0; t < terms; t++) offsets[t + 1] += offsets[t];
    const order = new Uint32Array(facts),
      fill = offsets.slice(0, terms);
    for (let f = 0; f < facts; f++) order[fill[column[f]]++] = f;
    return { offsets, order };
  });
}
const runOf = (index, i, term) =>
  index[i].order.subarray(index[i].offsets[term], index[i].offsets[term + 1]);

// A fact fits a pattern's constants and repeated variables.
function fits(columns, pattern, f) {
  for (let i = 0; i < 3; i++) {
    const a = pattern[i];
    if (a & VAR) {
      for (let j = i + 1; j < 3; j++)
        if (pattern[j] === a && columns[i][f] !== columns[j][f]) return false;
    } else if (columns[i][f] !== a) return false;
  }
  return true;
}
// The constant run a pattern's candidates start from: its narrowest.
function narrowest(index, pattern, facts) {
  let best = null;
  for (let i = 0; i < 3; i++)
    if (!(pattern[i] & VAR)) {
      const run = runOf(index, i, pattern[i]);
      if (!best || run.length < best.length) best = run;
    }
  return best ?? Uint32Array.from({ length: facts }, (_, f) => f);
}

/** The oracle: every pattern's candidates filtered by domains held as Sets,
 * pattern by pattern, until nothing changes. Written to be read, not fast. */
export function trimReference(capture, index = buildIndex(capture)) {
  const { columns, rules, facts } = capture;
  const out = [];
  for (const { patterns, vars } of rules) {
    if (patterns.some((p) => p.includes(MISSING))) {
      for (const _ of patterns) out.push([]);
      continue;
    }
    let kept = patterns.map((p) =>
      [...narrowest(index, p, facts)].filter((f) => fits(columns, p, f)),
    );
    for (let changed = true; changed;) {
      changed = false;
      const domains = Array.from({ length: vars }, () => null);
      patterns.forEach((p, k) => {
        for (let v = 0; v < vars; v++) {
          const slots = [0, 1, 2].filter((i) => p[i] === (VAR | v) >>> 0);
          if (!slots.length) continue;
          const values = new Set(kept[k].map((f) => columns[slots[0]][f]));
          domains[v] = domains[v] ? new Set([...domains[v]].filter((x) => values.has(x))) : values;
        }
      });
      kept = kept.map((list, k) => {
        const p = patterns[k];
        const next = list.filter((f) =>
          [0, 1, 2].every((i) => !(p[i] & VAR) || domains[p[i] & ~VAR].has(columns[i][f])),
        );
        if (next.length !== list.length) changed = true;
        return next;
      });
    }
    if (kept.some((list) => !list.length)) kept = kept.map(() => []);
    out.push(...kept);
  }
  return out;
}

/** The fastest JS known: per rule, patterns with a selective constant start
 * from their runs; a pattern with only its role fixed is reached through the
 * index of a variable whose domain is already finite (the smallest), so it never
 * scans its role's whole run unless nothing narrower exists. A domain is marked
 * in one array per variable slot, tagged from a running clock, so nothing is
 * cleared between rules. The greatest fixpoint is the oracle's: starting from
 * fewer candidates than it does only skips filtering steps it would take. */
export function trimFast(capture, index = buildIndex(capture)) {
  const { columns, rules, facts, terms } = capture;
  const maxVars = rules.reduce((m, rule) => Math.max(m, rule.vars), 0);
  const marks = Array.from({ length: maxVars }, () => new Uint32Array(terms));
  let clock = 0;
  const out = [];
  for (const { patterns, vars } of rules) {
    if (patterns.some((p) => p.includes(MISSING))) {
      for (const _ of patterns) out.push(new Uint32Array(0));
      continue;
    }
    const P = patterns.length;
    // Each pattern's variables, once each, with the first slot holding them.
    const slotsOf = patterns.map((p) => {
      const slots = [];
      for (let i = 0; i < 3; i++)
        if (p[i] & VAR && !slots.some(([, v]) => v === (p[i] & ~VAR))) slots.push([i, p[i] & ~VAR]);
      return slots;
    });
    const holders = Array.from({ length: vars }, () => []);
    slotsOf.forEach((slots, k) => {
      for (const [i, v] of slots) holders[v].push([k, i]);
    });
    const start = (k) => {
      const run = narrowest(index, patterns[k], facts),
        list = [];
      for (let j = 0; j < run.length; j++)
        if (fits(columns, patterns[k], run[j])) list.push(run[j]);
      return Uint32Array.from(list);
    };
    // Patterns without a variable are settled from their run; the rest wait.
    const kept = patterns.map((p, k) => (slotsOf[k].length ? null : start(k)));
    // A variable's domain: the values every materialized holder gives, marked
    // with its tag; null while no holder is materialized.
    const tag = new Array(vars).fill(0),
      values = new Array(vars).fill(null);
    const rebuild = (v) => {
      const known = holders[v].filter(([k]) => kept[k]);
      if (!known.length) return;
      const mark = marks[v];
      let current = [],
        held = 0;
      known.forEach(([k, i], h) => {
        const next = ++clock,
          column = columns[i],
          L = kept[k],
          found = [];
        for (let j = 0; j < L.length; j++) {
          const t = column[L[j]];
          if (h === 0 ? mark[t] !== next : mark[t] === held) {
            mark[t] = next;
            found.push(t);
          }
        }
        current = found;
        held = next;
      });
      tag[v] = held;
      values[v] = current;
    };
    // After one more holder is materialized, its domain is the old one narrowed
    // by that holder's values: the others' lists have not changed since.
    const narrow = (v, k, i) => {
      const mark = marks[v],
        column = columns[i],
        L = kept[k],
        next = ++clock,
        held = tag[v],
        first = values[v] === null,
        found = [];
      for (let j = 0; j < L.length; j++) {
        const t = column[L[j]];
        if (first ? mark[t] !== next : mark[t] === held) {
          mark[t] = next;
          found.push(t);
        }
      }
      tag[v] = next;
      values[v] = found;
    };
    const member = (v, t) => values[v] === null || marks[v][t] === tag[v];
    // Materialize the waiting patterns cheapest first: through its own
    // narrowest run, or through the index of a variable whose domain is
    // finite, whichever visits fewer facts. A rule stops at an empty pattern.
    let empty = kept.some((list) => list && !list.length);
    for (let left = kept.filter((l) => !l).length; left && !empty; left--) {
      let best = -1,
        slot = -1,
        cost = Infinity;
      for (let k = 0; k < P; k++) {
        if (kept[k]) continue;
        const own = narrowest(index, patterns[k], facts).length;
        if (own < cost) [best, slot, cost] = [k, -1, own];
        for (const [i, v] of slotsOf[k]) {
          if (values[v] === null) continue;
          const offsets = index[i].offsets;
          let visits = 0;
          for (const x of values[v]) if ((visits += offsets[x + 1] - offsets[x]) >= cost) break;
          if (visits < cost) [best, slot, cost] = [k, i, visits];
        }
      }
      const p = patterns[best],
        list = [];
      if (slot < 0) {
        const run = narrowest(index, p, facts);
        for (let j = 0; j < run.length; j++) {
          const f = run[j];
          if (!fits(columns, p, f)) continue;
          let ok = true;
          for (const [i, v] of slotsOf[best])
            if (!member(v, columns[i][f])) {
              ok = false;
              break;
            }
          if (ok) list.push(f);
        }
        kept[best] = Uint32Array.from(list);
      } else {
        for (const x of values[p[slot] & ~VAR]) {
          const run = runOf(index, slot, x);
          for (let j = 0; j < run.length; j++) {
            const f = run[j];
            if (!fits(columns, p, f)) continue;
            let ok = true;
            for (const [i, v] of slotsOf[best])
              if (!member(v, columns[i][f])) {
                ok = false;
                break;
              }
            if (ok) list.push(f);
          }
        }
        kept[best] = Uint32Array.from(list).sort();
      }
      if (!list.length) empty = true;
      else for (const [i, v] of slotsOf[best]) narrow(v, best, i);
    }
    if (empty) {
      for (let k = 0; k < P; k++) out.push(new Uint32Array(0));
      continue;
    }
    // Filter to the greatest fixpoint.
    for (let changed = true; changed;) {
      changed = false;
      for (let v = 0; v < vars; v++) rebuild(v);
      for (let k = 0; k < P; k++) {
        const L = kept[k],
          slots = slotsOf[k],
          next = new Uint32Array(L.length);
        let w = 0;
        for (let j = 0; j < L.length; j++) {
          const f = L[j];
          let ok = true;
          for (const [i, v] of slots)
            if (!member(v, columns[i][f])) {
              ok = false;
              break;
            }
          if (ok) next[w++] = f;
        }
        if (w !== L.length) {
          kept[k] = next.subarray(0, w);
          changed = true;
        }
      }
    }
    if (kept.some((list) => !list.length)) for (let k = 0; k < P; k++) out.push(new Uint32Array(0));
    else out.push(...kept);
  }
  return out;
}

export function encodeTrim(lists) {
  const total = lists.reduce((n, list) => n + list.length, 0);
  const words = new Uint32Array(1 + lists.length + 1 + total);
  words[0] = lists.length;
  let at = 2 + lists.length;
  lists.forEach((list, k) => {
    words[1 + k] = at - (2 + lists.length);
    words.set(list, at);
    at += list.length;
  });
  words[1 + lists.length] = total;
  return words;
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
