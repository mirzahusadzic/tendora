/** Bounded backward search over attributed facts and authored multi-head rules. */
import { collectRelationFacts, guardedEvidence } from './inference.mjs';
const variable = (term) => typeof term === 'string' && term.startsWith('?');
const generated = (term) => typeof term === 'string' && term.startsWith('$');
const key = (value) => JSON.stringify(value);
const freshIdentity = (index, term) => `generated:${index}:${term.slice(1)}`;

/** Replay the same substitution used by search, without running another search. */
export function groundApplication(rule, application, index) {
  const resolve = (term) =>
    variable(term)
      ? application.bindings[term]
      : generated(term)
        ? freshIdentity(index, term)
        : term;
  const instantiate = (triples) =>
    triples.map((triple) =>
      triple.map((term) => {
        const value = resolve(term);
        if (typeof value !== 'string' || variable(value) || generated(value))
          throw new Error('Ungrounded rule application');
        return value;
      }),
    );
  return {
    premises: instantiate(rule.when),
    conclusions: instantiate(rule.then),
    ...(rule.root ? { root: resolve(rule.root) } : {}),
  };
}
const dereference = (term, values) => {
  const seen = new Set();
  while (variable(term) && values[term] !== undefined && !seen.has(term)) {
    seen.add(term);
    term = values[term];
  }
  return term;
};
function unify(left, right, values) {
  const next = { ...values };
  for (let i = 0; i < 3; i++) {
    const a = dereference(left[i], next),
      b = dereference(right[i], next);
    if (a === b) continue;
    if (variable(a)) next[a] = b;
    else if (variable(b)) next[b] = a;
    else return null;
  }
  return next;
}
const compatible = (a, b) =>
  a.every(
    (value, index) =>
      variable(value) || variable(b[index]) || generated(b[index]) || value === b[index],
  );

function dependsOn(applications, from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (
    applications[from]?.dependencies.some((next) => dependsOn(applications, next, target, seen)) ??
    false
  );
}
function dependency(applications, consumer, producer) {
  if (consumer === null) return applications;
  if (dependsOn(applications, producer, consumer)) return null;
  return applications.map((item, i) =>
    i === consumer
      ? { ...item, dependencies: [...new Set([...item.dependencies, producer])] }
      : item,
  );
}
function canonical(state) {
  const variables = new Map(),
    fresh = new Map();
  const term = (value) => {
    value = dereference(value, state.values);
    const map = variable(value) ? variables : value.startsWith('generated:') ? fresh : null;
    if (!map) return value;
    if (!map.has(value)) map.set(value, `${map === variables ? '?' : '$'}${map.size}`);
    return map.get(value);
  };
  return key([
    state.goals.map((goal) => [goal.owner, goal.triple.map(term)]),
    state.applications.map((app) => [
      app.ruleId,
      app.then.map((triple) => triple.map(term)),
      app.dependencies,
      app.requested?.map(term),
    ]),
    state.witnesses.map((witness) => [witness.owner, witness.id]),
  ]);
}

