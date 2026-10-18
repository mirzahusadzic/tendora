/** Derived, attributed case connections. These do not equate graph concepts or close obligations. */
import { acceptedCaseReference } from './interpretation.mjs';
import { graphRevision } from './revisions.mjs';
export function caseReference(ix, decisions = []) {
  const root = ix.nodes.get(ix.recording.caseState?.rootNodeId);
  if (!root) return null;
  const normalize = (value) => value.normalize('NFKC').trim().toLowerCase();
  const query = ix.graphs.get(ix.recording.inquiry.graphId);
  const selected =
    acceptedCaseReference(ix.baseIndex ?? ix, decisions) ?? ix.recording.caseState?.binding;
  if (selected) {
    const valid =
      query.nodes.some((node) => node.id === selected.queryNodeId) &&
      (!selected.graphDigest || selected.graphDigest === graphRevision(query));
    return {
      caseNodeId: root.id,
      queryNodeIds: valid ? [selected.queryNodeId] : [],
      status: valid ? 'bound' : 'unresolved',
      basis: 'participant',
      decisionId: selected.decisionId,
      sourceIds: [...root.sourceIds],
    };
  }
  if (ix.recording.version >= 2)
    return {
      caseNodeId: root.id,
      queryNodeIds: [],
      status: 'unresolved',
      basis: 'participant',
      sourceIds: [...root.sourceIds],
    };
  const candidates = query.nodes.filter(
    (node) => normalize(node.concept) === normalize(root.label),
  );
  return {
    caseNodeId: root.id,
    queryNodeIds: candidates.map((node) => node.id),
    status: candidates.length === 1 ? 'bound' : candidates.length ? 'ambiguous' : 'unresolved',
    basis: 'selected-case-label',
    sourceIds: [...root.sourceIds],
  };
}

export function caseSupport(ix, occurrence, comparison, decisions = []) {
  const reference = caseReference(ix, decisions);
  const result = { policy: 'case-argument-v2', reference, connections: [] };
  if (reference?.status !== 'bound' || !occurrence || !comparison?.complete) return result;
  result.connections = argumentConnections(
    ix,
    occurrence,
    comparison,
    reference,
    reference.queryNodeIds,
  );
  return result;
}

/** Inspection evidence requires selected sources, not a semantic reference decision.
 * Keep unmatched query endpoints open; retain the exact argument and edge witnesses.
 */
export function carriedSupport(ix, occurrence, comparison) {
  const root = ix.nodes.get(ix.recording.caseState?.rootNodeId);
  const query = ix.graphs.get(ix.recording.inquiry.graphId);
  const connections =
    root && occurrence && comparison?.complete
      ? argumentConnections(
          ix,
          occurrence,
          comparison,
          { caseNodeId: root.id, sourceIds: root.sourceIds },
          query.nodes.map((node) => node.id),
        )
      : [];
  const linked = new Set(
    connections
      .filter((item) => item.rootCase && item.status === 'linked')
      .map((item) => item.sourceEdgeId),
  ).size;
  return { policy: 'carried-argument-v1', connections, linked };
}

