/** Participant-authored interpretations over immutable recorded inputs. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { reviewCorrespondence } from '../amr/interpretation.mjs';
import { compareGraphs } from '../amr/comparison.mjs';
import { reviseGraph } from '../amr/revision.mjs';
import { focus } from '../amr/graph.mjs';
import { inspectConjunction, inspectFocus, inspectAnchor } from '../amr/audit.mjs';
import { compareContextEvents } from '../amr/context-comparison.mjs';
import { caseSources } from './case-sources.mjs';
import { interpretationRevision, graphRevision } from './revisions.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function authorInterpretation(
  ix,
  {
    sourceId = null,
    occurrenceId = null,
    queryEvent = null,
    sourceEvent = null,
    mappings = [],
    binding = null,
    queryEdits = [],
    sourceEdits = [],
    caseBinding = null,
    supersedes = null,
    reusedFrom = null,
  } = {},
) {
  const occurrence = ix.occurrences.get(occurrenceId);
  if (occurrence?.authored) occurrenceId = null;
  ix = ix.baseIndex ?? ix;
  const source = ix.sources.get(sourceId ?? occurrence?.sourceId);
  const query = ix.graphs.get(ix.recording.inquiry.graphId),
    graph = source && ix.graphs.get(source.graphId);
  const scope = {
    recordingRevision: interpretationRevision(ix.recording),
    nodeId: occurrence?.nodeId ?? source?.nodeId ?? null,
    occurrenceId: occurrenceId ?? null,
    sourceId: source?.id ?? null,
    queryGraphId: query.id,
    sourceGraphId: graph?.id ?? null,
    queryRevision: graphRevision(query),
    sourceRevision: graph ? graphRevision(graph) : null,
    queryEvent: queryEvent ?? occurrence?.requiredRefs[0]?.eventNode ?? null,
    sourceEvent: sourceEvent ?? occurrence?.sourceEventNodeId ?? null,
  };
  const body = {
    scope,
    mappings: structuredClone(mappings),
    binding: structuredClone(binding),
    queryEdits: structuredClone(queryEdits),
    sourceEdits: structuredClone(sourceEdits),
    caseBinding: structuredClone(caseBinding),
    supersedes,
    reusedFrom,
  };
  return {
    id: `authored:${digest(body)}`,
    kind: 'local-interpretation-v2',
    ...body,
    author: 'participant',
    correspondence: mappings[0] ?? null,
  };
}

export function reviewInterpretation(ix, proposal) {
  ix = ix.baseIndex ?? ix;
  if (proposal.kind !== 'local-interpretation-v2') return reviewLegacyProposal(ix, proposal);
  const { scope, mappings, binding, queryEdits, sourceEdits, caseBinding, supersedes, reusedFrom } =
    proposal;
  if (
    proposal.id !==
    `authored:${digest({ scope, mappings, binding, queryEdits, sourceEdits, caseBinding, supersedes, reusedFrom })}`
  )
    throw new Error('Interpretation changed');
  const originalQuery = ix.graphs.get(scope.queryGraphId),
    originalSource = ix.graphs.get(scope.sourceGraphId);
  if (
    scope.recordingRevision !== interpretationRevision(ix.recording) ||
    scope.queryGraphId !== ix.recording.inquiry.graphId ||
    !originalQuery ||
    graphRevision(originalQuery) !== scope.queryRevision ||
    (scope.sourceId &&
      (!originalSource ||
        ix.sources.get(scope.sourceId)?.nodeId !== scope.nodeId ||
        ix.sources.get(scope.sourceId)?.graphId !== scope.sourceGraphId ||
        graphRevision(originalSource) !== scope.sourceRevision))
  )
    throw new Error('Interpretation scope changed');
  if (scope.occurrenceId && ix.occurrences.get(scope.occurrenceId)?.sourceId !== scope.sourceId)
    throw new Error('Interpretation scope changed');
  if (
    !Array.isArray(proposal.mappings) ||
    !Array.isArray(proposal.queryEdits) ||
    !Array.isArray(proposal.sourceEdits)
  )
    throw new Error('Invalid interpretation operations');
  const query = reviseGraph(originalQuery, proposal.queryEdits),
    source = originalSource && reviseGraph(originalSource, proposal.sourceEdits);
  const empty = (g) => ({
    mapping: new Map(),
    shared: [],
    queryOnly: g.edges,
    sourceOnly: [],
    complete: true,
  });
  const compare = (q, s, extra = {}) => {
    if (!s || !scope.queryEvent || !scope.sourceEvent) return empty(q);
    return compareGraphs(q, s, {
      queryEvent: scope.queryEvent,
      sourceEvent: scope.sourceEvent,
      ...extra,
    });
  };
  let before;
  try {
    before = compare(originalQuery, originalSource);
  } catch {
    before = empty(originalQuery);
  }
  if (
    proposal.caseBinding &&
    (!ix.recording.caseState ||
      proposal.caseBinding.caseNodeId !== ix.recording.caseState.rootNodeId ||
      !query.nodes.some((node) => node.id === proposal.caseBinding.queryNodeId))
  )
    throw new Error('Invalid case reference');
  if (
    (proposal.mappings.length || proposal.binding) &&
    (!source || !scope.queryEvent || !scope.sourceEvent)
  )
    throw new Error('Comparison anchors required');
  const after = compare(query, source, {
    correspondences: proposal.mappings,
    binding: proposal.binding,
  });
  const factual = (edge) =>
    !(
      edge.role === ':polarity' &&
      query.nodes.find((node) => node.id === edge.to)?.concept === 'amr-unknown'
    );
  const previous = new Set(before.shared.map((pair) => pair.queryEdge.id)),
    current = new Set(after.shared.map((pair) => pair.queryEdge.id));
  return {
    before,
    after,
    query,
    source,
    beforeCount: before.shared.filter((pair) => factual(pair.queryEdge)).length,
    afterCount: after.shared.filter((pair) => factual(pair.queryEdge)).length,
    added: after.shared
      .filter((pair) => !previous.has(pair.queryEdge.id))
      .map((pair) => pair.queryEdge),
    lost: before.shared
      .filter((pair) => !current.has(pair.queryEdge.id))
      .map((pair) => pair.queryEdge),
    unresolved: after.queryOnly.filter(factual),
    complete: before.complete && after.complete,
  };
}

export function activeInterpretations(decisions) {
  const latest = new Map();
  for (const entry of decisions) latest.set(entry.proposal.id, entry);
  const superseded = new Set(
    [...latest.values()]
      .filter((entry) => entry.decision === 'accepted')
      .map((entry) => entry.proposal.supersedes)
      .filter(Boolean),
  );
  return [...latest.values()].filter(
    (entry) => entry.decision === 'accepted' && !superseded.has(entry.proposal.id),
  );
}
export function acceptedCaseReference(ix, decisions = []) {
  const entry = activeInterpretations(decisions)
    .filter((item) => item.proposal.caseBinding)
    .at(-1);
  if (!entry) return null;
  const review = reviewInterpretation(ix, entry.proposal);
  return {
    ...entry.proposal.caseBinding,
    graphDigest: graphRevision(review.query),
    decisionId: entry.id,
  };
}
export function interpretationLabel(proposal) {
  if (proposal.kind !== 'local-interpretation-v2')
    return `${proposal.correspondence.queryConcept} ↔ ${proposal.correspondence.sourceConcept}`;
  return [
    ...proposal.mappings.map((item) => `${item.queryConcept} ↔ ${item.sourceConcept}`),
    ...(proposal.binding
      ? [`${proposal.binding.queryNodeId} → ${proposal.binding.sourceNodeId}`]
      : []),
    ...(proposal.caseBinding
      ? [`${proposal.caseBinding.queryNodeId} → ${proposal.caseBinding.caseNodeId}`]
      : []),
    ...(proposal.queryEdits.length + proposal.sourceEdits.length
      ? [`Parse Δ ${proposal.queryEdits.length + proposal.sourceEdits.length}`]
      : []),
  ].join('; ');
}

/** Derive fresh context checks when either side's parse changed. */
export function interpretedIndex(ix, occurrence, accepted) {
  if (
    !accepted?.review.query ||
    (!accepted.proposal.queryEdits.length && !accepted.proposal.sourceEdits.length)
  )
    return ix;
  const graphs = new Map(ix.graphs);
  graphs.set(accepted.review.query.id, accepted.review.query);
  if (accepted.review.source) graphs.set(accepted.review.source.id, accepted.review.source);
  const comparable = (g) => ({
    top: g.top,
    labels: new Map(g.nodes.map((node) => [node.id, node.concept])),
    edges: g.edges,
  });
  const visits = ix.recording.visits.map((visit) => ({
    ...visit,
    contextChecks: visit.contextChecks?.map((check) => {
      const from = graphs.get(ix.sources.get(check.inheritedSourceId).graphId),
        to = graphs.get(ix.sources.get(check.localSourceId).graphId);
      return {
        ...check,
        anchors: from && to ? compareContextEvents(comparable(from), comparable(to)) : [],
      };
    }),
  }));
  return {
    ...ix,
    baseIndex: ix.baseIndex ?? ix,
    graphs,
    recording: { ...ix.recording, visits },
    visits: new Map(visits.map((visit) => [visit.id, visit])),
  };
}

