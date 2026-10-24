/** Bounded forward chaining over authored triples. No domain predicates or aliases. */
import { hash53 } from './hash.mjs';
import { FactStore, NONE, storeOf, storePrefix } from './fact-store.mjs';
const variable = (term) => /^\?[A-Za-z][\w-]*$/u.test(term);
const fresh = (term) => /^\$[A-Za-z][\w-]*$/u.test(term);
const key = (triple) => JSON.stringify(triple);

/** Canonical triples retain each occurrence's independent support and guards. */
export function collectRelationFacts(inputs, maxDerivations = Infinity) {
  const facts = new Map();
  let complete = true;
  const evidence = ({ sourceIds = [], bindingIds, guards, fragmentIds }) => ({
    sourceIds,
    ...(fragmentIds ? { fragmentIds } : {}),
    ...(bindingIds ? { bindingIds } : {}),
    ...(guards ? { guards } : {}),
  });
  for (const input of inputs) {
    const id = input.id ?? key(input.triple);
    if (!facts.has(id))
      facts.set(id, {
        ...input,
        id,
        ...(input.alternatives ? { alternatives: [...input.alternatives] } : {}),
      });
    else {
      const existing = facts.get(id),
        proof = evidence(input),
        signature = JSON.stringify(proof);
      if (
        [existing, ...(existing.alternatives ?? [])].some(
          (item) => JSON.stringify(evidence(item)) === signature,
        )
      )
        continue;
      if ((existing.alternatives?.length ?? 0) >= maxDerivations) {
        complete = false;
        continue;
      }
      (existing.alternatives ??= []).push(proof);
    }
  }
  return { facts, complete };
}

export const guardedEvidence = (fact, witnesses) =>
  [fact, ...(fact.alternatives ?? [])].filter((proof) =>
    (proof.guards ?? []).every((guard) => witnesses.has(guard)),
  );
export function validateRule(rule) {
  if (
    !rule ||
    typeof rule.name !== 'string' ||
    !rule.name.trim() ||
    !Array.isArray(rule.when) ||
    !rule.when.length ||
    !Array.isArray(rule.then) ||
    !rule.then.length
  )
    throw new Error('Rule needs a name, premises and conclusions');
  for (const triple of [...rule.when, ...rule.then, ...(rule.guards ?? [])]) {
    if (
      !Array.isArray(triple) ||
      triple.length !== 3 ||
      triple.some((term) => typeof term !== 'string' || !term.trim())
    )
      throw new Error('Relations require three nonempty terms');
    if (triple[1].startsWith('$')) throw new Error('A relation cannot be a generated node');
  }
  if (rule.when.flat().some(fresh)) throw new Error('Generated nodes belong in conclusions');
  const bound = new Set(rule.when.flat().filter(variable));
  if (
    [...rule.then, ...(rule.guards ?? [])]
      .flat()
      .filter(variable)
      .some((term) => !bound.has(term))
  )
    throw new Error('Conclusion variable has no premise');
  return rule;
}

