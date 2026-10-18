/** Recover literal tokens retained in the attributed parser response. */
export function graphLiterals(graph, response) {
  const edges = response?.triples?.filter((triple) => triple.relation !== ':instance') ?? [];
  return new Map(
    graph.nodes.flatMap((node) => {
      if (node.literal !== undefined) return [[node.id, node.literal]];
      if (!node.id.startsWith('literal:')) return [];
      const edge = edges[Number(node.id.slice('literal:'.length))];
      if (!edge || edge.target_kind === 'node') return [];
      let value = edge.target;
      if (value.startsWith('"')) {
        try {
          value = JSON.parse(value);
        } catch {
          return [];
        }
      }
      // Older recordings kept escaped string content as the display concept.
      if (value !== node.concept && edge.target.replace(/^"|"$/gu, '') !== node.concept) return [];
      return [[node.id, edge.target]];
    }),
  );
}
