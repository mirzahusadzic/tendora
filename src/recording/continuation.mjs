import { caseSupport, assessCaseRelations } from './case-support.mjs';
/** Attributed continuation context. Saved comparisons remain immutable. */
import { compareGraphs } from '../amr/comparison.mjs';
import { interpretationEdge } from '../amr/interpretation.mjs';
import { reviseGraph } from '../amr/revision.mjs';
import { acceptedInterpretation, interpretedIndex } from './interpretation.mjs';
import { interpretationRevision, graphRevision } from './revisions.mjs';
import {
  createFrameCarry,
  createInquiryFrame,
  validateFrameCarry,
  validateInquiryFrame,
} from './frame.mjs';

/** Openings may originate in either graph or in a source without an occurrence. */
export function evidenceOpenings(ix, selection, decisions = []) {
  const occurrence = ix.occurrences.get(selection?.occurrenceId);
  const result = occurrence
    ? continuationOpenings(ix, occurrence, decisions).map((item) => ({
        ...item,
        id: `query:${item.edge.id}`,
        kind: 'query',
        sourceId: occurrence.sourceId,
      }))
    : [];
  const accepted = occurrence && acceptedInterpretation(ix, occurrence, decisions);
  const effective = interpretedIndex(ix, occurrence, accepted);
  const sources = occurrence
    ? [occurrence.sourceId]
    : (ix.nodes.get(selection?.nodeId)?.sourceIds ?? []);
  for (const sourceId of sources) {
    const source = ix.sources.get(sourceId);
    const authored = acceptedInterpretation(ix, occurrence ?? { id: null, sourceId }, decisions);
    const graph = authored?.review.source ?? effective.graphs.get(source.graphId);
    result.push({
      id: `source:${sourceId}`,
      kind: graph ? 'source' : 'parse',
      sourceId,
      label: source.text,
    });
    for (const edge of graph?.edges ?? [])
      result.push({
        id: `source:${sourceId}:${edge.id}`,
        kind: 'source-edge',
        sourceId,
        edge,
        graphId: graph.id,
        label: interpretationEdge(graph, edge),
      });
  }
  return result;
}
function recordingFrame(ix, query) {
  const project = ix.recording.project;
  return createInquiryFrame({
    projectId: project.id,
    projectRevision: project.digest,
    question: ix.recording.inquiry.text,
    questionRevision: graphRevision(query),
    intention: ix.recording.ask?.intention ?? null,
    scope: {
      placementId: project.placementId,
      label:
        ix.nodes.get(project.placementId)?.label ??
        ix.nodes.get(project.placementId)?.concept ??
        project.placementId,
    },
    caseSelection: ix.recording.caseState?.selection ?? null,
    sources: ix.recording.sources.map((source) => ({
      id: source.id,
      nodeId: source.nodeId,
      sentenceId: source.sentenceId,
      revision: source.revision,
      graphRevision: ix.graphs.get(source.graphId)
        ? graphRevision(ix.graphs.get(source.graphId))
        : null,
      textDigest: ix.recording.amrs.find((amr) => amr.graphId === source.graphId)?.textDigest,
      text: source.text,
    })),
  });
}