/** Return consistent joins, retaining the facts that witness every premise. */
export function matchRelations(
  patterns,
  facts,
  { limit = 2000, budget = 200000, account = null, seed = null } = {},
) {
  // A seeded pattern is matched only by the seed's facts.
  const seeded = seed && patterns[seed.pattern];
  const indexes = [new Map(), new Map(), new Map()];
  for (const fact of facts) {
    fact.triple.forEach((term, index) => {
      if (!indexes[index].has(term)) indexes[index].set(term, []);
      indexes[index].get(term).push(fact);
    });
  }
  let work = 0,
    complete = true;
  const result = [];
  const candidates = (pattern, values) => {
    const bound = pattern.map((term) => (variable(term) ? values[term] : term));
    const buckets = bound.flatMap((term, index) =>
      term === undefined ? [] : [indexes[index].get(term) ?? []],
    );
    const choices = buckets.length
      ? buckets.reduce((smallest, items) => (items.length < smallest.length ? items : smallest))
      : facts;
    return pattern === seeded ? choices.filter((fact) => seed.ids.has(fact.id)) : choices;
  };
  function walk(remaining, values, witnesses) {
    if (!complete) return;
    if (!remaining.length) {
      if (result.length >= limit) {
        complete = false;
        return;
      }
      result.push({ values, witnesses });
      return;
    }
    const ordered = remaining
      .map((pattern, index) => ({ pattern, index, choices: candidates(pattern, values) }))
      .sort((a, b) => a.choices.length - b.choices.length);
    const { pattern, index, choices } = ordered[0];
    for (const fact of choices) {
      if (work >= budget || (account && account.work >= account.limit)) {
        complete = false;
        return;
      }
      work++;
      if (account) account.work++;
      const next = { ...values };
      let matches = true;
      for (let i = 0; i < 3; i++) {
        const term = pattern[i],
          actual = fact.triple[i];
        if (!variable(term)) {
          if (term !== actual) {
            matches = false;
            break;
          }
        } else if (next[term] !== undefined && next[term] !== actual) {
          matches = false;
          break;
        } else next[term] = actual;
      }
      if (matches)
        walk(
          remaining.filter((_, at) => at !== index),
          next,
          [...witnesses, fact.id],
        );
      if (!complete) return;
    }
  }
  walk(patterns, {}, []);
  return { matches: result, complete, work };
}

