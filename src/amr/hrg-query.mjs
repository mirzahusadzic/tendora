/** Decomposition-factored matching, adapting Chiang et al. (2013), section 3.
 * Query projection is explicit: the host may contain additional hyperedges.
 * Terminals retain actual occurrence IDs; label equality cannot join entities.
 */
import { extractHrg } from './hrg-decomposition.mjs';
import { compileCorpus, corpusSignature, grammarEmission, grammarProfile } from './hrg-corpus.mjs';
import { storeOf } from './fact-store.mjs';
const variable = (term) => /^\?[A-Za-z][\w-]*$/u.test(term);
export function compilePattern(patterns) {
  const vertices = [...new Set(patterns.flat().filter(variable))];
  return extractHrg(
    vertices,
    patterns.map((pattern, id) => ({
      id,
      label: JSON.stringify(pattern.map((term) => (variable(term) ? null : term))),
      vertices: [...new Set(pattern.filter(variable))],
      pattern,
    })),
  );
}

// Facts as integer columns: each term is numbered once, a fact is its three
// term numbers, and for each position the facts with one term are one run of
// an index array, in the facts' order. One interpreted cohort serves every
// pattern matched against it.
function factTable({ count, numbers, terms, columns, id, production, positions }) {
  // Terms numbered after the table was made (a store keeps growing while a
  // round reads its cohort) occur in none of its facts.
  const termCount = terms.length;
  const runs = columns.map((column) => {
    const offsets = new Uint32Array(termCount + 1);
    for (let f = 0; f < count; f++) offsets[column[f] + 1]++;
    for (let t = 0; t < termCount; t++) offsets[t + 1] += offsets[t];
    const order = new Uint32Array(count),
      fill = offsets.slice(0, termCount);
    for (let f = 0; f < count; f++) order[fill[column[f]]++] = f;
    return { offsets, order };
  });
  const run = (i, n) =>
    n === undefined || n >= termCount
      ? none
      : runs[i].order.subarray(runs[i].offsets[n], runs[i].offsets[n + 1]);
  let all = null,
    known = null;
  return {
    numbers,
    terms,
    columns,
    run,
    // Every fact, for a terminal without fixed terms.
    all: () => (all ??= Uint32Array.from({ length: count }, (_, f) => f)),
    // A seed names facts by id.
    position: (factId) => (known ??= positions()).get(factId),
    id,
    production,
    length: count,
  };
}
const columnCache = new WeakMap();
function factColumns(facts) {
  const cached = columnCache.get(facts);
  if (cached && cached.length === facts.length && cached.last === facts.at(-1)) return cached.table;
  const numbers = new Map(),
    terms = [];
  const number = (term) => {
    let n = numbers.get(term);
    if (n === undefined) {
      n = terms.length;
      numbers.set(term, n);
      terms.push(term);
    }
    return n;
  };
  const count = facts.length;
  const columns = [new Uint32Array(count), new Uint32Array(count), new Uint32Array(count)];
  for (let f = 0; f < count; f++)
    for (let i = 0; i < 3; i++) columns[i][f] = number(facts[f].triple[i]);
  const table = factTable({
    count,
    numbers,
    terms,
    columns,
    id: (f) => facts[f]?.id,
    production: (f) => facts[f]?.grammar,
    positions: () => new Map(facts.map((fact, f) => [fact.id, f])),
  });
  columnCache.set(facts, { table, length: count, last: facts.at(-1) });
  return table;
}
/** A cohort in its emission order. A store's prefix is read from the store's
 * columns, its terms numbered once for the whole inference; other cohorts are
 * numbered here. Either way no fact is copied. */
function emissionColumns(facts, emission, store) {
  const count = emission.length,
    order = emission.order;
  const columns = [new Uint32Array(count), new Uint32Array(count), new Uint32Array(count)];
  let numbers, terms;
  if (store) {
    ({ numbers, terms } = store);
    const [s, r, o] = [store.s.data, store.r.data, store.o.data];
    for (let e = 0; e < count; e++) {
      columns[0][e] = s[order[e]];
      columns[1][e] = r[order[e]];
      columns[2][e] = o[order[e]];
    }
  } else {
    numbers = new Map();
    terms = [];
    const number = (term) => {
      let n = numbers.get(term);
      if (n === undefined) {
        n = terms.length;
        numbers.set(term, n);
        terms.push(term);
      }
      return n;
    };
    for (let e = 0; e < count; e++)
      for (let i = 0; i < 3; i++) columns[i][e] = number(facts[order[e]].triple[i]);
  }
  return factTable({
    count,
    numbers,
    terms,
    columns,
    id: (e) => (e === undefined ? undefined : facts[order[e]]?.id),
    production: (e) => (e === undefined || e >= count ? undefined : emission.production(e)),
    positions: () => {
      const at = new Map();
      for (let e = 0; e < count; e++) at.set(facts[order[e]].id, e);
      return at;
    },
  });
}
const none = new Uint32Array(0);