export function authoredContinuation(
  ix,
  selection,
  path,
  opening = null,
  decisions = [],
  { action, rationale } = {},
) {
  if (!ix.recording.project) throw new Error('Project required');
  const occurrence = ix.occurrences.get(selection?.occurrenceId),
    source = ix.sources.get(opening?.sourceId ?? occurrence?.sourceId);
  const accepted = acceptedInterpretation(
    ix,
    occurrence ?? (source ? { id: null, sourceId: source.id } : null),
    decisions,
  );
  const query = accepted?.review.query ?? ix.graphs.get(ix.recording.inquiry.graphId);
  const originFrame = recordingFrame(ix, query);
  const receivingFrame = createInquiryFrame({
    projectId: originFrame.project.id,
    projectRevision: originFrame.project.revision,
    question: '',
    questionRevision: null,
    intention: originFrame.intention,
    scope: originFrame.scope,
    caseSelection: originFrame.case,
    sources: originFrame.sources,
  });
  const carryAction = action ?? (opening ? 'continue-opening' : 'revise-question');
  const carryRationale =
    rationale ??
    (opening
      ? 'Continue from this unresolved connection.'
      : 'Revise the retained question and its frame.');
  const carry = createFrameCarry({
    origin: originFrame,
    receiving: receivingFrame,
    opening,
    action: carryAction,
    rationale: carryRationale,
    actor: 'participant',
    originRecording: { path, revision: interpretationRevision(ix.recording) },
    status: 'pending',
    support: 'recheck',
    reason: 'The receiving inquiry has not been checked yet.',
  });
  return {
    schema: 'tendora.continuation',
    version: 3,
    author: 'participant',
    contextUse: 'review-only',
    question: ix.recording.inquiry.text,
    scopePlacementId: ix.recording.project.placementId,
    action: carryAction,
    rationale: carryRationale,
    originFrame,
    frame: receivingFrame,
    carry,
    parent: {
      path,
      revision: interpretationRevision(ix.recording),
      project: structuredClone(ix.recording.project),
      question: ix.recording.inquiry.text,
      nodeId: selection.nodeId,
      occurrenceId: occurrence?.id ?? null,
      ...(source
        ? {
            source: structuredClone(source),
            sourceGraph: structuredClone(ix.graphs.get(source.graphId) ?? null),
          }
        : {}),
      queryGraph: structuredClone(ix.graphs.get(ix.recording.inquiry.graphId)),
    },
    opening: structuredClone(
      opening ?? { id: 'question', kind: 'question', label: ix.recording.inquiry.text },
    ),
    ...(accepted?.review.query
      ? { interpretedGraphs: { query: accepted.review.query, source: accepted.review.source } }
      : {}),
    assumption: accepted ? { proposal: accepted.proposal, decisionId: accepted.decisionId } : null,
    history: [
      ...continuationHistory(ix.recording.continuation),
      {
        question: ix.recording.inquiry.text,
        path,
        revision: interpretationRevision(ix.recording),
        scopePlacementId: ix.recording.project.placementId,
        scopeLabel:
          ix.nodes.get(ix.recording.project.placementId)?.label ?? ix.recording.project.placementId,
        purpose: originFrame.intention?.text ?? '',
        frameRevision: originFrame.id,
      },
    ],
  };
}

export function continuationOpenings(ix, occurrence, decisions = []) {
  if (!occurrence) return [];
  const accepted = acceptedInterpretation(ix, occurrence, decisions);
  const query = accepted?.review.query ?? ix.graphs.get(ix.recording.inquiry.graphId);
  const source = ix.sources.get(occurrence.sourceId);
  const comparison =
    accepted?.review.after ??
    compareGraphs(query, ix.graphs.get(source.graphId), {
      queryEvent: occurrence.requiredRefs[0]?.eventNode,
      sourceEvent: occurrence.sourceEventNodeId,
      binding: occurrence.bindings?.length === 1 ? occurrence.bindings[0] : null,
    });
  const assessment = assessCaseRelations(
    query,
    comparison,
    caseSupport(interpretedIndex(ix, occurrence, accepted), occurrence, comparison, decisions),
  );
  return assessment.relations
    .filter((item) => item.status !== 'matched')
    .sort((a, b) => Number(a.status === 'case-supported') - Number(b.status === 'case-supported'))
    .map((item) => ({
      edge: item.edge,
      label: interpretationEdge(query, item.edge),
      status: item.status,
      scoped: item.scoped,
    }));
}