export function inferRelations(
  inputs,
  rules,
  {
    maxRounds = 24,
    maxFacts = 12000,
    matchLimit = 2000,
    matchBudget = 200000,
    account = null,
    maxDerivations = 64,
    matcher = matchRelations,
  } = {},
) {
  rules.forEach(validateRule);
  const { facts, complete: inputComplete } = collectRelationFacts(inputs, maxDerivations);
  // Keep the original facts for callers that explicitly restrict their premises.
  const inputCohort = [...facts.values()];
  // The same facts as integer columns, written as they are derived; the
  // objects stay as a view for the shell (lean base, M1).
  const store = FactStore.from(inputCohort);
  storePrefix(inputCohort, store);
  const viewRules = new Set(rules.filter((r) => r.baseOnly).map((r) => r.id));
  let complete = inputComplete && facts.size <= maxFacts,
    rounds = 0;
  const fired = new Set();
  const reaches = (from, target, seen = new Set()) =>
    from === target ||
    (!seen.has(from) &&
      (seen.add(from),
      [facts.get(from), ...(facts.get(from)?.alternatives ?? [])].some((proof) =>
        proof?.premises?.some((id) => reaches(id, target, seen)),
      )));
  // Semi-naive rounds: after the first, a rule is matched only with a fact
  // that is new, or newly proved, since the last round at one of its patterns;
  // a match made only of older facts was found, and fired or refused, before.
  // A new proof counts: it can satisfy a witness's guards that refused one.
  let changed = null;
  const fits = (pattern, triple) =>
    pattern.every((term, i) => variable(term) || term === triple[i]);
  // The patterns of a rule that a changed fact fits: each seeds a match that
  // must use one of those facts there. Every new match has such a witness:
  // one made only of older facts was found, and fired or refused, before.
  const seeds = (rule) =>
    !changed
      ? [null]
      : rule.when.flatMap((pattern, i) =>
          (variable(pattern[1]) ? changed.all : (changed.byRole.get(pattern[1]) ?? [])).some(
            (fact) => fits(pattern, fact.triple),
          )
            ? [{ pattern: i, ids: changed.ids }]
            : [],
        );
  let evaluations = 0;
  // Names are interned per run: a hash shared by two applications never
  // merges them; the later one is told apart.
  const named = new Map();
  const applicationName = (application) => {
    let name = `${hash53(application, 0).toString(36)}${hash53(application, 1).toString(36)}`;
    while (named.has(name) && named.get(name) !== application) name += '~';
    named.set(name, application);
    return name;
  };
  for (; complete && rounds < maxRounds; rounds++) {
    let added = false;
    const touched = new Set();
    // A round reads one immutable relation cohort. This lets all rule bodies
    // share the same compiled grammar; new consequences enter the next round.
    const cohort = storePrefix([...facts.values()], store);
    // A correspondence may read ordinary conditional consequences, but cannot
    // use another correspondence as its semantic premise. This permits views
    // of composed answers without cyclic fresh-node expansion between views.
    const base = new Map();
    const unextended = (id, seen = new Set()) => {
      if (base.has(id)) return base.get(id);
      if (seen.has(id)) return false;
      const next = new Set([...seen, id]),
        fact = facts.get(id);
      const supported = [fact, ...(fact?.alternatives ?? [])].some(
        (proof) =>
          proof &&
          !viewRules.has(proof.ruleId) &&
          (proof.premises ?? []).every((p) => unextended(p, next)),
      );
      base.set(id, supported);
      return supported;
    };
    const baseCohort = viewRules.size ? cohort.filter((f) => unextended(f.id)) : cohort;
    for (const rule of rules) {
      const ruleSeeds = seeds(rule);
      if (!ruleSeeds.length) continue;
      const input = rule.baseOnly ? baseCohort : rule.inputOnly ? inputCohort : cohort;
      const scoped = rule.inputSourceIds
        ? input.filter(
            (f) =>
              f.sourceIds?.length && f.sourceIds.every((id) => rule.inputSourceIds.includes(id)),
          )
        : input;
      const matches = [];
      for (const seed of ruleSeeds) {
        evaluations++;
        const matching = matcher(rule.when, scoped, {
          limit: matchLimit,
          budget: matchBudget,
          account,
          ...(seed ? { seed } : {}),
        });
        if (!matching.complete) {
          complete = false;
          break;
        }
        matches.push(...matching.matches);
      }
      if (!complete) break;
      for (const { values, witnesses, derivation } of matches) {
        const witnessed = new Set(witnesses);
        if (witnesses.some((id) => !guardedEvidence(facts.get(id), witnessed).length)) continue;
        // A confirmed interpretation belongs to the selected source assertion.
        // Its participants may come from the premises of a grounded condition;
        // requiring every terminal to be owned by the policy would break that
        // composition. Gate the assertion witness instead of merging occurrences.
        if (rule.assertionSourceIds) {
          const assertions = witnesses
            .map((id) => facts.get(id))
            .filter((fact) => fact.triple[1] === '@asserted');
          if (
            !assertions.length ||
            assertions.some(
              (fact) =>
                !guardedEvidence(fact, witnessed).some((proof) =>
                  proof.sourceIds?.some((id) => rule.assertionSourceIds.includes(id)),
                ),
            )
          )
            continue;
        }
        const application = JSON.stringify([
          rule.id,
          Object.entries(values).sort(([a], [b]) => a.localeCompare(b)),
        ]);
        if (fired.has(application)) continue;
        fired.add(application);
        // A derived node is named by its application: the rule and its bindings,
        // not the order of firing, so any evaluation order names it the same.
        // Hashed, so recursive premises do not expand their whole history into
        // every generated identity.
        const identity = applicationName(application);
        const resolve = (term) =>
          variable(term) ? values[term] : fresh(term) ? `derived:${identity}:${term}` : term;
        for (const pattern of rule.then) {
          const triple = pattern.map(resolve),
            id = key(triple);
          const proof = {
            ruleId: rule.id,
            premises: witnesses,
            ...(derivation ? { derivation } : {}),
            sourceIds: rule.sourceIds ?? [],
            ...(rule.fragmentIds ? { fragmentIds: rule.fragmentIds } : {}),
            ...(rule.guards?.length
              ? { guards: rule.guards.map((guard) => key(guard.map(resolve))) }
              : {}),
          };
          if (facts.has(id)) {
            const existing = facts.get(id);
            // A tautological re-derivation cannot become its own support.
            if (witnesses.some((witness) => reaches(witness, id))) continue;
            if (
              (existing.ruleId === proof.ruleId &&
                key(existing.premises) === key(proof.premises)) ||
              existing.alternatives?.some(
                (item) =>
                  item.ruleId === proof.ruleId && key(item.premises) === key(proof.premises),
              )
            )
              continue;
            if ((existing.alternatives?.length ?? 0) >= maxDerivations) {
              complete = false;
              break;
            }
            (existing.alternatives ??= []).push(proof);
            store.addAlternative(store.position(id), proof);
            touched.add(id);
            added = true;
            continue;
          }
          if (facts.size >= maxFacts) {
            complete = false;
            break;
          }
          const fact = { id, triple, ...proof };
          facts.set(id, fact);
          store.add(fact);
          touched.add(id);
          added = true;
        }
        if (!complete) break;
      }
      if (!complete) break;
    }
    if (!added)
      return {
        facts: storePrefix([...facts.values()], store),
        store,
        complete,
        rounds: rounds + 1,
        evaluations,
      };
    const all = [...touched].map((id) => facts.get(id)),
      byRole = new Map();
    for (const fact of all) {
      if (!byRole.has(fact.triple[1])) byRole.set(fact.triple[1], []);
      byRole.get(fact.triple[1]).push(fact);
    }
    changed = { all, byRole, ids: touched };
  }
  return {
    facts: storePrefix([...facts.values()], store),
    store,
    complete: false,
    rounds,
    evaluations,
  };
}

