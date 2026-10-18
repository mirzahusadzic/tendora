/** Explicit graph edits over a preserved parser graph. No domain vocabulary. */
export function validateGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
    throw new Error('Invalid graph');
  const nodes = new Set(),
    edges = new Set();
  for (const node of graph.nodes) {
    if (
      typeof node.id !== 'string' ||
      !node.id ||
      nodes.has(node.id) ||
      typeof node.concept !== 'string' ||
      !node.concept.trim()
    )
      throw new Error('Invalid graph node');
    nodes.add(node.id);
  }
  if (!nodes.has(graph.top)) throw new Error('Graph root required');
  if (graph.assertionTop !== undefined && !nodes.has(graph.assertionTop))
    throw new Error('Graph claim anchor required');
  for (const edge of graph.edges) {
    if (
      typeof edge.id !== 'string' ||
      !edge.id ||
      edges.has(edge.id) ||
      !nodes.has(edge.from) ||
      !nodes.has(edge.to) ||
      typeof edge.role !== 'string' ||
      !/^:[\w-]+$/u.test(edge.role)
    )
      throw new Error('Invalid graph edge');
    edges.add(edge.id);
  }
  const seen = new Set([graph.top]),
    pending = [graph.top];
  for (let i = 0; i < pending.length; i++)
    for (const edge of graph.edges) {
      const next = edge.from === pending[i] ? edge.to : edge.to === pending[i] ? edge.from : null;
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  if (seen.size !== nodes.size) throw new Error('Disconnected graph');
  return graph;
}
export function reviseGraph(original, edits = [], validate = true) {
  const graph = structuredClone(original);
  for (const edit of edits) {
    if (edit.kind === 'node') {
      const node = graph.nodes.find((item) => item.id === edit.id);
      if (!node) throw new Error('Node unavailable');
      node.concept = edit.concept;
    } else if (edit.kind === 'edge') {
      const edge = graph.edges.find((item) => item.id === edit.id);
      if (!edge) throw new Error('Edge unavailable');
      Object.assign(edge, { from: edit.from, role: edit.role, to: edit.to });
    } else if (edit.kind === 'add-node') graph.nodes.push({ id: edit.id, concept: edit.concept });
    else if (edit.kind === 'add-edge')
      graph.edges.push({ id: edit.id, from: edit.from, role: edit.role, to: edit.to });
    else if (edit.kind === 'remove-edge')
      graph.edges = graph.edges.filter((item) => item.id !== edit.id);
    else if (edit.kind === 'remove-node') {
      graph.nodes = graph.nodes.filter((item) => item.id !== edit.id);
      graph.edges = graph.edges.filter((item) => item.from !== edit.id && item.to !== edit.id);
    } else if (edit.kind === 'top') {
      graph.top = edit.id;
      if (graph.assertionTop !== undefined) graph.assertionTop = edit.id;
    } else throw new Error('Invalid graph edit');
  }
  return validate ? validateGraph(graph) : graph;
}

/** Detach one incoming reference while retaining the selected node's qualifications. */
export function splitNodeEdits(graph, edgeId, nodeId) {
  const edge = graph.edges.find((item) => item.id === edgeId);
  const target = graph.nodes.find((item) => item.id === edge?.to);
  if (
    !edge ||
    !target ||
    graph.nodes.some((item) => item.id === nodeId) ||
    graph.edges.filter((item) => item.to === target.id).length < 2
  )
    throw new Error('Shared node required');
  return [
    { kind: 'add-node', id: nodeId, concept: target.concept },
    ...graph.edges
      .filter((item) => item.from === target.id)
      .map((item, i) => ({
        kind: 'add-edge',
        id: `${nodeId}-e${i}`,
        from: nodeId,
        role: item.role,
        to: item.to === target.id ? nodeId : item.to,
      })),
    { kind: 'edge', id: edge.id, from: edge.from, role: edge.role, to: nodeId },
  ];
}
