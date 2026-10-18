/** Asserted clause interfaces. Structural coverage is separate from assertion. */
import { claimRoot } from './claims.mjs';

export const clauseProfile = 'amr-asserted-clauses-v1';

/** Only plain, asserted conjunction/contrast licenses clause projection.
 * Arguments of a predicate, alternatives and embedded modal/reporting content
 * stay inside their enclosing clause. Shared participants keep their identities.
 */
export function clauseFragments(graph, { query = false } = {}) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const root = claimRoot(graph),
    roots = new Set([root]),
    projections = [];
  const expand = (parent, path = new Set()) => {
    if (path.has(parent)) return;
    const concept = nodes.get(parent)?.concept;
    const outgoing = graph.edges.filter((edge) => edge.from === parent);
    const children = outgoing.filter((edge) =>
      concept === 'and'
        ? /^:op[1-9]\d*$/u.test(edge.role)
        : !query && concept === 'contrast-01' && [':ARG1', ':ARG2'].includes(edge.role),
    );
    // A modifier of the connector may qualify both clauses. Do not discard it.
    if (
      children.length < 2 ||
      children.length !== outgoing.length ||
      graph.edges.some(
        (edge) => edge.to === parent && !projections.some((p) => p.edgeId === edge.id),
      ) ||
      new Set(children.map((edge) => edge.role)).size !== children.length ||
      children.some((edge) => path.has(edge.to) || edge.to === parent)
    )
      return;
    for (const edge of children) {
      if (roots.has(edge.to)) continue;
      roots.add(edge.to);
      projections.push({
        parent,
        root: edge.to,
        edgeId: edge.id,
        role: edge.role,
        operator: concept,
      });
      expand(edge.to, new Set([...path, parent]));
    }
  };
  // A source question supplies no asserted coordination.
  if (query || !graph.nodes.some((node) => node.concept === 'amr-unknown')) expand(root);
  const connectors = new Set(projections.map((item) => item.parent));
  // Directed descendants establish clause ownership before inverse modifiers
  // are gathered. A shared participant must not lead an undirected walk into
  // another clause's modal, reported or negative descendants.
  const owners = new Map();
  for (const anchor of roots) {
    const reached = new Set([anchor]);
    if (!connectors.has(anchor))
      for (const id of reached)
        for (const edge of graph.edges) {
          if (edge.from === id && (!roots.has(edge.to) || edge.to === anchor)) reached.add(edge.to);
        }
    for (const id of reached) {
      if (!owners.has(id)) owners.set(id, new Set());
      owners.get(id).add(anchor);
    }
  }
  const fragments = [...roots].map((anchor) => {
    const local = new Set([anchor]);
    const edgeIds = new Set();
    if (connectors.has(anchor)) {
      for (const projection of projections.filter((item) => item.parent === anchor)) {
        local.add(projection.root);
        edgeIds.add(projection.edgeId);
      }
    } else {
      const queue = [anchor];
      for (const id of queue)
        for (const edge of graph.edges) {
          const next = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
          if (
            next === null ||
            (roots.has(next) && next !== anchor) ||
            (owners.has(next) && !owners.get(next).has(anchor))
          )
            continue;
          edgeIds.add(edge.id);
          if (!local.has(next)) {
            local.add(next);
            queue.push(next);
          }
        }
    }
    const edges = graph.edges.filter((edge) => edgeIds.has(edge.id));
    return {
      id: anchor,
      root: anchor,
      kind: connectors.has(anchor) ? 'connector' : 'clause',
      graph: { top: anchor, nodes: graph.nodes.filter((node) => local.has(node.id)), edges },
      guards: edges
        .filter(
          (edge) => edge.role === ':polarity' && nodes.get(edge.to)?.concept !== 'amr-unknown',
        )
        .map((edge) => edge.id),
      ports: [],
      projection: projections.find((item) => item.root === anchor) ?? null,
    };
  });
  const covered = new Set(
    fragments.flatMap((fragment) => fragment.graph.edges.map((edge) => edge.id)),
  );
  // Unusual cross-clause edges must not disappear or silently acquire a reading.
  const residual = graph.edges.filter((edge) => !covered.has(edge.id));
  const coveredNodes = new Set(
    fragments.flatMap((fragment) => fragment.graph.nodes.map((node) => node.id)),
  );
  if (residual.length || graph.nodes.some((node) => !coveredNodes.has(node.id)))
    return {
      profile: clauseProfile,
      fragments: [
        {
          id: root,
          root,
          kind: 'clause',
          graph,
          guards: graph.edges.filter((edge) => edge.role === ':polarity').map((edge) => edge.id),
          ports: [],
          projection: null,
        },
      ],
      projections: [],
      reason: 'Cross-clause edges require an explicit interpretation.',
    };
  for (const fragment of fragments)
    for (const node of fragment.graph.nodes) {
      const peers = fragments.filter(
        (other) => other !== fragment && other.graph.nodes.some((item) => item.id === node.id),
      );
      if (peers.length)
        fragment.ports.push({
          nodeId: node.id,
          concept: node.concept,
          fragments: peers.map((item) => item.id),
        });
    }
  return { profile: clauseProfile, fragments, projections };
}