// Tracing runs once per match against one fact array: index it once, not per
// trace, or answering costs matches × facts. A grown array is indexed again.
const traceIndexes = new WeakMap();
function factsById(facts) {
  const cached = traceIndexes.get(facts);
  if (cached && cached.length === facts.length && cached.last === facts.at(-1)) return cached.byId;
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  traceIndexes.set(facts, { byId, length: facts.length, last: facts.at(-1) });
  return byId;
}

/** A fact array's proofs as integer arrays, built once: each fact's proofs
 * (the fact's own, then its alternatives) as one run, each proof's sources
 * and premises (fact positions) as runs of two pools, and the proofs each fact
 * is a premise of. A premise not in the array leaves its proof unusable. A
 * store's prefix is read from the store's columns; sources are numbered as
 * the store numbers its terms. */
const proofGraphs = new WeakMap();
// Offsets for runs counted per item: run i is [start[i], start[i + 1]).
const offsetsOf = (counts) => {
  const start = new Uint32Array(counts.length + 1);
  for (let i = 0; i < counts.length; i++) start[i + 1] = start[i] + counts[i];
  return start;
};
export function proofGraph(facts) {
  const cached = proofGraphs.get(facts);
  if (cached && cached.length === facts.length && cached.last === facts.at(-1)) return cached;
  const store = storeOf(facts);
  const graph = store ? storeProofGraph(store, facts) : objectProofGraph(facts);
  // The proofs each fact is a premise of.
  const uses = new Uint32Array(facts.length);
  for (let i = 0; i < graph.premises.length; i++) uses[graph.premises[i]]++;
  const premiseOfStart = offsetsOf(uses),
    premiseOf = new Uint32Array(graph.premises.length),
    fill = premiseOfStart.slice(0, facts.length);
  for (let p = 0; p < graph.proofFact.length; p++)
    for (let i = graph.premiseStart[p]; i < graph.premiseStart[p + 1]; i++)
      premiseOf[fill[graph.premises[i]]++] = p;
  Object.assign(graph, {
    facts,
    premiseOfStart,
    premiseOf,
    length: facts.length,
    last: facts.at(-1),
  });
  proofGraphs.set(facts, graph);
  return graph;
}
function objectProofGraph(facts) {
  const position = new Map(facts.map((fact, f) => [fact.id, f]));
  const sources = new Map(),
    sourceIds = [];
  const source = (id) => {
    let n = sources.get(id);
    if (n === undefined) {
      n = sourceIds.length;
      sources.set(id, n);
      sourceIds.push(id);
    }
    return n;
  };
  const proofCounts = new Uint32Array(facts.length),
    proofFact = [],
    sourceCounts = [],
    sourcePool = [],
    premiseCounts = [],
    premisePool = [],
    broken = [];
  for (let f = 0; f < facts.length; f++) {
    const proofs = [facts[f], ...(facts[f].alternatives ?? [])];
    proofCounts[f] = proofs.length;
    for (const proof of proofs) {
      const premises = (proof.premises ?? []).map((id) => position.get(id));
      const used = [...new Set(proof.sourceIds ?? [])].map(source);
      proofFact.push(f);
      sourceCounts.push(used.length);
      sourcePool.push(...used);
      const found = premises.filter((q) => q !== undefined);
      premiseCounts.push(found.length);
      premisePool.push(...found);
      broken.push(found.length !== premises.length ? 1 : 0);
    }
  }
  return {
    position,
    sourceIds,
    sources,
    factProofs: offsetsOf(proofCounts),
    proofFact: Uint32Array.from(proofFact),
    sourceStart: offsetsOf(sourceCounts),
    sourcePool: Uint32Array.from(sourcePool),
    premiseStart: offsetsOf(premiseCounts),
    premises: Uint32Array.from(premisePool),
    broken: Uint8Array.from(broken),
  };
}
function storeProofGraph(store, facts) {
  const length = facts.length;
  // A fact's proofs are a linked run of rows in the store; here they become
  // one run per fact, in the same order (its own, then its alternatives).
  const proofCounts = new Uint32Array(length);
  let total = 0;
  for (let f = 0; f < length; f++)
    for (let p = store.firstProof.data[f]; p !== NONE; p = store.proofNext.data[p])
      (proofCounts[f]++, total++);
  const rows = new Uint32Array(total),
    proofFact = new Uint32Array(total);
  for (let f = 0, g = 0; f < length; f++)
    for (let p = store.firstProof.data[f]; p !== NONE; p = store.proofNext.data[p])
      ((rows[g] = p), (proofFact[g++] = f));
  const sourcesList = store.lists.sourceIds;
  const sourceCounts = new Uint32Array(total),
    premiseCounts = new Uint32Array(total),
    broken = new Uint8Array(total);
  for (let g = 0; g < total; g++) {
    const p = rows[g];
    sourceCounts[g] = sourcesList.count.data[p];
    const from = store.premiseStart.data[p],
      to = from + store.premiseCount.data[p];
    for (let i = from; i < to; i++)
      if (store.premises.data[i] < length) premiseCounts[g]++;
      else broken[g] = 1;
  }
  const sourceStart = offsetsOf(sourceCounts),
    premiseStart = offsetsOf(premiseCounts);
  const sourcePool = new Uint32Array(sourceStart[total]),
    premises = new Uint32Array(premiseStart[total]);
  for (let g = 0; g < total; g++) {
    const p = rows[g];
    sourcePool.set(
      sourcesList.pool.data.subarray(
        sourcesList.start.data[p],
        sourcesList.start.data[p] + sourceCounts[g],
      ),
      sourceStart[g],
    );
    const from = store.premiseStart.data[p],
      to = from + store.premiseCount.data[p];
    for (let i = from, at = premiseStart[g]; i < to; i++)
      if (store.premises.data[i] < length) premises[at++] = store.premises.data[i];
  }
  return {
    position: {
      get: (id) => {
        const f = store.position(id);
        return f < length ? f : undefined;
      },
    },
    sourceIds: store.terms,
    sources: store.numbers,
    factProofs: offsetsOf(proofCounts),
    proofFact,
    sourceStart,
    sourcePool,
    premiseStart,
    premises,
    broken,
  };
}

