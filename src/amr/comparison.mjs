/** Display-only constrained overlap. Never supplies evidence to the crossing engine. */
export function compareGraphs(
  query,
  source,
  {
    queryEvent,
    sourceEvent,
    binding = null,
    correspondence = null,
    correspondences = [],
    searchLimit = 50000,
  } = {},
) {
  const q = new Map(query.nodes.map((n) => [n.id, n.concept]));
  const s = new Map(source.nodes.map((n) => [n.id, n.concept]));
  const pins = new Map([[queryEvent, sourceEvent]]);
  if (!q.has(queryEvent) || q.get(queryEvent) !== s.get(sourceEvent))
    throw new Error('Comparison requires the same event concept');
  if (binding) {
    if (
      q.get(binding.queryNodeId) !== 'amr-unknown' ||
      !s.has(binding.sourceNodeId) ||
      binding.sourceNodeId === sourceEvent
    )
      throw new Error('Invalid comparison binding');
    pins.set(binding.queryNodeId, binding.sourceNodeId);
  }
  for (const item of [...correspondences, ...(correspondence ? [correspondence] : [])]) {
    const { queryNodeId, sourceNodeId, queryConcept, sourceConcept } = item;
    if (
      !q.has(queryNodeId) ||
      !s.has(sourceNodeId) ||
      q.get(queryNodeId) !== queryConcept ||
      s.get(sourceNodeId) !== sourceConcept ||
      pins.has(queryNodeId) ||
      [...pins.values()].includes(sourceNodeId)
    )
      throw new Error('Invalid local concept correspondence');
    pins.set(queryNodeId, sourceNodeId);
  }
  const candidates = new Map(
    query.nodes.map((node) => [
      node.id,
      pins.has(node.id)
        ? [pins.get(node.id)]
        : source.nodes
            .filter(
              (other) => other.concept === node.concept && ![...pins.values()].includes(other.id),
            )
            .map((other) => other.id),
    ]),
  );
  const key = (from, role, to) => JSON.stringify([from, role, to]);
  const edges = new Map(source.edges.map((edge) => [key(edge.from, edge.role, edge.to), edge]));
  const matches = (mapping) =>
    query.edges.flatMap((edge) => {
      const other = edges.get(key(mapping.get(edge.from), edge.role, mapping.get(edge.to)));
      return other ? [{ queryEdge: edge, sourceEdge: other }] : [];
    });
  // Start with a feasible mapping; exhaustive search below certifies the optimum
  // within our exact-concept constraints, or explicitly reports its work limit.
  let mapping = new Map(pins);
  for (const [id, choices] of candidates) {
    if (pins.has(id)) continue;
    const available = choices.find((choice) => ![...mapping.values()].includes(choice));
    if (available !== undefined) mapping.set(id, available);
  }
  let score = matches(mapping).length,
    examined = 0,
    complete = true;
  const fixed = new Map(pins);
  for (const [id, choices] of candidates) {
    if (pins.has(id)) continue;
    // A unique, uncontested exact match cannot reduce overlap.
    if (
      choices.length === 1 &&
      [...candidates].filter(([, list]) => list.includes(choices[0])).length === 1
    )
      fixed.set(id, choices[0]);
    else if (!choices.length) fixed.set(id, null);
  }
  const variables = [...candidates]
    .filter(([id]) => !fixed.has(id))
    .sort((a, b) => a[1].length - b[1].length);
  const possible = (partial) =>
    query.edges.filter((edge) =>
      source.edges.some(
        (other) =>
          other.role === edge.role &&
          (partial.has(edge.from)
            ? partial.get(edge.from) === other.from
            : candidates.get(edge.from).includes(other.from)) &&
          (partial.has(edge.to)
            ? partial.get(edge.to) === other.to
            : candidates.get(edge.to).includes(other.to)),
      ),
    ).length;
  function search(at, partial, used) {
    if (++examined > searchLimit) {
      complete = false;
      return;
    }
    if (possible(partial) <= score) return;
    if (at === variables.length) {
      score = matches(partial).length;
      mapping = new Map(partial);
      return;
    }
    const [id, choices] = variables[at];
    for (const choice of [...choices.filter((item) => !used.has(item)), null]) {
      partial.set(id, choice);
      if (choice !== null) used.add(choice);
      search(at + 1, partial, used);
      if (choice !== null) used.delete(choice);
      if (!complete) break;
    }
    partial.delete(id);
  }
  search(0, new Map(fixed), new Set([...fixed.values()].filter((id) => id !== null)));
  const shared = matches(mapping);
  const queryMatched = new Set(shared.map((item) => item.queryEdge.id));
  const sourceMatched = new Set(shared.map((item) => item.sourceEdge.id));
  return {
    mapping,
    shared,
    complete,
    examined,
    queryOnly: query.edges.filter((edge) => !queryMatched.has(edge.id)),
    sourceOnly: source.edges.filter((edge) => !sourceMatched.has(edge.id)),
  };
}
