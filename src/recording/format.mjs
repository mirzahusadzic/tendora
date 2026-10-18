/** Flat, versioned evidence for an offline workbench. No model calls here. */
import { validateContinuation } from './continuation.mjs';
import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(value).digest('hex');

export const SCHEMA = 'tendora.workbench.recording';
export const VERSION = 1;
const graphId = (index) => `g${index + 1}`;
const amrId = (index) => `a${index + 1}`;

function graphRecord(id, graph) {
  return {
    id,
    top: graph.top,
    nodes: [...graph.labels].map(([nodeId, concept]) => ({ id: nodeId, concept })),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

function resolvedMappings(asset, obligation, interpretationId) {
  const paths = obligation.branches.flatMap((branch) => branch.requiredRefs);
  return (asset.mappings ?? []).map((mapping) => {
    if (
      typeof mapping.id !== 'string' ||
      typeof mapping.salienceId !== 'string' ||
      typeof mapping.event !== 'string' ||
      !Array.isArray(mapping.roles) ||
      mapping.roles.some((role) => typeof role !== 'string')
    ) {
      throw new Error(`invalid authored mapping ${mapping.id}`);
    }
    const matches = paths.filter(
      (path) =>
        path.steps[0]?.from === path.eventNode &&
        path.steps.map((step) => step.role).join('\u0000') === mapping.roles.join('\u0000') &&
        obligation.branches.some(
          (branch) =>
            branch.concept === mapping.event &&
            branch.requiredRefs.some((item) => item.id === path.id),
        ),
    );
    const status =
      matches.length === 1 ? 'matched' : matches.length === 0 ? 'inapplicable' : 'unresolved';
    return {
      id: mapping.id,
      salienceId: mapping.salienceId,
      interpretationId,
      status,
      queryPathId: matches.length === 1 ? matches[0].id : null,
      candidatePathIds: matches.length > 1 ? matches.map((path) => path.id) : [],
      reason:
        matches.length === 0
          ? 'No admitted inquiry path has this authored event and role sequence.'
          : matches.length > 1
            ? 'The selector addresses multiple admitted inquiry paths.'
            : null,
      rationale: mapping.rationale,
      attribution: { author: mapping.author, assetRevision: asset.revision },
      authoredSelector: { event: mapping.event, roles: mapping.roles },
    };
  });
}

/** Convert one *actual* run into ID-linked tables, without recursive copies. */
export function recordRun(run, { assetBytes, assetName = 'asset' }) {
  if (!run.result) throw new Error(`cannot record ingress ${run.retention.status}`);
  const { asset, prepared, nodes, parsed, views, texts, result, queryIndex } = run;
  const sourceRecords = new Map(prepared.map((node) => [node.id, node.sourceRecords]));
  const sourceId = (node, index) =>
    sourceRecords.get(node)?.[index]?.engineSourceId ?? `${node}/s${index + 1}`;
  const interpretationId = `i:${result.incoming.interpretation}`;
  const amrs = parsed.map((response, i) => ({
    id: amrId(i),
    text: texts[i],
    textDigest: digest(texts[i]),
    response,
    graphId: views[i] ? graphId(i) : null,
  }));
  const graphs = views.flatMap((graph, i) => (graph ? [graphRecord(graphId(i), graph)] : []));
  const sources = prepared.flatMap((node) =>
    nodes.get(node.id).sources.map((source, i) => ({
      ...(node.sourceRecords?.[i] ?? {}),
      id: sourceId(node.id, i),
      nodeId: node.id,
      text: source.text,
      textDigest: digest(source.text),
      amrId: amrId(source.inputIndex),
      graphId: source.graph ? graphId(source.inputIndex) : null,
      affinity: source.affinity,
    })),
  );
  const nodeRecords = prepared.map((node) => ({
    id: node.id,
    label: node.label ?? node.id,
    ...(node.conceptId ? { conceptId: node.conceptId } : {}),
    groupId:
      (asset.neighborhoods ?? []).find((group) => group.nodeIds.includes(node.id))?.id ?? null,
    crossingIds: node.crossings,
    sourceIds: node.sentences.map((_, i) => sourceId(node.id, i)),
    salienceIds: (asset.saliences ?? [])
      .filter((item) => item.nodeId === node.id)
      .map((item) => item.id),
  }));
  const saliences = (asset.saliences ?? []).map((item) => ({
    ...item,
    attribution: { author: item.author, assetRevision: asset.revision },
  }));
  const mappings = resolvedMappings(asset, result.incoming.obligation, interpretationId);
  const visits = [],
    occurrences = [],
    openings = [],
    proposals = [],
    cycleStops = [];
  const visitById = new Map();
  const seenOccurrences = new Set();
  let sequence = 0;
  const stack = [{ visit: result, parentVisitId: null, via: null }];
  while (stack.length) {
    const { visit, parentVisitId, via } = stack.pop();
    if (visit.kind === 'cycle') {
      cycleStops.push({
        id: `c${cycleStops.length + 1}`,
        parentVisitId,
        targetNodeId: visit.node,
        historyNodeIds: visit.returned.cycles[0].history,
      });
      continue;
    }
    const id = `v${++sequence}`;
    const occurrenceIds = visit.local.findings.map((finding) => {
      const occurrenceId = `o:${finding.id}`;
      if (!seenOccurrences.has(occurrenceId)) {
        seenOccurrences.add(occurrenceId);
        occurrences.push({
          id: occurrenceId,
          nodeId: finding.node,
          sourceId: sourceId(finding.node, finding.sourceIndex),
          sourceEventNodeId: finding.eventNode,
          op: finding.op,
          concept: finding.concept,
          requiredRefs: finding.requiredRefs,
          alignedRefs: finding.alignedRefs,
          openRefs: finding.openRefs,
          alternatives: finding.alternatives,
          bindings: finding.bindings,
          context: finding.context,
          markers: finding.markers,
        });
      }
      return occurrenceId;
    });
    const openingIds = visit.local.openings.map((opening, i) => {
      const openingId = `${id}/open${i + 1}`;
      openings.push({ id: openingId, visitId: id, ...opening });
      return openingId;
    });
    const proposalIds = visit.local.proposals.map((proposal, i) => {
      const proposalId = `${id}/proposal${i + 1}`;
      const source = nodes
        .get(visit.node)
        .proposals.find(
          (item) => item.english === proposal.english && item.sourceIndex === proposal.sourceIndex,
        );
      proposals.push({
        id: proposalId,
        visitId: id,
        sourceId: sourceId(visit.node, proposal.sourceIndex),
        baseInterpretationId: interpretationId,
        patch: proposal.patch,
        english: proposal.english,
        amrId: amrId(source.inputIndex),
        graphId: source.graph ? graphId(source.inputIndex) : null,
        status: 'unadopted',
      });
      return proposalId;
    });
    const contextChecks = visit.local.contextChecks?.map(
      ({ fromNodeId, fromSourceIndex, sourceIndex, ...check }) => ({
        ...check,
        inheritedSourceId: sourceId(fromNodeId, fromSourceIndex),
        localSourceId: sourceId(visit.node, sourceIndex),
      }),
    );
    const record = {
      id,
      nodeId: visit.node,
      parentVisitId,
      via,
      ...(contextChecks ? { contextChecks } : {}),
      occurrenceIds,
      openingIds,
      proposalIds,
      sourceCount: visit.local.sourceCount,
      validSourceCount: visit.local.validSourceCount,
      unchanged: visit.local.unchanged,
      return: {
        occurrenceIds,
        openingIds,
        proposalIds,
        ...(contextChecks ? { contextChecks } : {}),
        childVisitIds: [],
        cycleStopIds: [],
      },
    };
    visits.push(record);
    visitById.set(id, record);
    if (parentVisitId) visitById.get(parentVisitId).return.childVisitIds.push(id);
    for (let i = visit.children.length - 1; i >= 0; i--) {
      stack.push({
        visit: visit.children[i].result,
        parentVisitId: id,
        via: visit.children[i].target,
      });
    }
  }
  for (const stop of cycleStops)
    visitById.get(stop.parentVisitId).return.cycleStopIds.push(stop.id);
  return validateRecording({
    schema: SCHEMA,
    version: asset.caseState?.policy === 'selected-context-v2' || asset.ask ? 2 : VERSION,
    id: `r:${digest(`${assetBytes}\n${run.models.amr}\n${parsed[queryIndex].penman}`).slice(0, 16)}`,
    asset: { name: assetName, revision: asset.revision ?? null, digest: digest(assetBytes) },
    models: run.models,
    embedding: run.embedding,
    ...(asset.caseState ? { caseState: asset.caseState } : {}),
    ...(asset.project ? { project: asset.project } : {}),
    ...(asset.ask ? { ask: asset.ask } : {}),
    inquiry: {
      id: result.incoming.id,
      text: run.query,
      interpretationId,
      amrId: amrId(queryIndex),
      graphId: graphId(queryIndex),
      obligation: result.incoming.obligation,
      retention: run.retention.status,
    },
    interpretations: [
      {
        id: interpretationId,
        status: 'admitted',
        amrId: amrId(queryIndex),
        graphId: graphId(queryIndex),
      },
    ],
    amrs,
    graphs,
    neighborhoods: asset.neighborhoods ?? [],
    nodes: nodeRecords,
    saliences,
    mappings,
    sources,
    occurrences,
    visits,
    openings,
    proposals,
    cycleStops,
    rootVisitId: visits[0].id,
  });
}

/** Reject malformed or dangling records before presentation. */
export function validateRecording(data) {
  if (!data || data.schema !== SCHEMA || ![VERSION, 2].includes(data.version)) {
    throw new Error(
      `unsupported workbench recording schema/version: ${data?.schema}@${data?.version}`,
    );
  }
  if (data.continuation) {
    validateContinuation(data.continuation);
    if (
      data.continuation.question !== data.inquiry?.text ||
      data.continuation.scopePlacementId !== data.project?.placementId ||
      data.continuation.parent.project.id !== data.project?.id
    )
      throw new Error('Continuation inquiry scope mismatch');
  }
  const names = [
    'amrs',
    'graphs',
    'neighborhoods',
    'nodes',
    'saliences',
    'mappings',
    'sources',
    'occurrences',
    'visits',
    'openings',
    'proposals',
    'cycleStops',
    'interpretations',
  ];
  const tables = Object.fromEntries(
    names.map((name) => {
      if (!Array.isArray(data[name])) throw new Error(`recording ${name} must be an array`);
      const map = new Map();
      for (const item of data[name]) {
        if (typeof item?.id !== 'string' || !item.id || map.has(item.id))
          throw new Error(`recording ${name} has missing/duplicate ID ${item?.id}`);
        map.set(item.id, item);
      }
      return [name, map];
    }),
  );
  const ref = (table, id, owner, optional = false) => {
    if (optional && id == null) return;
    if (!tables[table].has(id)) throw new Error(`${owner} references absent ${table} ${id}`);
  };
  ref('visits', data.rootVisitId, 'rootVisitId');
  ref('amrs', data.inquiry?.amrId, 'inquiry');
  ref('graphs', data.inquiry?.graphId, 'inquiry');
  ref('interpretations', data.inquiry?.interpretationId, 'inquiry');
  if (data.routing) {
    const routing = data.routing,
      candidates = routing.candidates;
    if (routing.profile === 'question-role-similarity-v1') {
      if (routing.status === 'unavailable') {
        if (typeof routing.reason !== 'string' || !routing.reason.trim())
          throw new Error('Role matching needs its unavailable reason');
      } else {
        if (
          routing.status !== 'matched' ||
          typeof routing.model !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(routing.evidenceRef ?? '') ||
          !Array.isArray(routing.matches) ||
          routing.matches.length !== data.nodes.length ||
          new Set(routing.matches.map((m) => m.nodeId)).size !== data.nodes.length
        )
          throw new Error('Invalid role matching');
        for (const match of routing.matches) {
          ref('nodes', match.nodeId, 'role matching');
          ref('nodes', match.best?.nodeId, 'role match source');
          if (
            !Array.isArray(match.local) ||
            !match.local.length ||
            [...match.local, match.best].some(
              (m) =>
                typeof m.text !== 'string' ||
                !Number.isFinite(m.score) ||
                Math.abs(m.score) > 1.000001,
            ) ||
            JSON.stringify(match.children) !==
              JSON.stringify(tables.nodes.get(match.nodeId).crossingIds)
          )
            throw new Error('Invalid matched role order');
          const children = match.children.map((id) => routing.matches.find((m) => m.nodeId === id));
          if (children.some((m, i) => !m || (i && m.best.score > children[i - 1].best.score)))
            throw new Error('Role matches are out of order');
        }
      }
    } else if (routing.policy === 'local-then-ranked-children-v1') {
      if (
        typeof routing.model !== 'string' ||
        !Array.isArray(routing.steps) ||
        routing.steps.length !== data.nodes.length
      )
        throw new Error('Invalid child routing');
      ref('nodes', routing.scopePlacementId, 'routing scope');
      const seen = new Set();
      for (const step of routing.steps) {
        ref('nodes', step.nodeId, 'routing step');
        if (seen.has(step.nodeId)) throw new Error('Duplicate routing step');
        seen.add(step.nodeId);
        if (step.contextNodeIds) {
          if (
            !data.caseState ||
            !Array.isArray(step.contextNodeIds) ||
            step.contextNodeIds.at(-1) !== step.nodeId ||
            new Set(step.contextNodeIds).size !== step.contextNodeIds.length
          )
            throw new Error('Invalid routing context');
          for (const id of step.contextNodeIds) ref('nodes', id, 'routing context');
          if (data.caseState.policy === 'selected-context-v2') {
            const expected = new Set([data.caseState.rootNodeId]);
            const visit = data.visits.find((item) => item.nodeId === step.nodeId);
            const seen = new Set();
            for (
              let item = visit;
              item && !seen.has(item.id);
              item = tables.visits.get(item.parentVisitId)
            ) {
              seen.add(item.id);
              expected.add(item.nodeId);
            }
            if (
              visit &&
              (expected.size !== step.contextNodeIds.length ||
                step.contextNodeIds.some((id) => !expected.has(id)))
            )
              throw new Error('Invalid routing context path');
          } else {
            if (step.contextNodeIds[0] !== data.caseState.rootNodeId)
              throw new Error('Invalid routing context');
            for (let i = 1; i < step.contextNodeIds.length; i++)
              if (
                !tables.nodes
                  .get(step.contextNodeIds[i - 1])
                  .crossingIds.includes(step.contextNodeIds[i])
              )
                throw new Error('Invalid routing context path');
          }
        }
        const expected = tables.nodes.get(step.nodeId).crossingIds;
        if (
          !Array.isArray(step.candidates) ||
          step.candidates.length !== expected.length ||
          step.candidates.some(
            (c, i) =>
              !c ||
              c.placementId !== expected[i] ||
              c.rank !== i + 1 ||
              typeof c.text !== 'string' ||
              typeof c.name !== 'string' ||
              !Array.isArray(c.path) ||
              c.path.some((part) => typeof part !== 'string') ||
              !Number.isFinite(c.similarity) ||
              (i > 0 && c.similarity > step.candidates[i - 1].similarity),
          )
        )
          throw new Error('Invalid child ranking');
      }
    } else {
      if (
        typeof routing.model !== 'string' ||
        typeof routing.scopePlacementId !== 'string' ||
        !Array.isArray(candidates) ||
        !candidates.length ||
        candidates[0].placementId !== routing.selectedPlacementId ||
        new Set(candidates.map((c) => c.placementId)).size !== candidates.length ||
        candidates.some(
          (c, i) =>
            typeof c.placementId !== 'string' ||
            typeof c.text !== 'string' ||
            !Array.isArray(c.path) ||
            c.path.some((part) => typeof part !== 'string') ||
            !Number.isFinite(c.similarity) ||
            c.rank !== i + 1 ||
            (i > 0 && c.similarity > candidates[i - 1].similarity),
        )
      )
        throw new Error('Invalid concept selection ranking');
      ref('nodes', routing.selectedPlacementId, 'concept selection');
    }
  }
  for (const graph of data.graphs) {
    const nodeIds = new Set(graph.nodes?.map((node) => node.id));
    if (!nodeIds.has(graph.top)) throw new Error(`graph ${graph.id} has absent top`);
    const edgeIds = new Set();
    for (const edge of graph.edges ?? []) {
      if (!edge.id || edgeIds.has(edge.id) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to))
        throw new Error(`graph ${graph.id} has invalid edge ${edge.id}`);
      edgeIds.add(edge.id);
    }
  }
  for (const amr of data.amrs) {
    ref('graphs', amr.graphId, amr.id, true);
    if (amr.textDigest !== digest(amr.text)) throw new Error(`AMR ${amr.id} text digest mismatch`);
  }
  for (const group of data.neighborhoods)
    for (const id of group.nodeIds) ref('nodes', id, group.id);
  for (const node of data.nodes) {
    ref('neighborhoods', node.groupId, node.id, true);
    if (node.groupId && !tables.neighborhoods.get(node.groupId).nodeIds.includes(node.id))
      throw new Error(`${node.id} absent from its group`);
    for (const id of node.crossingIds) ref('nodes', id, node.id);
    for (const id of node.sourceIds) {
      ref('sources', id, node.id);
      if (tables.sources.get(id).nodeId !== node.id)
        throw new Error(`${node.id} lists another node's source ${id}`);
    }
    for (const id of node.salienceIds) ref('saliences', id, node.id);
  }
  for (const salience of data.saliences) ref('nodes', salience.nodeId, salience.id);
  const paths = new Map(
    data.inquiry.obligation.branches
      .flatMap((branch) => branch.requiredRefs)
      .map((path) => [path.id, path]),
  );
  for (const interpretation of data.interpretations) {
    ref('amrs', interpretation.amrId, interpretation.id);
    ref('graphs', interpretation.graphId, interpretation.id);
  }
  const queryGraph = tables.graphs.get(data.inquiry.graphId);
  const queryNodes = new Set(queryGraph.nodes.map((node) => node.id));
  const queryEdges = new Set(queryGraph.edges.map((edge) => edge.id));
  for (const path of paths.values()) {
    if (
      path.queryNodeIds.some((id) => !queryNodes.has(id)) ||
      path.queryEdgeIds.some((id) => !queryEdges.has(id))
    )
      throw new Error(`query path ${path.id} has absent graph refs`);
  }
  for (const mapping of data.mappings) {
    ref('saliences', mapping.salienceId, mapping.id);
    ref('interpretations', mapping.interpretationId, mapping.id);
    const status = mapping.status ?? (mapping.queryPathId ? 'matched' : null);
    if (status === 'matched') {
      if (!paths.has(mapping.queryPathId)) throw new Error(`mapping ${mapping.id} has absent path`);
    } else if (status === 'inapplicable' || status === 'unresolved') {
      if (
        mapping.queryPathId !== null ||
        typeof mapping.reason !== 'string' ||
        !mapping.reason.trim()
      )
        throw new Error(`mapping ${mapping.id} has invalid ${status} state`);
      for (const id of mapping.candidatePathIds ?? [])
        if (!paths.has(id))
          throw new Error(`mapping ${mapping.id} has absent candidate path ${id}`);
    } else throw new Error(`mapping ${mapping.id} has invalid status ${status}`);
  }
  for (const source of data.sources) {
    ref('nodes', source.nodeId, source.id);
    ref('amrs', source.amrId, source.id);
    ref('graphs', source.graphId, source.id, true);
    if (source.textDigest !== digest(source.text))
      throw new Error(`source ${source.id} digest mismatch`);
    if (tables.amrs.get(source.amrId).text !== source.text)
      throw new Error(`source ${source.id} and AMR text differ`);
  }
  if (
    data.caseState &&
    (!['ancestor-context-v1', ...(data.version >= 2 ? ['selected-context-v2'] : [])].includes(
      data.caseState.policy,
    ) ||
      (data.caseState.policy === 'ancestor-context-v1' &&
        data.caseState.rootNodeId !== tables.visits.get(data.rootVisitId).nodeId) ||
      !tables.nodes.get(data.caseState.rootNodeId)?.sourceIds.length)
  )
    throw new Error('Invalid case state root');
  if (data.caseState?.policy === 'selected-context-v2') {
    const selected = data.caseState.selection,
      root = tables.nodes.get(data.caseState.rootNodeId);
    if (
      !selected ||
      selected.projectId !== data.project?.id ||
      selected.placementId !== root.id ||
      !Array.isArray(selected.sources) ||
      selected.sources.length !== root.sourceIds.length ||
      selected.sources.some(
        (source, i) =>
          source.projectId !== selected.projectId ||
          source.placementId !== root.id ||
          source.conceptId !== selected.conceptId ||
          !Number.isInteger(source.index) ||
          source.index < 0 ||
          !source.revision ||
          source.text !== tables.sources.get(root.sourceIds[i]).text ||
          source.textDigest !== digest(source.text),
      )
    )
      throw new Error('Invalid case snapshots');
    const binding = data.caseState.binding;
    if (
      binding &&
      (binding.caseNodeId !== root.id ||
        !binding.queryNodeId ||
        !binding.graphDigest ||
        !binding.decisionId ||
        binding.questionDigest !== digest(data.inquiry.text))
    )
      throw new Error('Invalid case binding');
  }
  if (
    data.ask &&
    (data.version < 2 ||
      !data.ask.investigationId ||
      !data.ask.askId ||
      !Number.isInteger(data.ask.revision) ||
      data.ask.revision < 1 ||
      data.ask.question !== data.inquiry.text ||
      !data.ask.intention?.id ||
      typeof data.ask.intention.text !== 'string')
  )
    throw new Error('Invalid ask reference');
  if (data.reasoning) {
    const reasoning = data.reasoning,
      hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
    if (
      reasoning.profile !== 'amr-inquiry-chain-v1' ||
      !/^[a-f0-9-]{36}$/u.test(reasoning.runId) ||
      !hash(reasoning.inputRef) ||
      !hash(reasoning.resultRef) ||
      !Array.isArray(reasoning.candidates) ||
      !Array.isArray(reasoning.openings) ||
      !Array.isArray(reasoning.calls) ||
      !Array.isArray(reasoning.stages) ||
      JSON.stringify(reasoning.ask) !== JSON.stringify(data.ask ?? null)
    )
      throw new Error('Invalid inquiry reasoning reference');
    for (const candidate of reasoning.candidates) {
      ref('sources', candidate.sourceId, 'reasoning candidate');
      if (
        !queryGraph.nodes.some(
          (node) => node.id === candidate.unknownId && node.concept === 'amr-unknown',
        )
      )
        throw new Error('Invalid situated unknown');
      for (const path of candidate.paths) ref('sources', path.caseId, 'reasoning case');
    }
    for (const chain of reasoning.chains ?? []) {
      ref('sources', chain.sourceId, 'reasoning chain');
      ref('sources', chain.otherSourceId, 'reasoning chain');
    }
    for (const application of reasoning.applications ?? []) {
      ref('sources', application.sourceId, 'reasoning application');
      ref('sources', application.caseId, 'reasoning application');
    }
    for (const call of reasoning.calls)
      if (
        !hash(call.requestRef) ||
        (call.responseRef && !hash(call.responseRef)) ||
        (call.errorRef && !hash(call.errorRef))
      )
        throw new Error('Invalid client artifact reference');
  }

  for (const occurrence of data.occurrences) {
    ref('nodes', occurrence.nodeId, occurrence.id);
    ref('sources', occurrence.sourceId, occurrence.id);
    const source = tables.sources.get(occurrence.sourceId);
    if (source.nodeId !== occurrence.nodeId)
      throw new Error(`${occurrence.id} source belongs to another node`);
    const graph = tables.graphs.get(source.graphId);
    const sourceNodes = new Set(graph.nodes.map((node) => node.id));
    const sourceEdges = new Set(graph.edges.map((edge) => edge.id));
    if (!sourceNodes.has(occurrence.sourceEventNodeId))
      throw new Error(`${occurrence.id} absent event node`);
    for (const path of occurrence.requiredRefs)
      if (!paths.has(path.id)) throw new Error(`${occurrence.id} absent required path ${path.id}`);
    const alignedIds = new Set(occurrence.alignedRefs.map((item) => item.queryPathId));
    const openedIds = new Set(occurrence.openRefs);
    const requiredIds = new Set(occurrence.requiredRefs.map((item) => item.id));
    if (
      alignedIds.size + openedIds.size !== requiredIds.size ||
      [...alignedIds, ...openedIds].some((id) => !requiredIds.has(id)) ||
      [...alignedIds].some((id) => openedIds.has(id))
    )
      throw new Error(`${occurrence.id} has incomplete/overlapping path status`);
    for (const aligned of occurrence.alignedRefs) {
      if (
        !paths.has(aligned.queryPathId) ||
        aligned.sourceNodeIds.some((id) => !sourceNodes.has(id)) ||
        aligned.sourceEdgeIds.some((id) => !sourceEdges.has(id))
      )
        throw new Error(`${occurrence.id} invalid aligned path`);
    }
    for (const id of occurrence.openRefs)
      if (!paths.has(id)) throw new Error(`${occurrence.id} absent open path ${id}`);
    for (const alternative of occurrence.alternatives) {
      if (
        !openedIds.has(alternative.expectedPathId) ||
        alternative.sourceNodeIds.some((id) => !sourceNodes.has(id)) ||
        alternative.sourceEdgeIds.some((id) => !sourceEdges.has(id))
      )
        throw new Error(`${occurrence.id} invalid alternative path`);
    }
    for (const binding of occurrence.bindings ?? []) {
      const queryNode = queryGraph.nodes.find((node) => node.id === binding.queryNodeId);
      const sourceNode = graph.nodes.find((node) => node.id === binding.sourceNodeId);
      const anchor = graph.edges.find((edge) => edge.id === binding.sourceEdgeId);
      const queryAnchor = occurrence.requiredRefs.some((path) => {
        const first = path.steps[0];
        return (
          first?.to === binding.queryNodeId &&
          first.role === binding.role &&
          first.direction === binding.direction
        );
      });
      if (
        binding.status !== 'provisional' ||
        queryNode?.concept !== 'amr-unknown' ||
        !sourceNode ||
        sourceNode.concept !== binding.concept ||
        binding.concept === 'amr-unknown' ||
        binding.role === ':polarity' ||
        !queryAnchor ||
        !anchor ||
        anchor.role !== binding.role ||
        !['in', 'out'].includes(binding.direction) ||
        (binding.direction === 'out'
          ? anchor.from !== occurrence.sourceEventNodeId || anchor.to !== binding.sourceNodeId
          : anchor.to !== occurrence.sourceEventNodeId || anchor.from !== binding.sourceNodeId)
      )
        throw new Error(`${occurrence.id} invalid question binding`);
      const located = new Set(binding.locatedRefs.map((item) => item.queryPathId));
      const open = new Set(binding.openRefs);
      if (
        located.size !== binding.locatedRefs.length ||
        open.size !== binding.openRefs.length ||
        located.size + open.size !== requiredIds.size ||
        [...located, ...open].some((id) => !requiredIds.has(id)) ||
        [...located].some((id) => open.has(id))
      )
        throw new Error(`${occurrence.id} invalid binding path status`);
      for (const witness of binding.locatedRefs) {
        const path = paths.get(witness.queryPathId);
        if (
          witness.sourceNodeIds.length !== path.queryNodeIds.length ||
          witness.sourceEdgeIds.length !== path.steps.length ||
          witness.sourceNodeIds[0] !== occurrence.sourceEventNodeId ||
          witness.sourceNodeIds.some(
            (id, i) =>
              !sourceNodes.has(id) ||
              (path.queryNodeIds[i] === binding.queryNodeId && id !== binding.sourceNodeId),
          ) ||
          witness.sourceEdgeIds.some((id) => !sourceEdges.has(id))
        )
          throw new Error(`${occurrence.id} invalid bound witness`);
        const assigned = new Map([
          [path.eventNode, occurrence.sourceEventNodeId],
          [binding.queryNodeId, binding.sourceNodeId],
        ]);
        for (const [i, step] of path.steps.entries()) {
          const edge = graph.edges.find((item) => item.id === witness.sourceEdgeIds[i]);
          const from = witness.sourceNodeIds[i],
            to = witness.sourceNodeIds[i + 1];
          if (
            edge.role !== step.role ||
            (step.direction === 'out'
              ? edge.from !== from || edge.to !== to
              : edge.to !== from || edge.from !== to) ||
            (assigned.has(step.to) && assigned.get(step.to) !== to) ||
            (step.to !== binding.queryNodeId &&
              graph.nodes.find((node) => node.id === to).concept !== step.concept)
          )
            throw new Error(`${occurrence.id} incoherent bound witness`);
          assigned.set(step.to, to);
        }
      }
      for (const scope of binding.sourceScope)
        if (
          typeof scope.text !== 'string' ||
          scope.sourceNodeIds.some((id) => !sourceNodes.has(id)) ||
          scope.sourceEdgeIds.some((id) => !sourceEdges.has(id))
        )
          throw new Error(`${occurrence.id} invalid binding scope`);
    }
  }
  for (const visit of data.visits) {
    ref('nodes', visit.nodeId, visit.id);
    ref('visits', visit.parentVisitId, visit.id, true);
    if (data.caseState && !Array.isArray(visit.contextChecks))
      throw new Error(`${visit.id} missing context checks`);
    if (visit.contextChecks) {
      if (
        !data.caseState ||
        JSON.stringify(visit.contextChecks) !== JSON.stringify(visit.return.contextChecks)
      )
        throw new Error(`${visit.id} invalid context return`);
      const ancestors = new Set();
      for (
        let parent = tables.visits.get(visit.parentVisitId);
        parent;
        parent = tables.visits.get(parent.parentVisitId)
      ) {
        if (ancestors.has(parent.nodeId)) throw new Error('Invalid context ancestry');
        ancestors.add(parent.nodeId);
      }
      if (data.caseState.policy === 'selected-context-v2') {
        ancestors.add(data.caseState.rootNodeId);
        ancestors.delete(visit.nodeId);
      }
      const expected = new Set(
        [...ancestors].flatMap((node) =>
          tables.nodes
            .get(node)
            .sourceIds.flatMap((inherited) =>
              tables.nodes
                .get(visit.nodeId)
                .sourceIds.map((local) => JSON.stringify([inherited, local])),
            ),
        ),
      );
      for (const check of visit.contextChecks) {
        ref('sources', check.inheritedSourceId, visit.id);
        ref('sources', check.localSourceId, visit.id);
        const inherited = tables.sources.get(check.inheritedSourceId),
          local = tables.sources.get(check.localSourceId);
        if (
          !ancestors.has(inherited.nodeId) ||
          local.nodeId !== visit.nodeId ||
          !['examined', 'parse-unavailable'].includes(check.status) ||
          !Array.isArray(check.anchors)
        )
          throw new Error(`${visit.id} invalid context source`);
        if (!expected.delete(JSON.stringify([check.inheritedSourceId, check.localSourceId])))
          throw new Error(`${visit.id} duplicate context check`);
        const from = tables.graphs.get(inherited.graphId),
          to = tables.graphs.get(local.graphId);
        if (
          (check.status === 'examined') !== Boolean(from && to) ||
          ((!from || !to) && check.anchors.length)
        )
          throw new Error(`${visit.id} invalid context parse status`);
        for (const anchor of check.anchors) {
          if (
            from?.nodes.find((n) => n.id === anchor.fromEvent)?.concept !== anchor.concept ||
            to?.nodes.find((n) => n.id === anchor.sourceEvent)?.concept !== anchor.concept ||
            typeof anchor.complete !== 'boolean'
          )
            throw new Error(`${visit.id} invalid context anchor`);
          const mapping = new Map([[anchor.fromEvent, anchor.sourceEvent]]);
          for (const pair of anchor.shared) {
            const a = from.edges.find((e) => e.id === pair.fromEdgeId),
              b = to.edges.find((e) => e.id === pair.sourceEdgeId);
            const label = (g, id) => g.nodes.find((n) => n.id === id)?.concept;
            if (
              !a ||
              !b ||
              a.role !== b.role ||
              label(from, a.from) !== label(to, b.from) ||
              label(from, a.to) !== label(to, b.to)
            )
              throw new Error(`${visit.id} invalid context edge`);
            for (const [left, right] of [
              [a.from, b.from],
              [a.to, b.to],
            ]) {
              if (
                mapping.has(left)
                  ? mapping.get(left) !== right
                  : [...mapping.values()].includes(right)
              )
                throw new Error(`${visit.id} inconsistent context mapping`);
              mapping.set(left, right);
            }
          }
          for (const pair of anchor.differences ?? []) {
            const a = from.edges.find((e) => e.id === pair.fromEdgeId),
              b = to.edges.find((e) => e.id === pair.sourceEdgeId);
            if (
              !a ||
              !b ||
              a.role !== b.role ||
              !(
                (a.from === anchor.fromEvent && b.from === anchor.sourceEvent) ||
                (a.to === anchor.fromEvent && b.to === anchor.sourceEvent)
              )
            )
              throw new Error(`${visit.id} invalid context difference`);
          }
        }
      }
      if (expected.size) throw new Error(`${visit.id} missing context pair`);
    }
    for (const id of visit.occurrenceIds) ref('occurrences', id, visit.id);
    if (visit.occurrenceIds.some((id) => tables.occurrences.get(id).nodeId !== visit.nodeId))
      throw new Error(`${visit.id} occurrence belongs to another node`);
    for (const id of visit.openingIds) ref('openings', id, visit.id);
    for (const id of visit.proposalIds) ref('proposals', id, visit.id);
    for (const key of ['occurrenceIds', 'openingIds', 'proposalIds']) {
      if (JSON.stringify(visit[key]) !== JSON.stringify(visit.return[key]))
        throw new Error(`${visit.id} return ${key} differs from local record`);
    }
    for (const id of visit.return.childVisitIds) {
      ref('visits', id, visit.id);
      if (tables.visits.get(id).parentVisitId !== visit.id)
        throw new Error(`${visit.id} child parent mismatch`);
    }
    for (const id of visit.return.cycleStopIds) ref('cycleStops', id, visit.id);
  }
  if (tables.visits.get(data.rootVisitId).parentVisitId !== null)
    throw new Error('root visit has a parent');
  const order = new Map(data.visits.map((visit, i) => [visit.id, i]));
  for (const visit of data.visits)
    if (visit.parentVisitId && order.get(visit.parentVisitId) >= order.get(visit.id))
      throw new Error(`${visit.id} parent is not earlier in recorded traversal`);
  for (const opening of data.openings) {
    ref('visits', opening.visitId, opening.id);
    for (const path of opening.paths ?? [])
      if (!paths.has(path.id)) throw new Error(`${opening.id} absent carried path ${path.id}`);
  }
  for (const proposal of data.proposals) {
    ref('visits', proposal.visitId, proposal.id);
    ref('sources', proposal.sourceId, proposal.id);
    ref('amrs', proposal.amrId, proposal.id);
    ref('graphs', proposal.graphId, proposal.id, true);
  }
  for (const stop of data.cycleStops) {
    ref('visits', stop.parentVisitId, stop.id);
    ref('nodes', stop.targetNodeId, stop.id);
    if (!tables.visits.get(stop.parentVisitId).return.cycleStopIds.includes(stop.id))
      throw new Error(`${stop.id} absent from parent return`);
  }
  return data;
}
