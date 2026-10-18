/** Offline role canonicalization, checked against the pinned PENMAN 1.3.1 AMR model. */
const lexicalOf = new Set([':consist-of', ':prep-on-behalf-of', ':prep-out-of']);
const inverted = (role) => role.endsWith('-of') && !lexicalOf.has(role);
const aliases = { ':mod-of': ':domain', ':domain-of': ':mod' };

export function canonicalRelation([from, role, to]) {
  if (!role.startsWith(':')) return [from, role, to];
  while (inverted(role) && inverted(role.slice(0, -3))) role = role.slice(0, -6);
  role = aliases[role] ?? role;
  return inverted(role) ? [to, role.slice(0, -3), from] : [from, role, to];
}

export function canonicalGraph(graph) {
  let changed = false;
  const edges = graph.edges.map((edge) => {
    const [from, role, to] = canonicalRelation([edge.from, edge.role, edge.to]);
    if (from === edge.from && role === edge.role && to === edge.to) return edge;
    changed = true;
    return { ...edge, from, role, to };
  });
  return changed ? { ...graph, edges } : graph;
}