export function continuationContext(ix, occurrence, decisions, path, index) {
  const opening = continuationOpenings(ix, occurrence, decisions)[index];
  if (!opening) throw new Error('Select a remaining inquiry relation first.');
  if (!ix.recording.project) throw new Error('Continuation requires a project recording.');
  const accepted = acceptedInterpretation(ix, occurrence, decisions);
  const source = ix.sources.get(occurrence.sourceId);
  const query = accepted?.review.query ?? ix.graphs.get(ix.recording.inquiry.graphId);
  const sourceGraph = ix.graphs.get(source.graphId);
  const comparison =
    accepted?.review.after ??
    compareGraphs(query, sourceGraph, {
      queryEvent: occurrence.requiredRefs[0]?.eventNode,
      sourceEvent: occurrence.sourceEventNodeId,
      binding: occurrence.bindings?.length === 1 ? occurrence.bindings[0] : null,
    });
  const support = caseSupport(
    interpretedIndex(ix, occurrence, accepted),
    occurrence,
    comparison,
    decisions,
  );
  const connections = support.connections.filter((item) => item.queryEdgeId === opening.edge.id);
  const queryEdges = query.edges.filter(
    (edge) =>
      !(
        edge.role === ':polarity' &&
        query.nodes.find((node) => node.id === edge.to)?.concept === 'amr-unknown'
      ),
  );
  const caseEvidence = connections.length
    ? {
        policy: support.policy,
        reference: structuredClone(support.reference),
        ref: `Q${queryEdges.findIndex((edge) => edge.id === opening.edge.id) + 1}`,
        connections: structuredClone(connections),
        contexts: [...new Set(connections.map((item) => item.inheritedSourceId))].map((id) => {
          const inherited = ix.sources.get(id),
            connection = connections.find((item) => item.inheritedSourceId === id);
          return {
            nodeId: connection.contextNodeId,
            route: connection.contextRoute.map((nodeId) => ({
              nodeId,
              label: ix.nodes.get(nodeId).label,
            })),
            source: structuredClone(inherited),
            graph: structuredClone(ix.graphs.get(inherited.graphId)),
          };
        }),
      }
    : null;
  const route = [];
  const visit = ix.recording.visits.find((item) => item.occurrenceIds.includes(occurrence.id));
  for (let current = visit; current; current = ix.visits.get(current.parentVisitId))
    route.unshift({ nodeId: current.nodeId, label: ix.nodes.get(current.nodeId).label });
  const history = [
    ...continuationHistory(ix.recording.continuation),
    {
      question: ix.recording.inquiry.text,
      path,
      revision: interpretationRevision(ix.recording),
      scopePlacementId: ix.recording.project.placementId,
      scopeLabel: ix.nodes.get(ix.recording.project.placementId)?.label ?? 'Recorded scope',
    },
  ];
  return {
    schema: 'tendora.continuation',
    version: 1,
    history,
    parent: {
      path,
      revision: interpretationRevision(ix.recording),
      project: ix.recording.project,
      question: ix.recording.inquiry.text,
      nodeId: occurrence.nodeId,
      occurrenceId: occurrence.id,
      route,
      source: structuredClone(source),
      queryGraph: structuredClone(ix.graphs.get(ix.recording.inquiry.graphId)),
      sourceGraph: structuredClone(ix.graphs.get(source.graphId)),
    },
    opening: structuredClone(opening),
    ...(caseEvidence ? { caseEvidence } : {}),
    assumption: accepted ? { proposal: accepted.proposal, decisionId: accepted.decisionId } : null,
    contextUse: 'review-only',
    author: 'participant',
  };
}

/** Earlier captures may predate the explicit question history. */
export function continuationHistory(context) {
  if (!context) return [];
  return (
    context.history ?? [
      {
        question: context.parent.question,
        path: context.parent.path,
        revision: context.parent.revision,
        scopePlacementId: context.parent.project.placementId,
        scopeLabel: context.parent.route?.[0]?.label ?? 'Recorded scope',
      },
    ]
  );
}

