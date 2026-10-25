/** The trim: for each rule, the facts that can still take part in a match of
 * its whole body, by arc consistency. A fact survives when it fits its
 * pattern's constants and repeated variables, and every value it gives a
 * variable is one every other pattern holding that variable gives from its own
 * survivors; repeated to the greatest fixpoint. A rule with a pattern left
 * empty keeps nothing. Exact for positive bodies: every witness of every match
 * survives, so matching over the survivors gives the same matches.
 *
 * The approach is Cuckoo Cycle's edge trimming (John Tromp,
 * github.com/tromp/cuckoo); bench/lean-core measures it in JavaScript, Swift
 * and Metal. A capture is `{ columns: [s, r, o], rules: [{ patterns, vars }],
 * facts, terms }`: u32 columns, and patterns of three words each, a term
 * number, VAR | variable, or MISSING for a constant the store does not hold.
 */
export const VAR = 0x80000000,
  MISSING = 0xffffffff;

/** A capture that holds together, or a refusal with why (CAPTURE_INVALID):
 * whole counts, three columns of at least `facts` terms each below `terms`,
 * and rules whose every word is a variable the rule has, a term, or MISSING.
 * Every backend refuses the same capture, so none pads, ignores or reads past
 * what another refuses (review of the Metal trim, 2026-10-25, #4). */
export const captureBound = 2 ** 28;
export function checkCapture(capture) {
  const refuse = (why) => {
    throw Object.assign(new Error(`Invalid trim capture: ${why}.`), { code: 'CAPTURE_INVALID' });
  };
  const { columns, rules, facts, terms } = capture ?? {};
  // Counts the trim takes: a term number below VAR (a word with its top bit
  // is a variable), and no more than a store of 2^28 facts or terms.
  const count = (n) => Number.isSafeInteger(n) && n >= 0 && n <= captureBound;
  if (!count(facts) || !count(terms))
    refuse(`facts and terms are whole counts up to ${captureBound}`);
  if (!Array.isArray(columns) || columns.length !== 3) refuse('it has three columns');
  columns.forEach((column, c) => {
    if (!(column?.length >= facts)) refuse(`column ${c} holds fewer than ${facts} facts`);
    const typed = column instanceof Uint32Array;
    for (let f = 0; f < facts; f++) {
      const term = column[f];
      if (term >= terms || (!typed && !(Number.isInteger(term) && term >= 0)))
        refuse(`column ${c}: fact ${f} holds ${term}, no term of ${terms}`);
    }
  });
  if (!Array.isArray(rules)) refuse('it has rules');
  rules.forEach((rule, r) => {
    if (!count(rule?.vars) || !Array.isArray(rule.patterns))
      refuse(`rule ${r} has vars and patterns`);
    for (const pattern of rule.patterns) {
      if (pattern?.length !== 3) refuse(`rule ${r}: a pattern is three words`);
      for (const word of pattern) {
        if (word === MISSING) continue;
        const whole = Number.isInteger(word) && word >= 0 && word < MISSING;
        if (!whole || (word & VAR ? (word & ~VAR) >= rule.vars : word >= terms))
          refuse(`rule ${r} names ${word}, no variable it has nor a term`);
      }
    }
  });
  return capture;
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
export function narrowest(index, pattern, facts) {
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
export function trimReference(capture, index = buildIndex(checkCapture(capture))) {
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
export function trimFast(capture, index = buildIndex(checkCapture(capture))) {
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

const variable = (term) => /^\?[A-Za-z][\w-]*$/u.test(term);

// The backend inference trims with, in this process: JavaScript unless an
// entry point applies another (src/models/trim-backends.mjs).
let current = trimFast;
export const useTrim = (trim) => {
  current = trim ?? trimFast;
};
export const currentTrim = () => current;

/** A capture of a fact store's first `length` facts and some rule bodies. */
export function storeCapture(store, bodies, length = store.length) {
  const rules = bodies.map((when) => {
    const vars = new Map();
    for (const pattern of when)
      for (const term of pattern) if (variable(term) && !vars.has(term)) vars.set(term, vars.size);
    return {
      vars: vars.size,
      patterns: when.map((pattern) =>
        pattern.map((term) =>
          variable(term) ? (VAR | vars.get(term)) >>> 0 : (store.numbers.get(term) ?? MISSING),
        ),
      ),
    };
  });
  return {
    columns: [store.s.data, store.r.data, store.o.data].map((data) => data.subarray(0, length)),
    rules,
    facts: length,
    terms: store.terms.length,
  };
}

const invalid = (why) =>
  Object.assign(new Error(`Malformed trim output: ${why}.`), { code: 'TRIM_OUTPUT_INVALID' });

/** Lists that answer a capture: one per pattern, each strictly ascending
 * within its facts. A trim that does not fit is refused, so a backend's fault
 * can never pass for facts no rule could use. */
export function checkTrim(lists, capture) {
  const patterns = capture.rules.reduce((n, rule) => n + rule.patterns.length, 0);
  if (lists.length !== patterns) throw invalid(`${lists.length} lists for ${patterns} patterns`);
  for (const list of lists)
    for (let j = 0; j < list.length; j++)
      if (list[j] >= capture.facts || (j && list[j] <= list[j - 1]))
        throw invalid(`position ${list[j]} out of order or past ${capture.facts} facts`);
  return lists;
}

/** The positions any of the bodies can still use, marked; `trim` is the
 * backend (lists per pattern, in rule order). */
export function usablePositions(store, bodies, { length = store.length, trim = trimFast } = {}) {
  const usable = new Uint8Array(length);
  const capture = storeCapture(store, bodies, length);
  for (const list of checkTrim(trim(capture), capture))
    for (let j = 0; j < list.length; j++) usable[list[j]] = 1;
  return usable;
}

/** Lists as little-endian u32: pattern count P, P + 1 offsets, then each
 * pattern's positions in ascending order (what every backend writes). */
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

/** The lists a backend wrote, their layout checked, and against `capture`
 * when given (checkTrim). */
export function decodeTrim(bytes, capture) {
  if (bytes.byteLength % 4 || bytes.byteLength < 8) throw invalid(`${bytes.byteLength} bytes`);
  const aligned = bytes.byteOffset % 4 ? new Uint8Array(bytes) : bytes;
  const words = new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
  const count = words[0],
    from = 2 + count;
  if (from > words.length) throw invalid(`${count} lists in ${words.length} words`);
  if (words[1] !== 0 || words[1 + count] !== words.length - from)
    throw invalid(`offsets ${words[1]}…${words[1 + count]} for ${words.length - from} positions`);
  for (let k = 1; k <= count; k++)
    if (words[1 + k] < words[k]) throw invalid(`offsets out of order at list ${k}`);
  const lists = Array.from({ length: count }, (_, k) =>
    words.subarray(from + words[1 + k], from + words[2 + k]),
  );
  return capture ? checkTrim(lists, capture) : lists;
}
