/** Decomposition-factored matching, adapting Chiang et al. (2013), section 3.
 * Query projection is explicit: the host may contain additional hyperedges.
 * Terminals retain actual occurrence IDs; label equality cannot join entities.
 */
import { extractHrg } from './hrg-decomposition.mjs';
import { compileCorpus, grammarFacts, grammarProfile, factKey } from './hrg-corpus.mjs';
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

// Position indexes depend only on the facts; one interpreted cohort serves
// every pattern matched against it.
const indexCache = new WeakMap();
function factIndexes(facts) {
  const cached = indexCache.get(facts);
  if (cached && cached.length === facts.length && cached.last === facts.at(-1)) return cached;
  const indexes = [new Map(), new Map(), new Map()];
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  for (const fact of facts)
    fact.triple.forEach((term, i) => {
      if (!indexes[i].has(term)) indexes[i].set(term, []);
      indexes[i].get(term).push(fact);
    });
  const entry = { indexes, byId, length: facts.length, last: facts.at(-1) };
  indexCache.set(facts, entry);
  return entry;
}

export function matchChart(
  patterns,
  facts,
  {
    limit = 2000,
    budget = 200000,
    account = null,
    plan = compilePattern(patterns),
    injectiveVariables = new Set(
      patterns.flatMap(([from, role, to]) =>
        role.startsWith(':') ? [from, ...(role === ':instance' ? [] : [to])].filter(variable) : [],
      ),
    ),
  } = {},
) {
  const { indexes, byId } = factIndexes(facts);
  // An absent fixed terminal makes the whole pattern impossible. Avoid building
  // unrelated charts in that case, without declaring a bounded search complete.
  if (patterns.some((p) => p.some((term, i) => !variable(term) && !indexes[i].has(term))))
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
  const injective = (values) => {
    const assigned = [...injectiveVariables].filter((v) => v in values).map((v) => values[v]);
    return new Set(assigned).size === assigned.length;
  };
  const combine = (a, b) => {
    for (const [key, value] of Object.entries(b.values))
      if (key in a.values && a.values[key] !== value) return null;
    const values = { ...a.values, ...b.values };
    if (!injective(values)) return null;
    return {
      values,
      evidence: { ...a.evidence, ...b.evidence },
      children: [...a.children, ...b.children],
    };
  };
  const visit = (id) => {
    const rule = plan.rules[id];
    const relations = rule.children.map((child) => {
      const rows = visit(child.id).map((row) => ({ ...row, children: [row.derivation] }));
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
      const choices = terminal.pattern.flatMap((term, i) =>
        variable(term) ? [] : [indexes[i].get(term) ?? []],
      );
      const candidates = choices.length
        ? choices.reduce((a, b) => (a.length < b.length ? a : b))
        : facts;
      relations.push({ terminal, candidates, size: candidates.length, keys: terminal.vertices });
    }
    // The terminal's own values for one fact, consistent with a joined row.
    const read = (pattern, fact, bound) => {
      const values = {};
      for (let i = 0; i < 3; i++) {
        const term = pattern[i],
          actual = fact.triple[i];
        if (!variable(term)) {
          if (term !== actual) return null;
        } else if (term in values) {
          if (values[term] !== actual) return null;
        } else if (term in bound && bound[term] !== actual) return null;
        else values[term] = actual;
      }
      return injective(values) ? values : null;
    };
    const scan = ({ terminal, candidates }) => {
      const rows = [];
      for (const fact of candidates) {
        if (!tick()) break;
        const values = read(terminal.pattern, fact, {});
        if (values) rows.push({ values, evidence: { [terminal.id]: fact.id }, children: [] });
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
    let joined = [{ values: {}, evidence: {}, children: [] }];
    let joinedRelations = 0;
    const known = new Set();
    for (const relation of ordered) {
      const shared = relation.keys.filter((key) => known.has(key));
      const next = [];
      if (relation.terminal && shared.length) {
        // Every index list keeps the facts' order, so looking a terminal up
        // through a joined vertex yields the rows a full scan would, in order.
        const { pattern, id } = relation.terminal;
        const through = pattern.flatMap((term, i) => (shared.includes(term) ? [i] : []));
        for (const a of joined) {
          let list = relation.candidates;
          for (const i of through) {
            const found = indexes[i].get(a.values[pattern[i]]) ?? [];
            if (found.length < list.length) list = found;
          }
          for (const fact of list) {
            if (!tick()) break;
            const values = read(pattern, fact, a.values);
            const merged =
              values && combine(a, { values, evidence: { [id]: fact.id }, children: [] });
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
        continue;
      }
      const rows = relation.terminal ? scan(relation) : relation.rows;
      const keyOf = (values) => JSON.stringify(shared.map((key) => values[key]));
      const lookup = new Map();
      for (const row of rows) {
        const key = keyOf(row.values);
        if (!lookup.has(key)) lookup.set(key, []);
        lookup.get(key).push(row);
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
    for (const row of joined)
      row.derivation = {
        rule: id,
        ports: rule.vertices.slice(0, rule.rank).map((key) => [key, row.values[key]]),
        terminals: rule.terminals.map((t) => ({
          pattern: t.id,
          fact: row.evidence[t.id],
          production: byId.get(row.evidence[t.id])?.grammar,
        })),
        children: row.children,
      };
    charts.set(id, joined.length);
    return joined;
  };
  const matches = visit(plan.start).map((row) => ({
    values: row.values,
    witnesses: patterns.map((_, i) => row.evidence[i]),
    derivation: row.derivation,
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
    const signature = factKey(facts);
    const previous = [...corpora, ...available].find((g) => g.signature === signature);
    const compiled = compileCorpus(facts, previous, signature);
    if (!corpora.includes(compiled.grammar)) corpora.push(compiled.grammar);
    stats[compiled.reused ? 'reused' : 'compilations']++;
    return { ...compiled, id: corpora.indexOf(compiled.grammar) };
  };
  // Inference passes one immutable cohort to every rule of a round. Compile and
  // interpret it once; a changed array (length or last fact) is prepared again.
  const prepared = new WeakMap();
  const prepare = (facts) => {
    const entry = prepared.get(facts);
    if (entry && entry.length === facts.length && entry.last === facts.at(-1)) {
      stats.reused++;
      return entry;
    }
    const compiled = corpus(facts);
    const fresh = {
      compiled,
      emitted: grammarFacts(compiled.grammar, facts),
      length: facts.length,
      last: facts.at(-1),
    };
    prepared.set(facts, fresh);
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
