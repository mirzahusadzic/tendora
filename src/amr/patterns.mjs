/** Shared query obligations and connected source patterns, independent of layout. */
import { claimRoot } from './claims.mjs';
import { clauseFragments } from './clause-fragments.mjs';
export { claimRoot } from './claims.mjs';

// recommend-01 roles in obligate-01 terms: the recommendation is the
// obligation, the one it is recommended to is the obligated agent.
const requirementRoles = { ':ARG0': ':ARG0', ':ARG1': ':ARG2', ':ARG2': ':ARG1' };
/** “Should” asked as “must”: a requirement answers a recommendation, never the
 * reverse. Null when the question asks no “should”, or one with roles that
 * have no requirement counterpart.
 */
export function requirementReading(query) {
  const asked = new Set(
    query.nodes.filter((node) => node.concept === 'recommend-01').map((node) => node.id),
  );
  if (!asked.size) return null;
  // The yes/no marker carries over; a negated “should” (not recommended) is not
  // a negated requirement, so it has no requirement reading.
  const marker = (edge) =>
    edge.role === ':polarity' &&
    query.nodes.find((node) => node.id === edge.to)?.concept === 'amr-unknown';
  if (
    query.edges.some(
      (edge) => asked.has(edge.from) && !(edge.role in requirementRoles) && !marker(edge),
    )
  )
    return null;
  return {
    ...query,
    nodes: query.nodes.map((node) =>
      asked.has(node.id) ? { ...node, concept: 'obligate-01' } : node,
    ),
    edges: query.edges.map((edge) =>
      asked.has(edge.from) && !marker(edge) ? { ...edge, role: requirementRoles[edge.role] } : edge,
    ),
  };
}

/** Query-only repair of reused answer slots in explicit coordination. */
export function normalizeCoordinatedUnknowns(query, questionText = '') {
  const unchanged = { graph: query };
  // The acquired graph alone cannot distinguish an intentional shared identity
  // from an acquisition collision. The exact question text supplies the
  // independent evidence: two interrogative words mean two answer slots.
  const interrogatives = String(questionText).match(
    /\b(?:who|whom|whose|what|which|where|when|why|how)\b/giu,
  );
  if (questionText && (interrogatives?.length ?? 0) < 2) return unchanged;
  // Explicit semantic identity is a constraint, not an acquisition collision.
  if (
    query.nodes.some((node) =>
      /^(?:same|identical|identity|equal)(?:-\d+)?$/u.test(node.concept),
    ) ||
    query.edges.some((edge) => ['@same', ':same-as'].includes(edge.role))
  )
    return unchanged;
  const plans = [];
  for (const unknown of query.nodes.filter((node) => node.concept === 'amr-unknown')) {
    if (query.edges.some((edge) => edge.to === unknown.id && edge.role === ':polarity')) continue;
    const candidates = [];
    for (const connector of query.nodes.filter((node) => ['and', 'or'].includes(node.concept))) {
      const branches = query.edges.filter(
        (edge) => edge.from === connector.id && /^:op[1-9]\d*$/u.test(edge.role),
      );
      if (
        branches.length < 2 ||
        new Set(branches.map((edge) => edge.to)).size !== branches.length ||
        new Set(branches.map((edge) => edge.role)).size !== branches.length
      )
        continue;
      const owners = branches.map((branch) => {
        const reached = new Set([branch.to]);
        for (const id of reached)
          for (const edge of query.edges)
            if (edge.from === id && edge.to !== unknown.id) reached.add(edge.to);
        return reached;
      });
      if (owners.some((ids) => ids.has(connector.id) || ids.has(unknown.id))) continue;
      const ports = query.edges.filter((edge) => edge.to === unknown.id);
      const groups = branches.map(() => []);
      let ambiguous = false;
      for (const port of ports) {
        const indices = owners.flatMap((ids, index) => (ids.has(port.from) ? [index] : []));
        if (indices.length !== 1) ambiguous = true;
        else groups[indices[0]].push(port);
      }
      const used = groups.filter((group) => group.length);
      if (ambiguous || used.length < 2) continue;
      // Clone the entire descriptor closure, but never a branch or an externally
      // shared participant. Such a boundary would require another interpretation.
      const local = new Set([unknown.id]);
      for (const id of local)
        for (const edge of query.edges) if (edge.from === id) local.add(edge.to);
      if (
        [...local].some(
          (id) =>
            id === connector.id ||
            id === query.top ||
            id === query.assertionTop ||
            owners.some((ids) => ids.has(id)) ||
            (id !== unknown.id &&
              query.nodes.find((node) => node.id === id)?.concept === 'amr-unknown'),
        ) ||
        query.edges.some(
          (edge) => local.has(edge.to) && !local.has(edge.from) && !ports.includes(edge),
        )
      )
        continue;
      candidates.push({ local, groups: used });
    }
    // Nested or overlapping connector readings are outside this experiment.
    if (candidates.length > 1) return unchanged;
    if (candidates.length) plans.push(candidates[0]);
  }
  if (!plans.length) return unchanged;
  const claimed = new Set();
  for (const { local } of plans)
    for (const id of local) {
      if (claimed.has(id)) return unchanged;
      claimed.add(id);
    }
  const graph = structuredClone(query);
  const occupied = new Set([...query.nodes, ...query.edges].map((item) => item.id));
  const fresh = (id) => {
    let index = 1;
    while (occupied.has(`${id}/query-${index}`)) index++;
    const next = `${id}/query-${index}`;
    occupied.add(next);
    return next;
  };
  for (const { local, groups } of plans)
    for (const ports of groups.slice(1)) {
      const ids = new Map([...local].map((id) => [id, fresh(id)]));
      for (const node of query.nodes.filter((node) => local.has(node.id)))
        graph.nodes.push({ ...structuredClone(node), id: ids.get(node.id) });
      for (const edge of query.edges.filter((edge) => local.has(edge.from)))
        graph.edges.push({
          ...structuredClone(edge),
          id: fresh(edge.id),
          from: ids.get(edge.from),
          to: ids.get(edge.to),
        });
      for (const port of ports)
        graph.edges.find((edge) => edge.id === port.id).to = ids.get(port.to);
    }
  return {
    graph,
    reason:
      'Shared answer unknowns in explicit coordination were read as independent branch slots.',
  };
}

