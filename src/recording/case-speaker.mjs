/** First-person deixis inside one selected case. Never merge events or corpus voices. */
import { claimRoot } from '../amr/patterns.mjs';

export function caseSpeakerBinding(recording, sourceGraphs, sources) {
  const root = recording.caseState?.rootNodeId;
  if (!root) return [];
  const references = [];
  for (const entry of sourceGraphs) {
    const source = sources.find((source) => source.id === entry.sourceId);
    if (source?.nodeId !== root) continue;
    if (/["“”]/u.test(source.text) || /^\s*['‘>]/u.test(source.text)) continue;
    const { graph, revision } = entry;
    // Quoted/reported voices require an explicit reference decision. Walking
    // argument edges only also avoids inheriting a speaker from an inverse clause.
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const reached = new Set(),
      pending = [claimRoot(graph)];
    for (const id of pending) {
      if (reached.has(id)) continue;
      reached.add(id);
      if (/^(?:say|tell|report|quote|think|believe)-\d+$/u.test(nodes.get(id)?.concept ?? ''))
        continue;
      for (const edge of graph.edges.filter(
        (edge) => edge.from === id && /^:(?:ARG\d+|poss|op\d+)$/u.test(edge.role),
      ))
        pending.push(edge.to);
    }
    const speakers = graph.nodes.filter((node) => node.concept === 'i' && reached.has(node.id));
    // Multiple first-person nodes in one source need disambiguation.
    if (speakers.length !== 1) continue;
    references.push({
      text: source.text,
      nodeId: source.nodeId,
      sourceNodeId: speakers[0].id,
      graphRevision: revision,
    });
  }
  if (references.length < 2) return [];
  return [
    {
      id: `${root}/case-speaker-v1`,
      name: 'Selected case speaker',
      attribution:
        'Unquoted first-person references in the selected case refer to its speaker; other cases and corpus voices remain separate.',
      scopePlacementId: recording.project?.placementId,
      references,
    },
  ];
}
