/** Compare event anchors and role differences between two usable AMR graphs. */
import { compareGraphs } from './comparison.mjs';

/** Exclude alternative pairings of edges that already have exact counterparts. */
export function unmatchedContextDifferences(anchor) {
  const carried = new Set(anchor.shared.map((pair) => pair.fromEdgeId));
  const local = new Set(anchor.shared.map((pair) => pair.sourceEdgeId));
  return (anchor.differences ?? []).filter(
    (pair) => !carried.has(pair.fromEdgeId) && !local.has(pair.sourceEdgeId),
  );
}

const graphs = new WeakMap();
function comparable(graph) {
  if (!graphs.has(graph))
    graphs.set(graph, {
      top: graph.top,
      nodes: [...graph.labels].map(([id, concept]) => ({ id, concept })),
      edges: graph.edges.map((edge, i) => ({ ...edge, id: edge.id ?? `e${i}` })),
    });
  return graphs.get(graph);
}

export function compareContextEvents(inherited, local) {
  const anchors = [];
  const query = comparable(inherited),
    source = comparable(local);
  for (const node of query.nodes.filter((node) => /-\d\d$/u.test(node.concept))) {
    for (const target of source.nodes.filter((item) => item.concept === node.concept)) {
      const result = compareGraphs(query, source, { queryEvent: node.id, sourceEvent: target.id });
      const incident = (graph, id) =>
        graph.edges.flatMap((edge) =>
          edge.from === id
            ? [{ edge, direction: 'out', next: edge.to }]
            : edge.to === id
              ? [{ edge, direction: 'in', next: edge.from }]
              : [],
        );
      const concept = (graph, id) => graph.nodes.find((item) => item.id === id).concept;
      const differences = incident(query, node.id).flatMap((left) =>
        incident(source, target.id)
          .filter(
            (right) =>
              left.direction === right.direction &&
              left.edge.role === right.edge.role &&
              concept(query, left.next) !== concept(source, right.next),
          )
          .map((right) => ({ fromEdgeId: left.edge.id, sourceEdgeId: right.edge.id })),
      );
      const shared = result.shared.map(({ queryEdge, sourceEdge }) => ({
        fromEdgeId: queryEdge.id,
        sourceEdgeId: sourceEdge.id,
      }));
      anchors.push({
        concept: node.concept,
        fromEvent: node.id,
        sourceEvent: target.id,
        complete: result.complete,
        differences: unmatchedContextDifferences({ shared, differences }),
        shared,
      });
    }
  }
  return anchors;
}