/** One iteration expands one state, allowing callers to yield and cancel. */
export function* searchCompositions({
  facts,
  rules,
  goals,
  alternatives = [],
  limits = {},
  initial = null,
}) {
  const maxStates = limits.maxStates ?? 2000,
    maxChecks = limits.maxChecks ?? 200000,
    maxDepth = limits.maxDepth ?? 24,
    maxFrontier = limits.maxFrontier ?? 2000,
    maxProofs = limits.maxProofs ?? 32;
  for (const value of [maxStates, maxChecks, maxDepth, maxFrontier, maxProofs])
    if (!Number.isInteger(value) || value < 1)
      throw new Error('Search limits must be positive integers');
  const { facts: byId } = collectRelationFacts(facts);
  const indexes = [new Map(), new Map(), new Map()],
    heads = new Map(),
    variableHeads = [];
  for (const fact of byId.values()) {
    fact.triple.forEach((term, index) => {
      if (!indexes[index].has(term)) indexes[index].set(term, []);
      indexes[index].get(term).push(fact);
    });
  }
  for (const rule of rules)
    for (const [index, triple] of rule.then.entries()) {
      if (!heads.has(triple[1])) heads.set(triple[1], []);
      heads.get(triple[1]).push({ rule, index, triple });
      if (variable(triple[1])) variableHeads.push({ rule, index, triple });
    }
  const seed = (patterns) => ({
    goals: patterns.map((triple) => ({ triple, owner: null })),
    values: {},
    applications: [],
    witnesses: [],
  });
  const frontier = initial?.frontier
    ? structuredClone(initial.frontier)
    : [goals, ...alternatives].map(seed);
  const proofs = initial?.proofs ? structuredClone(initial.proofs) : [];
  const seen = new Set(),
    openings = new Map();
  const stats = {
    states: 0,
    checks: 0,
    duplicates: 0,
    cycleStops: 0,
    depthLimited: 0,
    discarded: 0,
  };
  let stopped = false;
  const candidateCache = new Map();
  const candidates = (goal) => {
    const signature = key(goal.map((term) => (variable(term) ? null : term)));
    if (candidateCache.has(signature)) return candidateCache.get(signature);
    const buckets = goal.flatMap((term, index) =>
      variable(term) ? [] : [indexes[index].get(term) ?? []],
    );
    const bucket = buckets.length
      ? buckets.reduce((smallest, bucket) => (bucket.length < smallest.length ? bucket : smallest))
      : [...byId.values()];
    const result = [];
    for (const fact of bucket) {
      if (stats.checks >= maxChecks) {
        stopped = true;
        return [];
      }
      stats.checks++;
      if (compatible(goal, fact.triple)) result.push(fact);
    }
    candidateCache.set(signature, result);
    return result;
  };
  const ruleCandidates = (goal) =>
    (variable(goal[1])
      ? [...heads.values()].flat()
      : [...(heads.get(goal[1]) ?? []), ...variableHeads]
    ).filter(({ triple }) =>
      triple.every(
        (term, index) =>
          variable(goal[index]) || variable(term) || (!generated(term) && term === goal[index]),
      ),
    );
  while (
    frontier.length &&
    stats.states < maxStates &&
    stats.checks < maxChecks &&
    proofs.length < maxProofs
  ) {
    const state = frontier.shift(),
      signature = canonical(state);
    if (seen.has(signature)) {
      stats.duplicates++;
      continue;
    }
    seen.add(signature);
    stats.states++;
    if (!state.goals.length) {
      const evidence = (witness) =>
        guardedEvidence(
          byId.get(witness.id),
          new Set(
            state.witnesses
              .filter((other) => other.owner === witness.owner)
              .map((other) => other.id),
          ),
        );
      const guarded = state.witnesses.every((witness) => evidence(witness).length);
      if (guarded) {
        const proof = {
          bindings: Object.fromEntries(
            Object.keys(state.values)
              .filter((name) => !name.startsWith('?step'))
              .map((name) => [name, dereference(name, state.values)]),
          ),
          applications: state.applications.map((app, owner) => ({
            ruleId: app.ruleId,
            dependencies: app.dependencies,
            bindings: Object.fromEntries(
              Object.entries(app.variables)
                .filter(([name]) => !name.startsWith('?occurrence'))
                .map(([name, value]) => [name, dereference(value, state.values)]),
            ),
            sourceIds: [
              ...new Set(
                state.witnesses
                  .filter((witness) => witness.owner === owner)
                  .flatMap((witness) =>
                    evidence(witness).flatMap((proof) => proof.sourceIds ?? []),
                  ),
              ),
            ],
          })),
          witnesses: [...new Set(state.witnesses.map((witness) => witness.id))],
        };
        proof.bindingIds = [
          ...new Set(
            state.witnesses.flatMap((witness) =>
              evidence(witness).flatMap((proof) => proof.bindingIds ?? []),
            ),
          ),
        ];
        if (!proofs.some((other) => key(other) === key(proof))) proofs.push(proof);
      }
      yield { stats: { ...stats }, frontier: frontier.length, proofs: proofs.length };
      continue;
    }
    const ordered = state.goals
      .map((goal, index) => {
        const triple = goal.triple.map((term) => dereference(term, state.values));
        const direct = candidates(triple);
        // A repeated obligation on the same dependency path adds no grounding.
        // Direct facts and independent applications still supply alternative proofs.
        const repeated =
          goal.owner !== null &&
          state.applications.some(
            (app, ancestor) =>
              app.requested &&
              dependsOn(state.applications, ancestor, goal.owner) &&
              key(app.requested.map((term) => dereference(term, state.values))) === key(triple),
          );
        const applicable = repeated ? [] : ruleCandidates(triple);
        const existing = state.applications.flatMap((app, producer) =>
          goal.owner !== null && dependsOn(state.applications, producer, goal.owner)
            ? []
            : app.then.flatMap((head) =>
                compatible(
                  triple,
                  head.map((term) => dereference(term, state.values)),
                )
                  ? [{ head, producer }]
                  : [],
              ),
        );
        return { goal, triple, index, direct, applicable, existing, repeated };
      })
      .sort((a, b) => {
        const count = (item) => item.direct.length + item.applicable.length + item.existing.length;
        // Source and root guards often have one known witness. Establish these
        // bindings before opening another rule, and reject impossible outer goals
        // without first exploring all of a nested application's premises.
        return (
          count(a) - count(b) || Number(a.applicable.length > 0) - Number(b.applicable.length > 0)
        );
      });
    if (stopped) {
      frontier.unshift(state);
      break;
    }
    const selected = ordered[0],
      remaining = state.goals.filter((_, index) => index !== selected.index),
      nextStates = [];
    if (selected.repeated) stats.cycleStops++;
    const spend = () => {
      if (stats.checks >= maxChecks) {
        stopped = true;
        return false;
      }
      stats.checks++;
      return true;
    };
    for (const fact of selected.direct) {
      if (!spend()) break;
      const values = unify(selected.triple, fact.triple, state.values);
      if (values)
        nextStates.push({
          ...state,
          goals: remaining,
          values,
          witnesses: [...state.witnesses, { owner: selected.goal.owner, id: fact.id }],
        });
    }
    for (const { head, producer } of selected.existing) {
      if (!spend()) break;
      const values = unify(selected.triple, head, state.values);
      const applications = values && dependency(state.applications, selected.goal.owner, producer);
      if (applications) nextStates.push({ ...state, goals: remaining, values, applications });
    }
    if (state.applications.length < maxDepth)
      for (const { rule, index } of selected.applicable) {
        if (!spend()) break;
        const number = state.applications.length,
          variables = {};
        const rename = (term) => {
          if (variable(term)) return (variables[term] ??= `?step${number}_${term.slice(1)}`);
          if (generated(term)) return freshIdentity(number, term);
          return term;
        };
        const then = rule.then.map((triple) => triple.map(rename)),
          when = rule.when.map((triple) => triple.map(rename));
        const values = unify(selected.triple, then[index], state.values);
        if (!values) continue;
        const applications = dependency(
          [
            ...state.applications,
            { ruleId: rule.id, variables, then, requested: then[index], dependencies: [] },
          ],
          selected.goal.owner,
          number,
        );
        if (applications)
          nextStates.push({
            ...state,
            values,
            applications,
            goals: [...remaining, ...when.map((triple) => ({ triple, owner: number }))],
          });
      }
    else if (selected.applicable.length) stats.depthLimited++;
    if (!nextStates.length)
      openings.set(key(selected.triple), {
        pattern: selected.triple,
        ruleIds:
          selected.goal.owner === null ? [] : [state.applications[selected.goal.owner].ruleId],
      });
    if (stopped) {
      frontier.unshift(state);
      break; // Recompute this unfinished expansion on continuation.
    }
    const room = maxFrontier - frontier.length;
    if (nextStates.length > room) stats.discarded += nextStates.length - room;
    frontier.push(...nextStates.slice(0, room));
    yield { stats: { ...stats }, frontier: frontier.length, proofs: proofs.length };
  }
  const complete = !frontier.length && !stats.depthLimited && !stats.discarded && !stopped;
  return {
    proofs,
    openings: [...openings.values()].slice(0, 64),
    stats,
    complete,
    frontier: frontier.slice(0, maxFrontier),
    ...(stats.discarded || stats.depthLimited ? { recompute: true } : {}),
  };
}