/** Re-audit edited graphs locally; the recorded traversal remains immutable. */
const projections = new WeakMap();
export function projectInterpretations(index, decisions = []) {
  const ix = index.baseIndex ?? index;
  const cached = projections.get(ix);
  if (cached?.decisions === decisions) return cached.index;
  const occurrences = new Map(
    ix.occurrences ?? ix.recording.occurrences.map((item) => [item.id, item]),
  );
  const graphView = (graph) => ({
    ...graph,
    labels: new Map(graph.nodes.map((node) => [node.id, node.concept])),
  });
  for (const entry of activeInterpretations(decisions)) {
    const p = entry.proposal;
    if (p.kind !== 'local-interpretation-v2' || !p.scope.sourceId) continue;
    const review = reviewInterpretation(ix, p);
    if (!p.scope.queryEvent || !p.scope.sourceEvent) continue;
    if (!p.queryEdits.length && !p.sourceEdits.length && p.scope.occurrenceId) continue;
    const q = graphView(review.query),
      s = graphView(review.source);
    const audit = inspectConjunction(q, [s]) ?? inspectFocus(q, [s], focus(q));
    const branches = audit.branches ?? [audit.branch];
    const branch =
      branches.find(
        (item) =>
          item.requiredRefs.some((ref) => ref.eventNode === p.scope.queryEvent) &&
          item.candidates.some((candidate) => candidate.eventNode === p.scope.sourceEvent),
      ) ?? inspectAnchor(q, [s], p.scope.queryEvent);
    const candidate = branch?.candidates.find((item) => item.eventNode === p.scope.sourceEvent);
    const original = ix.occurrences.get(p.scope.occurrenceId);
    // Explicit anchors can inspect a source beyond the parser's initial focus.
    const base = original ?? {
      id: `authored:${p.scope.sourceId}`,
      nodeId: p.scope.nodeId,
      sourceId: p.scope.sourceId,
      required: [],
      requiredRefs: [],
      aligned: [],
      alignedRefs: [],
      open: [],
      openRefs: [],
      alternatives: [],
      context: [],
      markers: [],
      bindings: [],
      authored: true,
    };
    const derived = {
      ...base,
      ...(candidate ?? {}),
      id: base.id,
      sourceId: p.scope.sourceId,
      concept: q.labels.get(p.scope.queryEvent) ?? branch?.concept ?? '',
      sourceEventNodeId: p.scope.sourceEvent,
      required: branch?.required ?? [],
      requiredRefs: branch?.requiredRefs ?? [],
      interpretationId: p.id,
    };
    occurrences.set(derived.id, derived);
  }
  const result = { ...ix, baseIndex: ix, occurrences };
  projections.set(ix, { decisions, index: result });
  return result;
}

