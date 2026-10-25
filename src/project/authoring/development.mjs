/** Explicit corpus contributions. Derived graphs retain their authored inputs. */
import { createHash } from 'node:crypto';
import { validateGraph } from '../../amr/revision.mjs';
import { validateRule } from '../../amr/inference.mjs';
import { ruleWithoutWikiLinks } from '../../amr/roles.mjs';

export const contributionRevision = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const contributionTitle = (c) =>
  c.question?.text ?? c.responses.find((r) => !r.withdrawn)?.text ?? c.responses[0]?.text;
export function removeContribution(data, id) {
  if (!(data.contributions ?? []).some((c) => c.id === id))
    throw new Error('Contribution is no longer available.');
  return validateContributions({
    ...data,
    contributions: data.contributions.filter((c) => c.id !== id),
  });
}
export function validateContributions(data) {
  const ids = new Set();
  for (const c of data.contributions ?? []) {
    if (
      c.version !== 1 ||
      !c.id ||
      ids.has(c.id) ||
      (c.question ? !c.question.text?.trim() : c.kind !== 'material') ||
      !data.placements.some((p) => p.id === c.scopePlacementId) ||
      !Array.isArray(c.responses) ||
      !Array.isArray(c.wordings)
    )
      throw new Error('Invalid corpus contribution');
    ids.add(c.id);
    if (c.question) validateGraph(c.question.graph);
    if (!c.question && (!c.responses.length || c.wordings.some((w) => w.kind !== 'perspective')))
      throw new Error('Material needs at least one retained statement');
    if (c.questionHistory !== undefined && !Array.isArray(c.questionHistory))
      throw new Error('Invalid contribution history');
    for (const previous of c.questionHistory ?? []) {
      if (!previous.text?.trim()) throw new Error('Invalid contribution history');
      validateGraph(previous.graph);
    }
    const parts = new Set();
    for (const r of [...c.responses, ...c.wordings]) {
      if (!r.id || parts.has(r.id) || !r.text?.trim()) throw new Error('Invalid contribution part');
      parts.add(r.id);
      validateGraph(r.graph);
      if (r.rule) validateRule(r.rule);
      if (r.reverseRule) validateRule(r.reverseRule);
      if (
        r.kind === 'clarification' &&
        (!r.rule ||
          !r.confirmation?.candidateId ||
          !r.confirmation?.statement ||
          !Array.isArray(r.basisSources) ||
          !r.basisSources.length ||
          r.basisSources.some((s) => !s.text || !s.nodeId || !s.sentenceId || !s.revision))
      )
        throw new Error('A confirmed connection needs its retained source and author decision');
    }
  }
  return data;
}

export function contributionSources(data) {
  const placements = new Map(data.placements.map((p) => [p.id, p]));
  return (data.contributions ?? []).flatMap((c) => {
    const placement = placements.get(c.scopePlacementId);
    if (!placement) return [];
    const parts = [
      ...(c.question
        ? [{ id: 'question', text: c.question.text, graph: c.question.graph, asserted: false }]
        : []),
      ...c.responses
        .filter((r) => !r.withdrawn)
        .map((r) => ({
          ...r,
          text: c.question ? `${c.question.text} Answer: ${r.text}` : r.text,
          asserted: true,
        })),
      ...c.wordings
        .filter((r) => !r.withdrawn)
        .map((r) => ({
          ...r,
          text:
            r.kind === 'clarification'
              ? `Confirmed connection: ${r.basisSources.map((s) => s.text).join('\n')} / ${r.text}`
              : `${r.kind === 'perspective' ? 'Perspective' : 'Same question'}: ${contributionTitle(c)} / ${r.text}`,
          asserted: false,
        })),
    ];
    return parts.map((r) => ({
      sentenceId: `contribution:${c.id}:${r.id}`,
      conceptId: placement.conceptId,
      nodeId: placement.id,
      revision: contributionRevision(r),
      text: r.text,
      graph: r.graph,
      sourceRefs: c.origin ? [c.origin] : [],
      development: {
        contributionId: c.id,
        partId: r.id,
        asserted: r.asserted,
        labels: Object.fromEntries(
          r.graph.nodes
            .filter((n) => n.authoredLabel || n.surfaceLabel)
            .map((n) => [n.id, n.authoredLabel ?? n.surfaceLabel]),
        ),
        anchor: c.anchor ?? null,
      },
      acquisition: {
        status: 'composed',
        origin: { kind: 'question-driven-corpus', contributionId: c.id },
        inputs: [c.question?.acquisition, r.acquisition].filter(Boolean),
      },
    }));
  });
}

export function contributionRules(data) {
  const sources = contributionSources(data);
  const within = (root) => {
    const ids = new Set([root]);
    for (const id of ids) for (const p of data.placements) if (p.parentId === id) ids.add(p.id);
    return [...ids];
  };
  return (data.contributions ?? []).flatMap((c) =>
    c.wordings
      .filter(
        (w) =>
          !w.withdrawn &&
          (!w.basisResponseId ||
            c.responses.some((r) => r.id === w.basisResponseId && !r.withdrawn)),
      )
      .flatMap((w) =>
        [w.rule, w.reverseRule].filter(Boolean).map((rule, direction) => ({
          ...ruleWithoutWikiLinks(rule),
          baseOnly: true,
          id: `contribution:${c.id}:wording:${w.id}:${direction}`,
          scopePlacementId: c.scopePlacementId,
          applicationPlacementIds: within(c.scopePlacementId),
          ...(w.basisSources ? { applicationSourceReferences: w.basisSources } : {}),
          attribution:
            w.kind === 'clarification'
              ? `Author confirmed this corpus connection: ${w.text}`
              : `Author supplied ${w.kind === 'perspective' ? 'another perspective on' : 'another wording for'}: ${contributionTitle(c)}`,
          sources: [
            ...sources
              .filter(
                (s) =>
                  s.development.contributionId === c.id &&
                  [w.id, w.basisResponseId].includes(s.development.partId),
              )
              .map((s) => ({ text: s.text, nodeId: s.nodeId, revision: s.revision })),
            ...(w.basisSources ?? []),
          ],
          origin: { kind: 'engine-authored-corpus', contributionId: c.id, wordingId: w.id },
        })),
      ),
  );
}
