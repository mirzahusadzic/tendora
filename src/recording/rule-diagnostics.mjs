/** Bounded explanations of authored premises. Never relax the evaluated rule. */
import { answerMaterial } from './answers.mjs';
import { inferRelations, matchRelations, guardedEvidence } from '../amr/inference.mjs';

export function diagnoseRules(
  recording,
  knowledge,
  ruleIds,
  { budget = 200000, maxPremises = 256, maxRules = 64, maxChecks = 512 } = {},
) {
  if (!ruleIds.length) return [];
  const material = answerMaterial(recording, knowledge);
  const inference = inferRelations(material.facts, material.rules);
  const byId = new Map(inference.facts.map((fact) => [fact.id, fact]));
  const bySubject = new Map();
  for (const fact of inference.facts) {
    if (!bySubject.has(fact.triple[0])) bySubject.set(fact.triple[0], []);
    bySubject.get(fact.triple[0]).push(fact);
  }
  let remaining = budget;
  const match = (patterns) => {
    if (maxChecks-- <= 0) return { matches: [], complete: false, work: 0 };
    const result = matchRelations(patterns, inference.facts, {
      budget: Math.max(0, remaining),
      limit: 20,
    });
    remaining -= result.work;
    return result;
  };
  const term = (value) => {
    const facts = bySubject.get(value) ?? [];
    const sourceId = facts.find((fact) => fact.triple[1] === '@source')?.triple[2];
    return {
      value,
      label: facts.find((fact) => fact.triple[1] === ':instance')?.triple[2] ?? value,
      ...(sourceId ? { sourceId } : {}),
    };
  };
  const results = ruleIds.slice(0, maxRules).map((ruleId) => {
    const rule = material.rules.find((rule) => rule.id === ruleId);
    const stored = knowledge.rules.find((rule) => rule.id === ruleId);
    const base = { ruleId, name: stored?.name ?? ruleId };
    if (!rule)
      return {
        ...base,
        state: 'unavailable',
        issues: [],
        reason:
          material.skipped.find((item) => item.ruleId === ruleId)?.kind ??
          'Outside the selected scope or context',
      };
    const full = match(rule.when);
    const guarded = full.matches.some(({ witnesses }) => {
      const witnessed = new Set(witnesses);
      return witnesses.every((id) => guardedEvidence(byId.get(id), witnessed).length);
    });
    if (guarded) return { ...base, state: 'matched', issues: [] };
    if (!inference.complete)
      return {
        ...base,
        state: 'limited',
        issues: [],
        reason: 'Evaluation reached its limit before premise checking completed',
      };
    if (!full.complete)
      return {
        ...base,
        state: 'limited',
        issues: [],
        reason: 'Premise checking reached its search limit',
      };
    if (full.matches.length)
      return {
        ...base,
        state: 'blocked',
        issues: [],
        reason: 'A source polarity condition is missing from the premises',
      };
    // Find a consistent prefix, retaining every rejected premise as an issue.
    // This diagnoses a conflict with the checked premises, not which assertion
    // ought to be changed. A semantic repair still requires author review.
    const accepted = [],
      issues = [],
      seen = new Set();
    let bindings = {},
      complete = true;
    for (const [index, pattern] of rule.when.entries()) {
      if (remaining <= 0 || maxChecks <= 0 || index >= maxPremises) {
        complete = false;
        break;
      }
      const key = JSON.stringify(pattern);
      if (seen.has(key)) continue;
      seen.add(key);
      const checked = match([...accepted, pattern]);
      if (checked.matches.length) {
        accepted.push(pattern);
        bindings = checked.matches[0].values;
        continue;
      }
      if (!checked.complete) {
        complete = false;
        break;
      }
      const bound = pattern.map((value) => bindings[value] ?? value);
      const terms = bound.map((value) => {
        const result = term(value);
        const concept = rule.when.find(
          (triple) =>
            triple[0] === value && triple[1] === ':instance' && !triple[2].startsWith('?'),
        )?.[2];
        return concept ? { ...result, label: concept } : result;
      });
      const sourceIds = new Set(terms.map((value) => value.sourceId).filter(Boolean));
      const nearby = inference.facts
        .filter(
          ({ triple }) =>
            triple[1].startsWith(':') &&
            triple[1] !== ':instance' &&
            (triple[0] === bound[0] ||
              (triple[1] === bound[1] &&
                (triple[2] === bound[2] ||
                  (bound[2].startsWith('?') && sourceIds.has(term(triple[0]).sourceId))))),
        )
        .sort((a, b) => Number(b.triple[1] === bound[1]) - Number(a.triple[1] === bound[1]))
        .slice(0, 2)
        .map(({ triple }) => triple.map(term));
      issues.push({
        premise: index,
        pattern,
        terms,
        nearby,
        reason: 'Does not match together with the checked premises',
      });
    }
    return {
      ...base,
      state: complete ? 'blocked' : 'limited',
      issues,
      ...(!complete
        ? { reason: 'Premise checking reached its search limit; other conflicts may remain' }
        : {}),
    };
  });
  if (ruleIds.length > maxRules)
    results.push({
      name: 'Remaining proposal rules',
      state: 'limited',
      issues: [],
      reason: `${ruleIds.length - maxRules} rules were not checked because the diagnostic limit was reached`,
    });
  return results;
}