export function matchChart(
  patterns,
  facts,
  {
    limit = 2000,
    budget = 200000,
    account = null,
    // A seeded pattern is matched only by the seed's facts.
    seed = null,
    plan = compilePattern(patterns),
    injectiveVariables = new Set(
      patterns.flatMap(([from, role, to]) =>
        role.startsWith(':') ? [from, ...(role === ':instance' ? [] : [to])].filter(variable) : [],
      ),
    ),
  } = {},
) {
  const table = Array.isArray(facts) ? factColumns(facts) : facts;
  const { numbers, terms, columns, run, all, position } = table;
  // An absent fixed terminal makes the whole pattern impossible. Avoid building
  // unrelated charts in that case, without declaring a bounded search complete.
  if (
    patterns.some((p) => p.some((term, i) => !variable(term) && !run(i, numbers.get(term)).length))
  )
    return { matches: [], complete: true, work: 0, plan, chart: {} };
  let work = 0,
    complete = true;
  const tick = () => {
    if (work >= budget || (account && account.work >= account.limit)) {
      complete = false;
      return false;
    }
    work++;
    if (account) account.work++;
    return true;
  };
  const charts = new Map();
  // A row is integer slots: a term number per variable and a fact per
  // pattern (-1 while unbound), and the child rows it was joined from. Values
  // are term numbers until the matches are read out, and a derivation is
  // built only for a row that is part of a match.
  const slots = new Map();
  for (const pattern of patterns)
    for (const term of pattern) if (variable(term) && !slots.has(term)) slots.set(term, slots.size);
  for (const rule of plan.rules)
    for (const vertex of rule.vertices) if (!slots.has(vertex)) slots.set(vertex, slots.size);
  const width = slots.size;
  let evidenceWidth = patterns.length;
  for (const rule of plan.rules)
    for (const terminal of rule.terminals) evidenceWidth = Math.max(evidenceWidth, terminal.id + 1);
  const unbound = (n) => new Array(n).fill(-1);
  const injectiveSlots = [...injectiveVariables].flatMap((v) =>
    slots.has(v) ? [slots.get(v)] : [],
  );
  const injective = (values) => {
    for (let i = 0; i < injectiveSlots.length; i++) {
      const value = values[injectiveSlots[i]];
      if (value < 0) continue;
      for (let j = i + 1; j < injectiveSlots.length; j++)
        if (values[injectiveSlots[j]] === value) return false;
    }
    return true;
  };
  const combine = (a, b) => {
    const values = a.values.slice();
    for (let s = 0; s < width; s++) {
      const value = b.values[s];
      if (value < 0) continue;
      if (values[s] >= 0 && values[s] !== value) return null;
      values[s] = value;
    }
    if (!injective(values)) return null;
    const evidence = a.evidence.slice();
    for (let t = 0; t < evidenceWidth; t++) if (b.evidence[t] >= 0) evidence[t] = b.evidence[t];
    return {
      rule: -1,
      values,
      evidence,
      kids: b.kids.length ? (a.kids.length ? [...a.kids, ...b.kids] : b.kids) : a.kids,
      derivation: null,
    };
  };
  const seededPositions = seed
    ? new Set([...seed.ids].map(position).filter((f) => f !== undefined))
    : null;
  // The variables of a production's rows in the order they were first bound:
  // the same for every row, since every row joins the same relations in the
  // same order. Matches read their values out in this order.
  const bindingOrder = new Map();
  const noKids = [];
  const visit = (id) => {
    const rule = plan.rules[id];
    const relations = rule.children.map((child) => {
      const rows = visit(child.id).map((row) => ({
        rule: -1,
        values: row.values,
        evidence: row.evidence,
        kids: [row],
        derivation: null,
      }));
      return {
        rows,
        size: rows.length,
        keys: plan.rules[child.id].vertices.slice(0, child.ports.length),
        child: child.id,
      };
    });
    // A terminal is not matched against the whole corpus up front. Its fixed
    // terms bound its candidates; once a vertex of it is joined, it is looked
    // up through that vertex instead, so a selective relation trims the rest.
    for (const terminal of rule.terminals) {
      const codes = terminal.pattern.map((term) => (variable(term) ? -1 : numbers.get(term)));
      const choices = codes.flatMap((code, i) => (code === -1 ? [] : [run(i, code)]));
      const narrowest = choices.length
        ? choices.reduce((a, b) => (a.length < b.length ? a : b))
        : all();
      const seeded = seed?.pattern === terminal.id ? seededPositions : null;
      const candidates = seeded ? narrowest.filter((f) => seeded.has(f)) : narrowest;
      relations.push({
        terminal,
        codes,
        at: terminal.pattern.map((term) => (variable(term) ? slots.get(term) : -1)),
        candidates,
        seeded,
        size: candidates.length,
        keys: terminal.vertices,
      });
    }
    // The terminal's own values for one fact, written over a joined row's
    // (or blank) values; null when inconsistent with them or not injective.
    const read = (codes, at, f, base) => {
      const values = base.slice();
      const own = [];
      for (let i = 0; i < 3; i++) {
        const actual = columns[i][f];
        if (codes[i] !== -1) {
          if (codes[i] !== actual) return null;
          continue;
        }
        const slot = at[i];
        if (own.includes(slot)) {
          if (values[slot] !== actual) return null;
        } else if (values[slot] >= 0 && values[slot] !== actual) return null;
        else {
          values[slot] = actual;
          own.push(slot);
        }
      }
      // The terminal's own bindings are injective before the joined ones.
      for (let i = 0; i < own.length; i++)
        for (let j = i + 1; j < own.length; j++)
          if (
            values[own[i]] === values[own[j]] &&
            injectiveSlots.includes(own[i]) &&
            injectiveSlots.includes(own[j])
          )
            return null;
      return values;
    };
    const blank = unbound(width),
      noEvidence = unbound(evidenceWidth);
    const scan = ({ terminal, codes, at, candidates }) => {
      const rows = [];
      for (const f of candidates) {
        if (!tick()) break;
        const values = read(codes, at, f, blank);
        if (values) {
          const evidence = noEvidence.slice();
          evidence[terminal.id] = f;
          rows.push({ rule: -1, values, evidence, kids: noKids, derivation: null });
        }
      }
      return rows;
    };
    // Smallest first, but connected first: a relation sharing no vertex with
    // what is already joined multiplies the rows, a cross product that only a
    // later relation could prune and that a bound can cut off first. The
    // order changes the work, not the complete set of matches.
    const pending = relations.sort((a, b) => a.size - b.size);
    const ordered = [],
      reached = new Set();
    while (pending.length) {
      const at = pending.findIndex((relation) => relation.keys.some((key) => reached.has(key)));
      const [relation] = pending.splice(Math.max(0, at), 1);
      ordered.push(relation);
      for (const key of relation.keys) reached.add(key);
    }
    const order = [];
    for (const relation of ordered)
      for (const name of relation.terminal
        ? relation.terminal.pattern.filter(variable)
        : bindingOrder.get(relation.child))
        if (!order.includes(name)) order.push(name);
    bindingOrder.set(id, order);
    let joined = [
      { rule: -1, values: blank, evidence: noEvidence, kids: noKids, derivation: null },
    ];
    let joinedRelations = 0;
    const known = new Set();
    for (const relation of ordered) {
      const shared = relation.keys.filter((key) => known.has(key));
      const next = [];
      if (relation.terminal && shared.length) {
        // Every run keeps the facts' order, so looking a terminal up through a
        // joined vertex yields the rows a full scan would, in order.
        const { pattern, id: terminalId } = relation.terminal;
        const through = pattern.flatMap((term, i) => (shared.includes(term) ? [i] : []));
        for (const a of joined) {
          let list = relation.candidates;
          for (const i of through) {
            const found = run(i, a.values[relation.at[i]]);
            if (found.length < list.length) list = found;
          }
          for (const f of list) {
            if (relation.seeded && !relation.seeded.has(f)) continue;
            if (!tick()) break;
            const values = read(relation.codes, relation.at, f, a.values);
            if (values && injective(values)) {
              if (next.length >= limit) {
                complete = false;
                break;
              }
              const evidence = a.evidence.slice();
              evidence[terminalId] = f;
              next.push({ rule: -1, values, evidence, kids: a.kids, derivation: null });
            }
          }
          if (!complete) break;
        }
        joined = next;
        joinedRelations++;
        for (const key of relation.keys) known.add(key);
        if (!complete || !joined.length) break;
        continue;
      }
      const rows = relation.terminal ? scan(relation) : relation.rows;
      const sharedSlots = shared.map((key) => slots.get(key));
      const keyOf =
        sharedSlots.length === 1
          ? (values) => values[sharedSlots[0]]
          : (values) => sharedSlots.map((slot) => values[slot]).join(',');
      const lookup = new Map();
      for (const row of rows) {
        const key = keyOf(row.values);
        let list = lookup.get(key);
        if (!list) lookup.set(key, (list = []));
        list.push(row);
      }
      for (const a of joined) {
        for (const b of lookup.get(keyOf(a.values)) ?? []) {
          if (!tick()) break;
          const merged = combine(a, b);
          if (merged) {
            if (next.length >= limit) {
              complete = false;
              break;
            }
            next.push(merged);
          }
        }
        if (!complete) break;
      }
      joined = next;
      joinedRelations++;
      for (const key of relation.keys) known.add(key);
      if (!complete || !joined.length) break;
    }
    // A bounded join may have complete rows for its last relation, but rows
    // from an unfinished production do not witness the rest of the query.
    if (joinedRelations !== ordered.length) joined = [];
    for (const row of joined) row.rule = id;
    charts.set(id, joined.length);
    return joined;
  };
  const fact = (e) => (e < 0 ? undefined : e);
  const derivation = (row) => {
    if (row.derivation) return row.derivation;
    const rule = plan.rules[row.rule];
    row.derivation = {
      rule: row.rule,
      ports: rule.vertices
        .slice(0, rule.rank)
        .map((key) => [key, terms[row.values[slots.get(key)]]]),
      terminals: rule.terminals.map((t) => ({
        pattern: t.id,
        fact: table.id(fact(row.evidence[t.id])),
        production: table.production(fact(row.evidence[t.id])),
      })),
      children: row.kids.map(derivation),
    };
    return row.derivation;
  };
  const rows = visit(plan.start),
    names = bindingOrder.get(plan.start);
  const matches = rows.map((row) => ({
    values: Object.fromEntries(names.map((name) => [name, terms[row.values[slots.get(name)]]])),
    witnesses: patterns.map((_, i) => table.id(fact(row.evidence[i]))),
    derivation: derivation(row),
  }));
  return { matches, complete, work, plan, chart: Object.fromEntries(charts) };
}