/** Which facts still hold without some sources: a fact holds when one of its
 * proofs uses none of them and rests on facts that hold (the least fixpoint),
 * found in one pass: each proof counts its premises not yet shown to hold. */
export function withheldSupport(graph, withheld) {
  const out = new Set(
    [...withheld].map((id) => graph.sources.get(id)).filter((n) => n !== undefined),
  );
  const proofs = graph.proofFact.length;
  const dead = new Uint8Array(proofs),
    missing = new Uint32Array(proofs),
    holds = new Uint8Array(graph.length),
    queue = [];
  for (let p = 0; p < proofs; p++) {
    let withheldSource = false;
    for (let i = graph.sourceStart[p]; i < graph.sourceStart[p + 1] && !withheldSource; i++)
      withheldSource = out.has(graph.sourcePool[i]);
    dead[p] = graph.broken[p] || withheldSource ? 1 : 0;
    missing[p] = graph.premiseStart[p + 1] - graph.premiseStart[p];
  }
  const prove = (p) => {
    const f = graph.proofFact[p];
    if (dead[p] || missing[p] || holds[f]) return;
    holds[f] = 1;
    queue.push(f);
  };
  for (let p = 0; p < proofs; p++) prove(p);
  while (queue.length) {
    const f = queue.pop();
    for (let i = graph.premiseOfStart[f]; i < graph.premiseOfStart[f + 1]; i++) {
      const p = graph.premiseOf[i];
      missing[p]--;
      prove(p);
    }
  }
  return holds;
}

