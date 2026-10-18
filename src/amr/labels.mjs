/** Surface labels for display only; predicate concepts and roles remain unchanged. */
export function labelReading(graph, text, checks = []) {
  const lexical = new Map(checks.filter((c) => c.evidence).map((c) => [c.nodeId, c.evidence]));
  const labels = new Map();
  for (const node of graph.nodes) {
    const name = graph.edges.find((e) => e.from === node.id && e.role === ':name');
    const parts =
      name &&
      graph.edges
        .filter((e) => e.from === name.to && /^:op\d+$/u.test(e.role))
        .sort((a, b) => Number(a.role.slice(3)) - Number(b.role.slice(3)))
        .map((e) => graph.nodes.find((n) => n.id === e.to)?.literal?.replace(/^"|"$/gu, ''))
        .filter(Boolean);
    if (parts?.length) labels.set(node.id, parts.join(' '));
    else if (lexical.has(node.id)) labels.set(node.id, lexical.get(node.id).text);
    else {
      const words = text.match(/[\p{L}][\p{L}'-]*/gu) ?? [];
      const word = words.find(
        (w) =>
          w.toLowerCase() === node.concept ||
          w.toLowerCase() === node.concept + 's' ||
          w.toLowerCase() + 's' === node.concept,
      );
      if (word) labels.set(node.id, word);
      else {
        const descriptors = graph.edges
          .filter((e) => e.to === node.id && /^:ARG[01]$/u.test(e.role))
          .map((e) => lexical.get(e.from))
          .filter((e) => e && e.method !== 'surface');
        if (descriptors.length === 1) labels.set(node.id, descriptors[0].text);
      }
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      labels.has(n.id) ? { ...n, surfaceLabel: labels.get(n.id) } : n,
    ),
  };
}
