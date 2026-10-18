/** Bounded explanations of a missing condition leaf. These never add inference facts. */
import { guardedEvidence, traceRelations } from './inference.mjs';

const variable = (term) => /^\?[A-Za-z][\w-]*$/u.test(term);
const nodeTerm = (term) => /^[?$][A-Za-z][\w-]*$/u.test(term);

export function conditionOpenings(patterns, rules, facts, matcher, { budget = 30000 } = {}) {
  const openings = [];
  const account = { work: 0, limit: budget };
  const options = { budget, limit: 2000, account };
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  for (const rule of rules.filter((rule) => rule.kind === 'amr-condition')) {
    // Recognition here only selects a relevant conditional source. Its hypothetical
    // conclusion is kept out of the corpus and the forward inference cohort.
    const head = rule.then.map((triple, i) => ({
      id: `condition-head:${i}`,
      triple: triple.map((term) => (nodeTerm(term) ? `condition-head:${term}` : term)),
      sourceIds: [],
    }));
    const relevant = matcher(patterns, head, options);
    if (!relevant.complete || !relevant.matches.length) continue;
    const roots = new Set(rule.when.filter((t) => t[1] === '@asserted').map((t) => t[0]));
    const retained = new Set(rule.then.flat().filter(variable));
    const instances = new Map(
      rule.when.filter((t) => t[1] === ':instance').map((t) => [t[0], t[2]]),
    );
    const edges = rule.when.filter((t) => t[1].startsWith(':') && t[1] !== ':instance');
    for (const [leaf] of instances) {
      if (!variable(leaf) || roots.has(leaf) || retained.has(leaf)) continue;
      const adjacent = edges.filter((t) => t[0] === leaf || t[2] === leaf);
      if (adjacent.length !== 1 || adjacent[0][1] === ':polarity') continue;
      const edge = adjacent[0];
      const remainder = rule.when.filter((triple) => !triple.includes(leaf));
      const matching = matcher(remainder, facts, options);
      if (!matching.complete) continue;
      const matches = matching.matches.filter((match) => {
        const witnesses = new Set(match.witnesses);
        return match.witnesses.every((id) => guardedEvidence(byId.get(id), witnesses).length);
      });
      if (!matches.length) continue;
      const proofs = matches.map((match) => traceRelations(facts, match.witnesses));
      openings.push({
        id: `condition:${rule.id}:${leaf}`,
        kind: 'condition',
        state: 'unmatched',
        from: instances.get(edge[0]),
        role: edge[1],
        to: instances.get(edge[2]),
        conditionId: rule.id,
        reason:
          'The rest of this authored condition matches the available evidence. This relationship is not established for the same participants. Check the case circumstances or revise the supporting source.',
        sourceIds: [...new Set([...rule.sourceIds, ...proofs.flatMap((proof) => proof.sourceIds)])],
        ruleIds: [],
        matches: matches.map(({ values, derivation }) => ({ values, derivation })),
      });
    }
    if (account.work >= account.limit) break;
  }
  return openings;
}