export function validateContinuation(context) {
  const text = (value) => typeof value === 'string' && value.length > 0;
  const parent = context?.parent,
    edge = context?.opening?.edge;
  if (context?.version === 3) {
    validateInquiryFrame(context.originFrame);
    validateInquiryFrame(context.frame);
    validateFrameCarry(context.carry);
    if (
      context.schema !== 'tendora.continuation' ||
      context.author !== 'participant' ||
      context.contextUse !== 'review-only' ||
      !text(context.question) ||
      !text(context.scopePlacementId) ||
      !text(context.action) ||
      !text(context.rationale) ||
      !text(parent?.path) ||
      !text(parent?.revision) ||
      !text(parent?.project?.id) ||
      !text(parent?.question) ||
      !text(parent?.nodeId) ||
      !text(parent?.project?.path) ||
      !text(parent?.project?.placementId) ||
      !text(context.opening?.id) ||
      !['query', 'source', 'source-edge', 'parse', 'question'].includes(context.opening.kind) ||
      !text(context.opening?.label) ||
      !Array.isArray(context.history) ||
      !context.history.length ||
      context.history.at(-1).revision !== parent.revision ||
      context.history.at(-1).question !== parent.question ||
      context.originFrame.question.text !== parent.question ||
      context.carry.origin.frameRevision !== context.originFrame.id ||
      context.carry.receiving.frameRevision !== context.frame.id ||
      context.carry.origin.recordingPath !== parent.path ||
      context.carry.origin.recordingRevision !== parent.revision ||
      (context.carry.origin.opening?.id ?? null) !==
        (context.originOpening?.id ?? context.opening.id) ||
      (context.assumption &&
        (!text(context.assumption.decisionId) ||
          context.assumption.proposal?.scope.recordingRevision !== parent.revision))
    )
      throw new Error('Invalid continuation context');
    if (context.opening.sourceId && context.opening.sourceId !== parent.source?.id)
      throw new Error('Invalid opening source');
    if (parent.source?.graphId && parent.source.graphId !== parent.sourceGraph?.id)
      throw new Error('Invalid source graph');
    if (context.interpretedGraphs) {
      const proposal = context.assumption?.proposal;
      if (
        proposal?.kind !== 'local-interpretation-v2' ||
        proposal.scope.sourceId !== parent.source?.id ||
        graphRevision(reviseGraph(parent.queryGraph, proposal.queryEdits)) !==
          graphRevision(context.interpretedGraphs.query) ||
        (parent.sourceGraph &&
          graphRevision(reviseGraph(parent.sourceGraph, proposal.sourceEdits)) !==
            graphRevision(context.interpretedGraphs.source))
      )
        throw new Error('Invalid interpreted continuation graphs');
    }
    if (edge) {
      const graph =
        context.opening.kind === 'query'
          ? (context.interpretedGraphs?.query ?? parent.queryGraph)
          : (context.interpretedGraphs?.source ?? parent.sourceGraph);
      if (!graph?.edges.some((item) => JSON.stringify(item) === JSON.stringify(edge)))
        throw new Error('Invalid opening edge');
    }
    return context;
  }
  if (context?.version === 2) {
    if (
      context.schema !== 'tendora.continuation' ||
      context.author !== 'participant' ||
      context.contextUse !== 'review-only' ||
      !text(parent?.path) ||
      !text(parent?.revision) ||
      !text(parent?.project?.id) ||
      !text(parent?.question) ||
      !text(parent?.nodeId) ||
      !text(parent?.project?.path) ||
      !text(parent?.project?.placementId) ||
      !text(context.opening?.id) ||
      !['query', 'source', 'source-edge', 'parse', 'question'].includes(context.opening.kind) ||
      !text(context.opening?.label) ||
      !text(context.question) ||
      !text(context.scopePlacementId) ||
      !Array.isArray(context.history) ||
      !context.history.length ||
      context.history.at(-1).revision !== parent.revision ||
      context.history.at(-1).question !== parent.question ||
      (context.assumption &&
        (!text(context.assumption.decisionId) ||
          context.assumption.proposal?.scope.recordingRevision !== parent.revision))
    )
      throw new Error('Invalid continuation context');
    if (context.opening.sourceId && context.opening.sourceId !== parent.source?.id)
      throw new Error('Invalid opening source');
    if (parent.source?.graphId && parent.source.graphId !== parent.sourceGraph?.id)
      throw new Error('Invalid source graph');
    if (context.interpretedGraphs) {
      const proposal = context.assumption?.proposal;
      if (
        proposal?.kind !== 'local-interpretation-v2' ||
        proposal.scope.sourceId !== parent.source?.id ||
        graphRevision(reviseGraph(parent.queryGraph, proposal.queryEdits)) !==
          graphRevision(context.interpretedGraphs.query) ||
        (parent.sourceGraph &&
          graphRevision(reviseGraph(parent.sourceGraph, proposal.sourceEdits)) !==
            graphRevision(context.interpretedGraphs.source))
      )
        throw new Error('Invalid interpreted continuation graphs');
    }
    if (edge) {
      const graph =
        context.opening.kind === 'query'
          ? (context.interpretedGraphs?.query ?? parent.queryGraph)
          : (context.interpretedGraphs?.source ?? parent.sourceGraph);
      if (!graph?.edges.some((item) => JSON.stringify(item) === JSON.stringify(edge)))
        throw new Error('Invalid opening edge');
    }
    return context;
  }
  if (
    context?.schema !== 'tendora.continuation' ||
    context.version !== 1 ||
    context.contextUse !== 'review-only' ||
    context.author !== 'participant' ||
    !text(parent?.path) ||
    !text(parent?.revision) ||
    !text(parent?.question) ||
    !text(parent?.project?.id) ||
    !text(parent?.project?.path) ||
    !text(parent?.project?.placementId) ||
    !Array.isArray(parent?.route) ||
    parent.route.some((item) => !text(item?.nodeId) || !text(item?.label)) ||
    !text(parent?.nodeId) ||
    !text(parent?.occurrenceId) ||
    !text(parent?.source?.text) ||
    !text(context.opening?.label) ||
    !text(edge?.id) ||
    !parent?.queryGraph?.edges?.some((item) => JSON.stringify(item) === JSON.stringify(edge)) ||
    parent?.source?.graphId !== parent?.sourceGraph?.id ||
    (context.assumption !== null &&
      (!text(context.assumption?.decisionId) ||
        context.assumption?.proposal?.scope?.recordingRevision !== parent.revision ||
        context.assumption?.proposal?.scope?.occurrenceId !== parent.occurrenceId))
  )
    throw new Error('Invalid continuation context');
  if (
    context.history !== undefined &&
    (!Array.isArray(context.history) ||
      !context.history.length ||
      context.history.some(
        (item) =>
          !text(item?.question) ||
          !text(item?.path) ||
          !text(item?.revision) ||
          !text(item?.scopePlacementId) ||
          !text(item?.scopeLabel),
      ) ||
      context.history.at(-1).question !== parent.question ||
      context.history.at(-1).revision !== parent.revision)
  )
    throw new Error('Invalid continuation question history');
  if (context.caseEvidence !== undefined) {
    const evidence = context.caseEvidence;
    const hasEdge = (graph, id) => graph?.edges?.some((edge) => edge.id === id);
    const hasNode = (graph, id) => graph?.nodes?.some((node) => node.id === id);
    const invalid = () => {
      throw new Error('Invalid continuation case evidence');
    };
    if (
      evidence?.policy !== 'case-argument-v2' ||
      !/^Q[1-9][0-9]*$/u.test(evidence.ref) ||
      !Array.isArray(evidence.contexts) ||
      !evidence.contexts.length ||
      !Array.isArray(evidence.connections) ||
      !evidence.connections.length ||
      evidence.reference?.status !== 'bound'
    )
      invalid();
    const queryEdges = parent.queryGraph.edges.filter(
      (item) =>
        !(
          item.role === ':polarity' &&
          parent.queryGraph.nodes.find((node) => node.id === item.to)?.concept === 'amr-unknown'
        ),
    );
    if (evidence.ref !== `Q${queryEdges.findIndex((item) => item.id === edge.id) + 1}`) invalid();
    for (const inherited of evidence.contexts) {
      if (
        !text(inherited?.source?.text) ||
        inherited.source.graphId !== inherited.graph?.id ||
        !Array.isArray(inherited.route) ||
        !inherited.route.length ||
        inherited.route.some(
          (item, i) =>
            item.nodeId !== parent.route[i]?.nodeId || item.label !== parent.route[i]?.label,
        ) ||
        inherited.route.at(-1).nodeId !== inherited.nodeId ||
        inherited.route[0].nodeId !== evidence.reference.caseNodeId
      )
        invalid();
    }
    for (const connection of evidence.connections) {
      const inherited = evidence.contexts.find(
        (item) => item.source.id === connection.inheritedSourceId,
      );
      if (
        !inherited ||
        connection.contextNodeId !== inherited.nodeId ||
        connection.queryEdgeId !== edge.id ||
        connection.sourceId !== parent.source.id ||
        connection.caseNodeId !== evidence.reference.caseNodeId ||
        !evidence.reference.queryNodeIds?.includes(connection.queryNodeId) ||
        !hasNode(parent.queryGraph, connection.queryNodeId) ||
        !hasNode(parent.sourceGraph, connection.sourceNodeId) ||
        !hasEdge(parent.sourceGraph, connection.sourceEdgeId) ||
        !['linked', 'scoped', 'polarity', 'qualified'].includes(connection.status) ||
        !Array.isArray(connection.scopePath) ||
        connection.scopePath.some((id) => !hasEdge(inherited.graph, id)) ||
        !Array.isArray(connection.path) ||
        connection.path.some(
          (pair) =>
            !hasEdge(parent.queryGraph, pair.queryEdgeId) ||
            !hasEdge(parent.sourceGraph, pair.sourceEdgeId),
        ) ||
        !Array.isArray(connection.witnesses) ||
        !connection.witnesses.length ||
        connection.witnesses.some(
          (pair) =>
            !hasEdge(inherited.graph, pair.fromEdgeId) ||
            !hasEdge(parent.sourceGraph, pair.sourceEdgeId),
        )
      )
        invalid();
    }
  }
  return context;
}