/** Version 1 decisions retain their stored mapping; no proposal is regenerated. */
function reviewLegacyProposal(ix, proposal) {
  const { scope, correspondence } = proposal;
  const occurrence = ix.occurrences.get(scope?.occurrenceId);
  if (
    proposal.kind !== 'local-design-correspondence-v1' ||
    !occurrence ||
    scope.recordingRevision !== interpretationRevision(ix.recording) ||
    scope.nodeId !== occurrence.nodeId ||
    scope.sourceId !== occurrence.sourceId ||
    scope.queryGraphId !== ix.recording.inquiry.graphId ||
    scope.sourceGraphId !== ix.sources.get(occurrence.sourceId)?.graphId ||
    scope.queryEvent !== occurrence.requiredRefs[0]?.eventNode ||
    scope.sourceEvent !== occurrence.sourceEventNodeId ||
    proposal.id !== `design:${digest({ scope, correspondence })}`
  )
    throw new Error('Interpretation scope changed');
  return reviewCorrespondence(
    ix.graphs.get(scope.queryGraphId),
    ix.graphs.get(scope.sourceGraphId),
    {
      queryEvent: scope.queryEvent,
      sourceEvent: scope.sourceEvent,
      binding: occurrence.bindings?.length === 1 ? occurrence.bindings[0] : null,
    },
    correspondence,
  );
}