/** For every fact, the sources each of its proofs rests on, directly or
 * through its premises: the sources without which it would not hold. The
 * greatest fixpoint, from every source: a cyclic proof never removes a source
 * that every proof from the inputs needs. Null for a fact without a usable
 * proof. Reverse load-bearing for a whole check in one sweep. */
export function necessarySources(graph, { maxRounds = 64 } = {}) {
  const top = null; // every source
  const necessary = new Array(graph.length).fill(top);
  const meet = (a, b) => (a === top ? b : b === top ? a : new Set([...a].filter((n) => b.has(n))));
  // The sources one proof rests on: its own, then its premises'.
  const through = (p) => {
    const from = graph.premiseStart[p],
      to = graph.premiseStart[p + 1];
    for (let i = from; i < to; i++) if (necessary[graph.premises[i]] === top) return top;
    const all = new Set();
    for (let i = graph.sourceStart[p]; i < graph.sourceStart[p + 1]; i++)
      all.add(graph.sourcePool[i]);
    for (let i = from; i < to; i++) for (const n of necessary[graph.premises[i]]) all.add(n);
    return all;
  };
  let changed = true,
    rounds = 0;
  for (; changed && rounds < maxRounds; rounds++) {
    changed = false;
    for (let f = 0; f < graph.length; f++) {
      let value = top,
        usable = false;
      for (let p = graph.factProofs[f]; p < graph.factProofs[f + 1]; p++) {
        if (graph.broken[p]) continue;
        value = meet(value, through(p));
        usable = true;
      }
      const same =
        value === necessary[f] ||
        (value !== top &&
          necessary[f] !== top &&
          value.size === necessary[f].size &&
          [...value].every((n) => necessary[f].has(n)));
      if (!usable) continue;
      if (!same) {
        necessary[f] = value;
        changed = true;
      }
    }
  }
  return {
    complete: !changed,
    rounds,
    of: (f) => (necessary[f] === top ? null : [...necessary[f]].map((n) => graph.sourceIds[n])),
  };
}

export function traceRelations(facts, witnesses) {
  const byId = factsById(facts),
    visited = new Set(),
    sourceIds = new Set(),
    ruleIds = new Set(),
    bindingIds = new Set();
  const fragmentIds = new Set();
  const seenProofs = new Set();
  const pending = [{ witnesses }];
  for (let i = 0; i < pending.length; i++) {
    const group = new Set(pending[i].witnesses);
    for (const id of group) {
      const fact = byId.get(id);
      if (!fact) throw new Error('Missing derivation premise');
      for (const proof of guardedEvidence(fact, group)) {
        if (seenProofs.has(proof)) continue;
        seenProofs.add(proof);
        visited.add(id);
        for (const sourceId of proof.sourceIds ?? []) sourceIds.add(sourceId);
        for (const bindingId of proof.bindingIds ?? []) bindingIds.add(bindingId);
        for (const fragmentId of proof.fragmentIds ?? []) fragmentIds.add(fragmentId);
        if (proof.ruleId) ruleIds.add(proof.ruleId);
        if (proof.premises?.length) pending.push({ witnesses: proof.premises });
      }
    }
  }
  return {
    sourceIds: [...sourceIds],
    ruleIds: [...ruleIds],
    fragmentIds: [...fragmentIds],
    ...(bindingIds.size ? { bindingIds: [...bindingIds] } : {}),
    facts: [...visited].map((id) => byId.get(id)),
  };
}
