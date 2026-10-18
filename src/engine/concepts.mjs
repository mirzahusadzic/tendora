/** Corpus conceptual structure: a deterministic view of retained meaning and its ownership. */
import { conceptMaterial } from '../amr/concept-material.mjs';
import { propbankAuditor } from '../models/propbank.mjs';
import { contributionRevision, contributionTitle } from '../project/authoring/development.mjs';
import { connectQuestion } from '../amr/development.mjs';

const { frames } = await propbankAuditor();
export const meaningConcepts = (graph, options = {}) =>
  conceptMaterial(graph, { ...options, frames });
const cache = new WeakMap();
export function developedConcepts(data) {
  if (cache.has(data)) return cache.get(data);
  const roots = [],
    entries = new Map(),
    byContribution = new Map();
  const graphs = new Map();
  for (const c of data.contributions ?? []) {
    const active = c.responses.filter((r) => !r.withdrawn);
    const parts = [
      ...(c.question &&
      (!active.length || active.some((r) => r.composition?.connection === 'unresolved'))
        ? [{ ...c.question, id: 'question' }]
        : []),
      ...active,
    ];
    const own = [];
    for (const part of parts) {
      const sourceId = `contribution:${c.id}:${part.id}`;
      const material = meaningConcepts(part.graph, { sourceId, text: part.text });
      const state =
        part.id === 'question'
          ? 'Question'
          : part.graph.edges.some((e) => e.role === ':condition')
            ? 'Conditional contribution'
            : part.graph.edges.some((e) => e.role === ':polarity')
              ? 'Qualified contribution'
              : 'Authored contribution';
      for (const item of material.entries) {
        Object.assign(item, {
          kind: 'material-concept',
          placementId: c.scopePlacementId,
          contributionId: c.id,
          partId: part.id,
          sourceId,
          sourceText: part.text,
          question: c.question?.text ?? '',
          graph: part.graph,
          materialState: state,
          contributionIds: [c.id],
          label: `${item.relation ? item.relation + ': ' : ''}${item.name}${item.referenceTo ? ' ↩' : ''}`,
          anchor: {
            contributionId: c.id,
            partId: part.id,
            nodeId: item.nodeId,
            revision: contributionRevision(part.graph),
            question: contributionTitle(c),
            label: item.name,
          },
        });
        entries.set(item.id, item);
      }
      graphs.set(sourceId, material);
      own.push(...material.roots);
    }
    byContribution.set(c.id, own);
    roots.push(...own);
  }
  // An explicit anchor locates a development branch. It is not an equality assertion.
  for (const c of data.contributions ?? []) {
    if (!c.anchor || c.anchor.contributionId === c.id) continue;
    const parent = data.contributions.find((p) => p.id === c.anchor.contributionId);
    if (!parent) {
      for (const root of byContribution.get(c.id) ?? [])
        root.contextNote = 'The source this connection developed was deleted.';
      continue;
    }
    const basis =
      c.anchor.partId === 'question'
        ? parent.question
        : parent.responses.find((r) => r.id === c.anchor.partId);
    // Relation anchors keep the edge identity while attaching the development
    // to a concrete endpoint in the current material tree.
    let nodeId = c.anchor.nodeId ?? c.anchor.to ?? c.anchor.from;
    let alignment;
    if (!nodeId && basis && c.question && c.anchor.bindings) {
      alignment = connectQuestion(c.question.graph, basis.graph, { partial: true });
      nodeId = c.anchor.bindings[alignment.variables.get(c.question.graph.top)];
    } else if (!nodeId && basis && c.question) {
      alignment = connectQuestion(c.question.graph, basis.graph, { partial: true });
      if (alignment.complete && alignment.matches.length === 1)
        nodeId = alignment.matches[0].values[alignment.variables.get(c.question.graph.top)];
    }
    let target = entries.get(`contribution:${parent.id}:${c.anchor.partId}#${nodeId}`);
    if (!target && c.anchor.partId === 'question' && nodeId) {
      const choices = [];
      for (const response of parent.responses.filter((r) => !r.withdrawn)) {
        const match = connectQuestion(parent.question.graph, response.graph);
        if (!match.complete || match.matches.length !== 1) continue;
        const mapped = match.matches[0].values[match.variables.get(nodeId)];
        const location = entries.get(`contribution:${parent.id}:${response.id}#${mapped}`);
        if (location) choices.push({ location, match });
      }
      if (choices.length === 1) {
        target = choices[0].location;
        alignment = choices[0].match;
      }
    }
    if (
      !target ||
      target.placementId !== c.scopePlacementId ||
      (c.anchor.revision && (!basis || contributionRevision(basis.graph) !== c.anchor.revision))
    ) {
      for (const root of byContribution.get(c.id) ?? [])
        root.contextNote = basis?.withdrawn
          ? 'The source this connection developed was withdrawn.'
          : 'The original context is retained; it has no unique current attachment.';
      continue;
    }
    for (const child of byContribution.get(c.id) ?? []) {
      // Reject cyclic navigation even if old or imported anchor data contains a cycle.
      let at = target;
      const visited = new Set([child.id]);
      while (at && !visited.has(at.id)) {
        visited.add(at.id);
        at = entries.get(at.parentId);
      }
      if (at) continue;
      roots.splice(roots.indexOf(child), 1);
      child.parentId = target.id;
      child.contextLink = true;
      child.label = `Develops: ${child.label}`;
      if (alignment) child.anchorDerivation = alignment.matches[0].derivation;
      target.children.push(child);
    }
  }
  function summarize(item, depth = 0) {
    item.depth = depth;
    for (const child of item.children) summarize(child, depth + 1);
    item.contributionIds = [
      ...new Set([item.contributionId, ...item.children.flatMap((x) => x.contributionIds)]),
    ];
  }
  for (const root of roots) summarize(root);
  const result = { roots, entries, byContribution, graphs };
  cache.set(data, result);
  return result;
}
