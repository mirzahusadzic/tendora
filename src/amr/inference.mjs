/** Bounded forward chaining over authored triples. No domain predicates or aliases. */
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
  { limit = 2000, budget = 200000, account = null } = {},
) {
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
    return buckets.length
      ? buckets.reduce((smallest, items) => (items.length < smallest.length ? items : smallest))
      : facts;
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

// 53-bit string hash (cyrb53), twice with two seeds: about 106 bits.
const hash53 = (text, seed) => {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

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
  // Semi-naive rounds: a rule none of whose patterns fits a fact that is new,
  // or newly proved, since the last round finds only matches it has already
  // fired or refused. A new proof counts: it can satisfy a witness's guards.
  let changed = null;
  const fits = (pattern, triple) =>
    pattern.every((term, i) => variable(term) || term === triple[i]);
  const touches = (rule) =>
    !changed ||
    rule.when.some((pattern) =>
      (variable(pattern[1]) ? changed.all : (changed.byRole.get(pattern[1]) ?? [])).some((fact) =>
        fits(pattern, fact.triple),
      ),
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
    const cohort = [...facts.values()];
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
      if (!touches(rule)) continue;
      evaluations++;
      const input = rule.baseOnly ? baseCohort : rule.inputOnly ? inputCohort : cohort;
      const matching = matcher(
        rule.when,
        rule.inputSourceIds
          ? input.filter(
              (f) =>
                f.sourceIds?.length && f.sourceIds.every((id) => rule.inputSourceIds.includes(id)),
            )
          : input,
        {
          limit: matchLimit,
          budget: matchBudget,
          account,
        },
      );
      if (!matching.complete) {
        complete = false;
        break;
      }
      for (const { values, witnesses, derivation } of matching.matches) {
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
            touched.add(id);
            added = true;
            continue;
          }
          if (facts.size >= maxFacts) {
            complete = false;
            break;
          }
          facts.set(id, {
            id,
            triple,
            ...proof,
          });
          touched.add(id);
          added = true;
        }
        if (!complete) break;
      }
      if (!complete) break;
    }
    if (!added) return { facts: [...facts.values()], complete, rounds: rounds + 1, evaluations };
    const all = [...touched].map((id) => facts.get(id)),
      byRole = new Map();
    for (const fact of all) {
      if (!byRole.has(fact.triple[1])) byRole.set(fact.triple[1], []);
      byRole.get(fact.triple[1]).push(fact);
    }
    changed = { all, byRole };
  }
  return { facts: [...facts.values()], complete: false, rounds, evaluations };
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
