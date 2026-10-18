/** Candidate preparation shared by the TUI and CLI; similarity grants no facts. */
import { answerMaterial, answerQuery } from './answers.mjs';
import { graphRevision } from './revisions.mjs';
import { compareGraphs } from '../amr/comparison.mjs';
import { claimRoot, graphPatterns, inquiryPattern } from '../amr/patterns.mjs';

export function compositionMaterial(
  recording,
  knowledge,
  preparation,
  { comparisonLimit = 2000 } = {},
) {
  const material = answerMaterial(recording, knowledge, preparation);
  const { graph: query, conflict } = answerQuery(recording, knowledge, preparation);
  if (conflict) throw new Error('Conflicting question parses need review');
  const pattern = inquiryPattern(query);
  const nodes = new Map(query.nodes.map((node) => [node.id, node]));
  const sourceById = new Map(material.sources.map((source) => [source.id, source]));
  const candidates = material.sourceGraphs
    .map(({ sourceId, graph }) => {
      const source = sourceById.get(sourceId);
      let best = null;
      const fragments = graphPatterns(graph);
      const anchors = query.nodes
        .filter((node) => node.concept !== 'amr-unknown' && !node.id.startsWith('literal:'))
        .flatMap((node) =>
          fragments
            .filter((other) => other.concept === node.concept)
            .map((other) => [node, { id: other.anchor, concept: other.concept }]),
        )
        .sort(
          (a, b) =>
            Number(b[0].id === claimRoot(query)) - Number(a[0].id === claimRoot(query)) ||
            Number(/-\d+$/u.test(b[0].concept)) - Number(/-\d+$/u.test(a[0].concept)),
        )
        .slice(0, 3);
      for (const [anchor, other] of anchors) {
        const compared = compareGraphs(query, graph, {
          queryEvent: anchor.id,
          sourceEvent: other.id,
          searchLimit: comparisonLimit,
        });
        if (!best || compared.shared.length > best.shared.length) best = compared;
      }
      const required = query.edges.filter(
        (edge) => !(edge.role === ':polarity' && nodes.get(edge.to)?.concept === 'amr-unknown'),
      );
      return {
        sourceId,
        nodeId: source.nodeId,
        text: source.text,
        graphRevision: graphRevision(graph),
        matched:
          best?.shared.filter((pair) => required.some((edge) => edge.id === pair.queryEdge.id))
            .length ?? 0,
        required: required.length,
        complete: best?.complete ?? true,
        shared: best?.shared.map((pair) => [pair.queryEdge.id, pair.sourceEdge.id]) ?? [],
        ...(source.affinity !== undefined ? { affinity: source.affinity } : {}),
      };
    })
    .sort(
      (a, b) =>
        b.matched - a.matched ||
        (b.affinity ?? 0) - (a.affinity ?? 0) ||
        a.sourceId.localeCompare(b.sourceId),
    );
  const compatible = (a, b) =>
    a.every((term, index) => /^[?$]/u.test(term) || /^[?$]/u.test(b[index]) || term === b[index]);
  const pending = [...pattern.patterns],
    needed = new Set();
  for (let i = 0; i < pending.length; i++)
    for (const rule of material.rules) {
      if (!needed.has(rule.id) && rule.then.some((head) => compatible(head, pending[i]))) {
        needed.add(rule.id);
        pending.push(...rule.when);
      }
    }
  const dependencySources = [
    ...new Set([
      ...material.rules.filter((rule) => needed.has(rule.id)).flatMap((rule) => rule.sourceIds),
      ...material.bindings.flatMap((binding) => binding.sourceIds),
    ]),
  ];
  return { ...material, query, pattern, candidates, dependencySources };
}

export function compositionOpenings(recording, material, search) {
  const byId = new Map(material.sources.map((source) => [source.id, source]));
  const missing = material.skipped
    .filter((item) => item.kind === 'missing source')
    .flatMap((item) =>
      (item.missingSources ?? []).map((source) => ({
        label: `Restore support for ${item.ruleName}`,
        reason: `The interpretation requires a source that is missing or outside this context: ${source.text}`,
        sources: source.nodeId ? [{ text: source.text, nodeId: source.nodeId }] : [],
        nextStep: `Review the missing source and its scope before using ${item.ruleName}. Restore or revise its support through the editor; do not assume the source remains available.`,
        solver: { kind: 'missing-source', ruleIds: [item.ruleId] },
      })),
    );
  const parses = material.skipped
    .filter((item) => item.kind === 'conditional parse')
    .map((item) => ({
      label: 'Review the conditional source',
      reason: item.reason,
      sources: [{ text: item.sourceText, nodeId: byId.get(item.sourceId).nodeId }],
      nextStep:
        'Preserve the source conditions while revising its wording or scoped interpretation.',
      solver: { kind: 'conditional-parse', sourceId: item.sourceId },
    }));
  return [
    ...missing,
    ...parses,
    ...search.openings.map((item, index) => {
      const [from, role, to] = item.pattern;
      const rules = item.ruleIds
        .map((id) => material.rules.find((rule) => rule.id === id))
        .filter(Boolean);
      const condition =
        role === '@asserted' && rules.some((rule) => rule.id.endsWith('/condition-v1'));
      const node = material.nodes.find((node) => node.id === from);
      const concept = node?.concept?.replace(/-\d+$/u, '').replaceAll('-', ' ');
      const sources = [...new Set(rules.flatMap((rule) => rule.sourceIds ?? []))]
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map(({ text, nodeId }) => ({ text, nodeId }));
      const label = condition
        ? `Establish the ${concept ?? 'source'} condition`
        : role === ':instance'
          ? `Support the inquiry’s ${to.replace(/-\d+$/u, '').replaceAll('-', ' ')} concept`
          : role === '@asserted'
            ? 'Establish the requested claim'
            : rules.length
              ? `Complete ${rules[0].name}`
              : `Connect ${role}`;
      return {
        label,
        reason: condition
          ? `No asserted ${concept ?? 'source'} event matches this condition in the selected evidence. Its occurrence inside an if-clause does not establish that it happened.`
          : rules.length
            ? `The interpretation ${rules[0].name} requires a relation that could not be joined in the examined sources.`
            : `No examined fact or authored interpretation supplies ${role === ':instance' ? to : role} with the required bindings.`,
        sources,
        nextStep: condition
          ? 'Compare this condition with the case evidence. Preserve its speaker, polarity and modality; do not introduce an event absent from the evidence.'
          : `Review the referenced sources for ${recording.inquiry.text}. Keep the selected case, scope and qualifications explicit when refining source sentences.`,
        solver: { pattern: item.pattern, ruleIds: item.ruleIds },
      };
    }),
  ];
}