/** One inquiry owns its corpus versions and query plans, including rule bodies.
 * The retained cache contains only automatically generated grammar artifacts.
 */
export function createGrammarMatcher(retained = {}) {
  const available = retained.profile === grammarProfile ? (retained.grammars ?? []) : [];
  const corpora = [],
    plans = [],
    planKeys = new Map();
  const stats = { compilations: 0, reused: 0, searches: 0, work: 0 };
  const corpus = (facts) => {
    const signature = corpusSignature(facts);
    const previous = [...corpora, ...available].find((g) => g.signature === signature);
    const compiled = compileCorpus(facts, previous, signature);
    if (!corpora.includes(compiled.grammar)) corpora.push(compiled.grammar);
    stats[compiled.reused ? 'reused' : 'compilations']++;
    return { ...compiled, id: corpora.indexOf(compiled.grammar) };
  };
  // Inference passes one immutable cohort to every rule of a round. Compile and
  // interpret it once; a changed array (length or last fact) is prepared again.
  // A store's prefix is kept by its length: inference's last cohort and its
  // result are two arrays of the same facts.
  const prepared = new WeakMap(),
    preparedPrefixes = new WeakMap();
  const prepare = (facts) => {
    const store = storeOf(facts);
    const entry = store ? preparedPrefixes.get(store)?.get(facts.length) : prepared.get(facts);
    if (entry && entry.length === facts.length && entry.last === facts.at(-1)) {
      stats.reused++;
      return entry;
    }
    const compiled = corpus(facts);
    const positionOf = store
      ? (id) => {
          const f = store.position(id);
          return f < facts.length ? f : undefined;
        }
      : null;
    const emission = grammarEmission(compiled.grammar, facts, positionOf);
    const fresh = {
      compiled,
      emitted: emissionColumns(facts, emission, store),
      length: facts.length,
      last: facts.at(-1),
    };
    if (store) {
      if (!preparedPrefixes.has(store)) preparedPrefixes.set(store, new Map());
      preparedPrefixes.get(store).set(facts.length, fresh);
    } else prepared.set(facts, fresh);
    return fresh;
  };
  const match = (patterns, facts, options) => {
    const { compiled, emitted } = prepare(facts),
      key = JSON.stringify(patterns);
    if (!planKeys.has(key)) {
      planKeys.set(key, plans.length);
      plans.push(compilePattern(patterns));
    }
    const planId = planKeys.get(key),
      plan = plans[planId];
    const result = matchChart(patterns, emitted, {
      ...options,
      plan,
    });
    stats.searches++;
    stats.work += result.work;
    for (const row of result.matches)
      row.derivation = { corpus: compiled.id, plan: planId, tree: row.derivation };
    return result;
  };
  return {
    match,
    corpus,
    corpora,
    plans,
    stats,
    cache: () => ({ profile: grammarProfile, grammars: corpora }),
  };
}