function argumentConnections(ix, occurrence, comparison, reference, queryNodeIds) {
  const result = { connections: [] };
  const query = ix.graphs.get(ix.recording.inquiry.graphId);
  const source = ix.sources.get(occurrence.sourceId),
    local = ix.graphs.get(source.graphId);
  const queryFocus = occurrence.requiredRefs[0]?.eventNode;
  // Follow only witnessed inquiry edges from this occurrence, never a second source event.
  const paths = new Map([[queryFocus, []]]),
    pending = [queryFocus];
  for (let i = 0; i < pending.length; i++) {
    const current = pending[i];
    for (const pair of comparison.shared) {
      const edge = pair.queryEdge;
      const next = edge.from === current ? edge.to : edge.to === current ? edge.from : null;
      if (next === null || paths.has(next)) continue;
      paths.set(next, [
        ...paths.get(current),
        { queryEdgeId: edge.id, sourceEdgeId: pair.sourceEdge.id },
      ]);
      pending.push(next);
    }
  }
  const rootPath = (graph, target) => {
    const paths = new Map([[graph.top, []]]),
      pending = [graph.top];
    for (let i = 0; i < pending.length; i++) {
      const current = pending[i];
      for (const edge of graph.edges.filter((edge) => edge.from === current)) {
        if (paths.has(edge.to)) continue;
        paths.set(edge.to, [...paths.get(current), edge.id]);
        pending.push(edge.to);
      }
    }
    return paths.get(target);
  };
  const polarities = (graph) =>
    graph.edges.filter((edge) => edge.role === ':polarity').map((edge) => edge.id);
  const negative = (graph) =>
    graph.edges.some(
      (edge) =>
        edge.role === ':polarity' &&
        graph.nodes.find((node) => node.id === edge.to)?.concept === '-',
    );
  for (const queryReference of queryNodeIds)
    for (const inquiryEdge of query.edges) {
      const outgoing = inquiryEdge.to === queryReference;
      if (!outgoing && inquiryEdge.from !== queryReference) continue;
      const governor = outgoing ? inquiryEdge.from : inquiryEdge.to;
      if (!paths.has(governor)) continue;
      const localGovernor = comparison.mapping.get(governor);
      for (const localEdge of local.edges.filter(
        (edge) =>
          edge.role === inquiryEdge.role && (outgoing ? edge.from : edge.to) === localGovernor,
      )) {
        const target = outgoing ? localEdge.to : localEdge.from;
        if (
          comparison.mapping.has(queryReference) &&
          comparison.mapping.get(queryReference) !== target
        )
          continue;
        for (const visit of ix.recording.visits.filter((item) =>
          occurrence.authored
            ? item.nodeId === occurrence.nodeId
            : item.occurrenceIds.includes(occurrence.id),
        )) {
          const ancestors = [],
            seen = new Set();
          for (
            let parent = ix.visits.get(visit.parentVisitId);
            parent && !seen.has(parent.id);
            parent = ix.visits.get(parent.parentVisitId)
          ) {
            seen.add(parent.id);
            ancestors.unshift(parent.nodeId);
          }
          if (
            ix.recording.caseState.policy === 'selected-context-v2' &&
            !ancestors.includes(reference.caseNodeId) &&
            visit.nodeId !== reference.caseNodeId
          )
            ancestors.unshift(reference.caseNodeId);
          const rootAt = ancestors.indexOf(reference.caseNodeId);
          if (rootAt < 0) continue;
          const contexts = new Map(
            ancestors
              .slice(rootAt)
              .flatMap((id, index) =>
                ix.nodes
                  .get(id)
                  .sourceIds.map((sourceId) => [
                    sourceId,
                    { nodeId: id, route: ancestors.slice(rootAt, rootAt + index + 1) },
                  ]),
              ),
          );
          for (const check of visit.contextChecks ?? []) {
            const context = contexts.get(check.inheritedSourceId);
            if (check.localSourceId !== source.id || !context) continue;
            const inherited = ix.sources.get(check.inheritedSourceId),
              carried = ix.graphs.get(inherited.graphId);
            if (!carried) continue;
            for (const anchor of check.anchors) {
              const rootCase = reference.sourceIds.includes(inherited.id);
              const scopePath = rootPath(carried, anchor.fromEvent);
              if (
                !anchor.complete ||
                anchor.sourceEvent !== target ||
                !scopePath ||
                (rootCase && scopePath.length)
              )
                continue;
              const witnesses = anchor.shared.filter((pair) => {
                const edge = local.edges.find((edge) => edge.id === pair.sourceEdgeId);
                return edge && (edge.from === target || edge.to === target);
              });
              if (!witnesses.length) continue;
              const status =
                negative(carried) || negative(local) || negative(query)
                  ? 'polarity'
                  : scopePath.length
                    ? 'scoped'
                    : 'linked';
              const connection = {
                status,
                contextNodeId: context.nodeId,
                contextRoute: context.route,
                scopePath,
                rootCase,
                caseNodeId: reference.caseNodeId,
                queryNodeId: queryReference,
                queryEdgeId: inquiryEdge.id,
                sourceId: source.id,
                sourceEdgeId: localEdge.id,
                sourceNodeId: target,
                inheritedSourceId: inherited.id,
                visitId: visit.id,
                path: paths.get(governor),
                witnesses,
                queryOpenEdgeIds: comparison.queryOnly.map((edge) => edge.id),
                sourceRemainder: local.edges
                  .filter(
                    (edge) =>
                      edge.id !== localEdge.id &&
                      !witnesses.some((pair) => pair.sourceEdgeId === edge.id),
                  )
                  .map((edge) => edge.id),
                carriedRemainder: carried.edges
                  .filter((edge) => !witnesses.some((pair) => pair.fromEdgeId === edge.id))
                  .map((edge) => edge.id),
                polarities: {
                  query: polarities(query),
                  source: polarities(local),
                  carried: polarities(carried),
                },
              };
              if (
                !result.connections.some(
                  (item) =>
                    item.queryEdgeId === connection.queryEdgeId &&
                    item.sourceEdgeId === connection.sourceEdgeId &&
                    item.inheritedSourceId === connection.inheritedSourceId &&
                    item.visitId === connection.visitId,
                )
              )
                result.connections.push(connection);
            }
          }
        }
      }
    }
  // Inherited evidence extends an established root-case connection on the same argument.
  result.connections = result.connections.filter(
    (item, _, all) =>
      item.rootCase ||
      all.some(
        (root) =>
          root.rootCase &&
          root.status === 'linked' &&
          root.queryEdgeId === item.queryEdgeId &&
          root.sourceEdgeId === item.sourceEdgeId &&
          root.sourceId === item.sourceId &&
          root.visitId === item.visitId,
      ),
  );
  return result.connections;
}

/** One classification for summaries, evidence views and continuation choices. */
export function assessCaseRelations(query, comparison, support) {
  const matched = new Set(comparison?.shared.map((pair) => pair.queryEdge.id) ?? []);
  const relations = query.edges
    .filter(
      (edge) =>
        !(
          edge.role === ':polarity' &&
          query.nodes.find((node) => node.id === edge.to)?.concept === 'amr-unknown'
        ),
    )
    .map((edge) => {
      const connections = support?.connections.filter((item) => item.queryEdgeId === edge.id) ?? [];
      const supported = connections.some((item) => item.rootCase && item.status === 'linked');
      const status = matched.has(edge.id)
        ? 'matched'
        : supported
          ? 'case-supported'
          : !comparison
            ? 'not compared'
            : comparison.complete
              ? 'open'
              : 'unresolved';
      return {
        edge,
        status,
        scoped: connections.some((item) => item.scopePath.length),
        connections,
      };
    });
  return {
    relations,
    matched: relations.filter((item) => item.status === 'matched').length,
    caseSupported: relations.filter((item) => item.status === 'case-supported').length,
    unsupported: relations.filter((item) => !['matched', 'case-supported'].includes(item.status))
      .length,
  };
}