export function interpretationStatus(proposal, decisions) {
  return (
    decisions.filter((entry) => entry.proposal.id === proposal.id).at(-1)?.decision ?? 'proposed'
  );
}

export function acceptedInterpretation(ix, occurrence, decisions) {
  if (!occurrence) return null;
  const entry = activeInterpretations(decisions)
    .filter(
      (item) =>
        item.proposal.scope.sourceId === occurrence.sourceId &&
        (item.proposal.scope.occurrenceId === occurrence.id ||
          item.proposal.scope.occurrenceId === null),
    )
    .at(-1);
  return entry
    ? {
        proposal: entry.proposal,
        review: reviewInterpretation(ix, entry.proposal),
        decisionId: entry.id,
      }
    : publishedInterpretation(ix, occurrence);
}

/** Source-scoped authored equivalences are also visible in local comparisons. */
function publishedInterpretation(ix, occurrence) {
  const knowledge = ix.answerKnowledge ?? ix.recording.knowledge;
  if (!knowledge?.mappings?.length) return null;
  const source = ix.sources.get(occurrence.sourceId),
    graph = ix.graphs.get(source?.graphId),
    query = ix.graphs.get(ix.recording.inquiry.graphId);
  if (!graph) return null;
  const context = caseSources(ix.recording, knowledge)
    .map((item) => item.text)
    .sort();
  const pairs = [],
    ids = [];
  for (const mapping of knowledge.mappings) {
    if (
      (mapping.queryRevision && mapping.queryRevision !== graphRevision(query)) ||
      (mapping.scopePlacementId &&
        mapping.scopePlacementId !== ix.recording.project?.placementId) ||
      (mapping.caseTexts?.length &&
        JSON.stringify([...mapping.caseTexts].sort()) !== JSON.stringify(context))
    )
      continue;
    const refs = mapping.sources.filter(
      (ref) =>
        ref.text === source.text &&
        (!ref.nodeId || ref.nodeId === source.nodeId) &&
        (!ref.graphRevision || ref.graphRevision === graphRevision(graph)),
    );
    if (mapping.sources.length && !refs.length) continue;
    if (
      knowledge.sourceCatalog &&
      !knowledge.sourceCatalog.some(
        (item) => item.nodeId === source.nodeId && item.text === source.text,
      )
    )
      continue;
    for (const [from, to] of [
      [mapping.from, mapping.to],
      ...(mapping.direction === 'both' ? [[mapping.to, mapping.from]] : []),
    ]) {
      const left = query.nodes.filter((node) => node.concept === to),
        right = graph.nodes.filter(
          (node) =>
            node.concept === from &&
            (!refs.length || refs.some((ref) => !ref.sourceNodeId || ref.sourceNodeId === node.id)),
        );
      if (left.length !== 1 || right.length !== 1) continue;
      const pair = {
        queryNodeId: left[0].id,
        queryConcept: to,
        sourceNodeId: right[0].id,
        sourceConcept: from,
      };
      if (
        pairs.some(
          (item) =>
            item.queryNodeId === pair.queryNodeId || item.sourceNodeId === pair.sourceNodeId,
        )
      )
        continue;
      pairs.push(pair);
      ids.push(mapping.id);
    }
  }
  if (!pairs.length) return null;
  const proposal = authorInterpretation(ix, {
    occurrenceId: occurrence.id,
    mappings: pairs,
    reusedFrom: { publicationIds: ids },
  });
  try {
    return { proposal, review: reviewInterpretation(ix, proposal), publicationIds: ids };
  } catch {
    return null;
  }
}

