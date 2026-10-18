/** Select ancestor/local source pairs and retain attribution on their AMR checks. */
import { compareContextEvents } from '../amr/context-comparison.mjs';

export function examineContext(context, sources, localNodeId = null) {
  const checks = [];
  for (let entry = context; entry; entry = entry.previous) {
    if (entry.nodeId === localNodeId) continue;
    for (const [fromSourceIndex, inherited] of entry.sources.entries()) {
      for (const [sourceIndex, local] of sources.entries()) {
        const anchors =
          inherited.graph && local.graph ? compareContextEvents(inherited.graph, local.graph) : [];
        checks.push({
          fromNodeId: entry.nodeId,
          fromSourceIndex,
          sourceIndex,
          status: !inherited.graph || !local.graph ? 'parse-unavailable' : 'examined',
          anchors,
        });
      }
    }
  }
  return checks;
}
