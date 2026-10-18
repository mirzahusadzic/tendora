/** Controlled graph-to-text projection; every node and edge must be expressed. */
import { claimRoot } from './patterns.mjs';
import { validateGraph } from './revision.mjs';

export function realizeGraph(graph, surface) {
  validateGraph(graph);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const coveredNodes = new Set(),
    coveredEdges = new Set(),
    active = new Set();
  function render(id) {
    const node = nodes.get(id),
      edges = graph.edges.filter((edge) => edge.from === id);
    if (active.has(id)) throw new Error('Surface requires a reference expression');
    active.add(id);
    coveredNodes.add(id);
    let text;
    if (node.literal !== undefined && !edges.length) {
      try {
        text = JSON.parse(node.literal);
      } catch {
        text = node.literal;
      }
      text = String(text);
    } else if (
      node.concept === 'name' &&
      edges.length &&
      edges.every((edge) => /^:op\d+$/u.test(edge.role))
    ) {
      text = edges
        .sort((a, b) => Number(a.role.slice(3)) - Number(b.role.slice(3)))
        .map((edge) => {
          coveredEdges.add(edge.id);
          return render(edge.to);
        })
        .join(' ');
    } else {
      const entry = surface[node.concept];
      if (
        !entry ||
        edges.length !== entry.roles.length ||
        entry.roles.some((role) => edges.filter((edge) => edge.role === role).length !== 1)
      )
        throw new Error(`No complete surface for ${node.concept}`);
      const parts = entry.roles.map((role) => {
        const edge = edges.find((edge) => edge.role === role);
        coveredEdges.add(edge.id);
        return render(edge.to);
      });
      const slots = [...entry.template.matchAll(/\{(\d+)\}/gu)].map((match) => Number(match[1]));
      if (
        parts.some((_, index) => !slots.includes(index)) ||
        slots.some((index) => index >= parts.length)
      )
        throw new Error('Surface drops a role');
      text = entry.template.replace(/\{(\d+)\}/gu, (_, index) => parts[Number(index)]);
    }
    active.delete(id);
    return text;
  }
  const text = render(claimRoot(graph));
  if (coveredNodes.size !== graph.nodes.length || coveredEdges.size !== graph.edges.length)
    throw new Error('Surface omits graph content');
  return {
    text: text[0].toUpperCase() + text.slice(1) + '.',
    nodes: [...coveredNodes],
    edges: [...coveredEdges],
  };
}
