/** Read an attributed AMR as a small, rooted relation graph.
 * eGemma's triples already turn PENMAN `:ARG1-of` into its directed edge.
 * We keep edge names and directions; no English word list decides a match.
 */

export function readGraph(candidate) {
  if (candidate.decode_status !== 'ok' || !candidate.top || !Array.isArray(candidate.triples))
    return null;
  const concepts = new Map(
    candidate.triples
      .filter((triple) => triple.relation === ':instance')
      .map((triple) => [triple.source, triple.target]),
  );
  if (!concepts.has(candidate.top)) return null;
  return {
    top: candidate.top,
    concepts,
    edges: candidate.triples.filter((triple) => triple.relation !== ':instance'),
    penman: candidate.penman,
  };
}

// The service's triples already normalize PENMAN inverse (:ARG0-of) edges.
export function graphView(parsed) {
  const graph = readGraph(parsed);
  if (!graph) return null;
  const labels = new Map(graph.concepts);
  const edges = graph.edges.map((edge, i) => {
    const target = edge.target_kind === 'node' ? edge.target : `literal:${i}`;
    if (edge.target_kind !== 'node') labels.set(target, edge.target.replace(/^"|"$/gu, ''));
    return { id: `e${i}`, from: edge.source, to: target, role: edge.relation };
  });
  const adjacent = new Map([...labels.keys()].map((id) => [id, []]));
  for (const edge of edges) {
    adjacent.get(edge.from)?.push({ to: edge.to, role: edge.role, forward: true });
    adjacent.get(edge.to)?.push({ to: edge.from, role: edge.role, forward: false });
  }
  return { top: graph.top, labels, edges, adjacent };
}

export function focus(graph) {
  const unknown =
    graph.edges.find(
      (edge) => graph.labels.get(edge.to) === 'amr-unknown' && edge.role !== ':polarity',
    ) ?? graph.edges.find((edge) => graph.labels.get(edge.to) === 'amr-unknown');
  return unknown?.from ?? graph.top;
}