export function makeInterpretationDecision(
  ix,
  proposal,
  decision,
  previous = null,
  { actor = 'unrecorded', via } = {},
) {
  if (!['accepted', 'rejected', 'revoked'].includes(decision))
    throw new Error('Invalid interpretation decision');
  const review = reviewInterpretation(ix, proposal);
  if (decision === 'accepted' && !review.complete)
    throw new Error('Comparison incomplete; acceptance requires a completed review');
  return {
    schema: 'tendora.local-interpretation-decision',
    version: proposal.kind === 'local-interpretation-v2' ? 2 : 1,
    id: randomUUID(),
    previous,
    at: new Date().toISOString(),
    actor,
    ...(via ? { via } : {}),
    authentication: 'not-attested',
    decision,
    proposal,
    reason: 'Participant decision',
  };
}

const directory = (path, recording) =>
  join(dirname(path), '.interpretations', interpretationRevision(recording));
export async function loadInterpretationDecisions(path, ix) {
  const dir = directory(path, ix.recording);
  let files;
  try {
    files = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = await Promise.all(
    files
      .filter((file) => !file.startsWith('._') && file.endsWith('.json'))
      .map(async (file) => {
        const entry = JSON.parse(await readFile(join(dir, file), 'utf8'));
        if (
          entry.schema !== 'tendora.local-interpretation-decision' ||
          ![1, 2].includes(entry.version) ||
          !['accepted', 'rejected', 'revoked'].includes(entry.decision) ||
          !/^[0-9a-f-]{36}$/u.test(entry.id) ||
          !(entry.previous === null || /^[0-9a-f-]{36}$/u.test(entry.previous))
        )
          throw new Error('Invalid interpretation decision');
        reviewInterpretation(ix, entry.proposal);
        return entry;
      }),
  );
  // A single append-only chain: divergent decisions are a conflict, not last-wins.
  const ordered = [];
  let previous = null;
  while (ordered.length < entries.length) {
    const next = entries.filter((entry) => entry.previous === previous);
    if (next.length !== 1 || ordered.some((entry) => entry.id === next[0].id))
      throw new Error('Conflicting interpretation decision history');
    ordered.push(next[0]);
    previous = next[0].id;
  }
  return ordered;
}

export async function saveInterpretationDecision(
  path,
  ix,
  proposal,
  decision,
  knownDecisions,
  author,
) {
  const onDisk = JSON.parse(await readFile(path, 'utf8'));
  if (interpretationRevision(onDisk) !== interpretationRevision(ix.recording))
    throw new Error('Recording changed; reopen before deciding');
  const existing = await loadInterpretationDecisions(path, ix);
  if ((existing.at(-1)?.id ?? null) !== (knownDecisions.at(-1)?.id ?? null))
    throw new Error('Interpretation history changed; reopen the recording');
  const status = interpretationStatus(proposal, existing);
  if (decision === status) throw new Error('Decision already recorded');
  if (
    (decision === 'revoked' && status !== 'accepted') ||
    (decision === 'rejected' && status === 'accepted')
  )
    throw new Error('Invalid interpretation transition');
  const entry = makeInterpretationDecision(
    ix,
    proposal,
    decision,
    existing.at(-1)?.id ?? null,
    author,
  );
  const dir = directory(path, ix.recording);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${entry.previous ?? 'root'}.json`),
    JSON.stringify(entry, null, 2) + '\n',
    { flag: 'wx' },
  );
  return [...existing, entry];
}

/** Reports ascend recorded routes without merging source evidence or closing answers. */
export function interpretationReturns(ix, decisions, nodeId) {
  const results = [];
  for (const occurrence of projectInterpretations(ix, decisions).occurrences.values()) {
    const accepted = acceptedInterpretation(ix, occurrence, decisions);
    if (!accepted) continue;
    const { proposal } = accepted;
    const routes = ix.recording.visits
      .filter((v) =>
        occurrence.authored
          ? v.nodeId === occurrence.nodeId
          : v.occurrenceIds.includes(occurrence.id),
      )
      .map((visit) => {
        const ids = [];
        for (let item = visit; item; item = ix.visits.get(item.parentVisitId))
          ids.unshift(item.nodeId);
        return ids;
      })
      .filter((ids) => ids.includes(nodeId));
    if (!routes.length) continue;
    const review = accepted.review;
    results.push({
      proposal,
      review,
      occurrence,
      routes,
      outcome: 'open',
      assumptions: [proposal.id],
      decisionId: accepted.decisionId ?? null,
      publicationIds: accepted.publicationIds ?? [],
    });
  }
  return results;
}