export function inquiryPattern(query, { composeClauses = false, descriptorFallback = false } = {}) {
  const variables = new Map(query.nodes.map((node, i) => [node.id, `?n${i}`]));
  const unknowns = query.nodes.filter((node) => node.concept === 'amr-unknown');
  const unknownIds = new Set(unknowns.map((node) => node.id));
  // A bare modifier unknown asks for a description of its participant. The
  // participant itself is the answer slot; the source may describe it through
  // :mod or through an equivalent nominal relation such as :ARG0-of.
  const descriptorParents = new Map();
  for (const node of unknowns) {
    const incoming = query.edges.filter((edge) => edge.to === node.id && edge.role !== ':polarity');
    const outgoing = query.edges.filter((edge) => edge.from === node.id);
    if (incoming.length === 1 && !outgoing.length && incoming[0].role === ':mod')
      descriptorParents.set(node.id, incoming[0].from);
  }
  const answerSlotIds = unknowns
    .filter((node) =>
      query.edges.some(
        (edge) => (edge.to === node.id && edge.role !== ':polarity') || edge.from === node.id,
      ),
    )
    .map((node) =>
      descriptorFallback && descriptorParents.has(node.id)
        ? descriptorParents.get(node.id)
        : node.id,
    );
  const decomposition = composeClauses
    ? clauseFragments(
        {
          ...query,
          nodes: query.nodes.filter(
            (node) =>
              node.id === claimRoot(query) ||
              !unknownIds.has(node.id) ||
              query.edges.some(
                (edge) =>
                  (edge.to === node.id && edge.role !== ':polarity') || edge.from === node.id,
              ),
          ),
          edges: query.edges.filter(
            (edge) => !(edge.role === ':polarity' && unknownIds.has(edge.to)),
          ),
        },
        { query: true },
      )
    : null;
  const connectors = new Set(
    decomposition?.projections.map((projection) => projection.parent) ?? [],
  );
  const claims = decomposition?.fragments
    .filter((fragment) => !connectors.has(fragment.root))
    .map((fragment) => fragment.root) ?? [claimRoot(query)];
  const assertions = claims.map((root, index) => ({
    root,
    variable: index ? `?assertion${index}` : '?assertion',
  }));
  const patterns = [
    ...assertions.map(({ root, variable }) => [variables.get(root), '@asserted', variable]),
    ...query.nodes
      .filter((node) => !unknownIds.has(node.id) && !connectors.has(node.id))
      .map((node) => [variables.get(node.id), ':instance', node.concept]),
    ...query.nodes
      .filter((node) => node.literal !== undefined)
      .map((node) => [variables.get(node.id), '@literal', node.literal]),
    ...unknowns.flatMap((node) =>
      (node.semanticTypes ?? []).map((type) => [variables.get(node.id), '@semanticType', type]),
    ),
    ...query.edges
      .filter(
        (edge) =>
          !connectors.has(edge.from) &&
          !(edge.role === ':polarity' && unknownIds.has(edge.to)) &&
          !(descriptorFallback && descriptorParents.has(edge.to) && edge.role === ':mod'),
      )
      .map((edge) => [variables.get(edge.from), edge.role, variables.get(edge.to)]),
  ];
  const booleanQuestion = !unknowns.some((node) =>
    query.edges.some(
      (edge) => (edge.to === node.id && edge.role !== ':polarity') || edge.from === node.id,
    ),
  );
  return {
    variables,
    unknowns,
    unknownIds,
    descriptorParents,
    answerSlotIds,
    patterns,
    booleanQuestion,
    assertions,
    decomposition,
    connectors,
  };
}

/** Fragments retain references to the full graph, its claim and qualifications. */
export function graphPatterns(graph) {
  const adjacent = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    adjacent.get(edge.from)?.push(edge);
    if (edge.to !== edge.from) adjacent.get(edge.to)?.push(edge);
  }
  const constrained = graph.nodes
    .filter((node) => /^(?:possible|recommend|obligate|say|report)-\d+$/u.test(node.concept))
    .map((node) => node.id);
  const guards = graph.edges
    .filter((edge) => [':polarity', ':condition', ':concession'].includes(edge.role))
    .map((edge) => edge.id);
  return graph.nodes
    .filter((node) => !node.id.startsWith('literal:'))
    .map((node) => ({
      anchor: node.id,
      concept: node.concept,
      edgeIds: adjacent.get(node.id).map((edge) => edge.id),
      claim: claimRoot(graph),
      ...(guards.length ? { guardEdges: guards } : {}),
      ...(constrained.length ? { contextNodes: constrained } : {}),
    }));
}
