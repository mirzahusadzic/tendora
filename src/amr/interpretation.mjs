/** Pure review of explicitly supplied AMR correspondences. */
import { compareGraphs } from './comparison.mjs';

export function reviewCorrespondence(query, source, options, correspondence) {
  const before = compareGraphs(query, source, options);
  const after = compareGraphs(query, source, { ...options, correspondence });
  const factual = (edge) =>
    !(
      edge.role === ':polarity' &&
      query.nodes.find((n) => n.id === edge.to)?.concept === 'amr-unknown'
    );
  const previous = new Set(before.shared.map((pair) => pair.queryEdge.id)),
    current = new Set(after.shared.map((pair) => pair.queryEdge.id));
  return {
    before,
    after,
    beforeCount: before.shared.filter((p) => factual(p.queryEdge)).length,
    afterCount: after.shared.filter((p) => factual(p.queryEdge)).length,
    added: after.shared
      .filter((pair) => !previous.has(pair.queryEdge.id) && factual(pair.queryEdge))
      .map((p) => p.queryEdge),
    lost: before.shared
      .filter((pair) => !current.has(pair.queryEdge.id) && factual(pair.queryEdge))
      .map((p) => p.queryEdge),
    unresolved: after.queryOnly.filter(factual),
    complete: before.complete && after.complete,
  };
}

export function interpretationEdge(graph, edge) {
  const label = (id) => graph.nodes.find((node) => node.id === id)?.concept ?? id;
  return `${label(edge.from)} ${edge.role} → ${label(edge.to)}`;
}
