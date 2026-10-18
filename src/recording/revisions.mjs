/** Stable revision identities for immutable recordings and effective graphs. */
import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const interpretationRevision = (recording) => digest(recording);
export const graphRevision = (graph) =>
  digest({
    top: graph.top,
    nodes: graph.nodes,
    edges: graph.edges,
    ...(graph.assertionTop !== undefined ? { assertionTop: graph.assertionTop } : {}),
  });
