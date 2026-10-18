import { caseSupport, carriedSupport, assessCaseRelations } from '../../recording/case-support.mjs';
import { interpretationEdge } from '../../amr/interpretation.mjs';
/** Pure offline selection and presentation; no terminal or model dependency. */
import { validateRecording } from '../../recording/format.mjs';
import { compareGraphs } from '../../amr/comparison.mjs';
import {
  acceptedInterpretation,
  interpretationReturns,
  interpretedIndex,
  interpretationLabel,
  projectInterpretations,
} from '../../recording/interpretation.mjs';
import { nodeReading, proposalReading } from '../shell/wording.mjs';

const comparisons = new WeakMap();
const rankings = new WeakMap();
const noDecisions = Object.freeze([]);

/** Local material owns local actions; inherited sentences alone are not findings. */
export function selectedMaterial(ix, selection) {
  const node = ix.nodes.get(selection.nodeId),
    occurrence = ix.occurrences.get(selection.occurrenceId) ?? null;
  const sources = (occurrence ? [occurrence.sourceId] : (node?.sourceIds ?? [])).map((id) =>
    ix.sources.get(id),
  );
  const visits = ix.recording.visits.filter((visit) => visit.nodeId === node?.id);
  const sourceIds = new Set(sources.map((source) => source.id));
  const checks = carriedContext(ix, visits, occurrence?.sourceId)
    .flatMap((item) => item.checks)
    .filter((check) => sourceIds.has(check.localSourceId));
  return { node, occurrence, sources, visits, checks };
}

/** The selected comparison stays visible while its reader/editor changes. */
export function findingSummary(ix, selection, decisions = []) {
  const occurrence = ix.occurrences.get(selection.occurrenceId);
  if (!occurrence) return '';
  const links = inquiryContextLinks(ix, occurrence, decisions);
  return `${occurrence.concept} - ${links.assessment.matched} source matches${links.carriedSupport.linked ? ` - ${links.carriedSupport.linked} carried` : ''} - ${links.assessment.caseSupported} case-supported - ${links.assessment.unsupported} unmatched here${links.complete ? '' : ' - partial search'}`;
}

/** Join comparisons only through the exact edge in the selected source graph. */
export function inquiryContextLinks(ix, occurrence, decisions = noDecisions) {
  const accepted = occurrence && acceptedInterpretation(ix, occurrence, decisions);
  const effective = interpretedIndex(ix, occurrence, accepted);
  const query = effective.graphs.get(ix.recording.inquiry.graphId);
  const source = occurrence && ix.sources.get(occurrence.sourceId);
  const sourceGraph = source && effective.graphs.get(source.graphId);
  const options = occurrence && {
    queryEvent: occurrence.requiredRefs[0]?.eventNode,
    sourceEvent: occurrence.sourceEventNodeId,
  };
  const before =
    accepted?.review.before ??
    (options?.queryEvent && sourceGraph ? compareGraphs(query, sourceGraph, options) : null);
  const comparison =
    accepted?.review.after ??
    (before && occurrence.bindings?.length === 1
      ? compareGraphs(query, sourceGraph, { ...options, binding: occurrence.bindings[0] })
      : before);
  const relations = query.edges
    .filter(
      (edge) =>
        !(
          edge.role === ':polarity' &&
          query.nodes.find((node) => node.id === edge.to)?.concept === 'amr-unknown'
        ),
    )
    .map((edge, index) => {
      const pair = comparison?.shared.find((pair) => pair.queryEdge.id === edge.id);
      const original =
        pair &&
        before?.shared.some(
          (old) => old.queryEdge.id === edge.id && old.sourceEdge.id === pair.sourceEdge.id,
        );
      return {
        ref: `Q${index + 1}`,
        queryEdgeId: edge.id,
        queryLabel: interpretationEdge(query, edge),
        sourceEdgeId: pair?.sourceEdge.id ?? null,
        sourceLabel: pair ? interpretationEdge(sourceGraph, pair.sourceEdge) : null,
        status: pair
          ? 'matched'
          : !comparison
            ? 'not compared'
            : comparison.complete
              ? 'open'
              : 'unresolved',
        basis: !pair
          ? ''
          : accepted &&
              (accepted.proposal.queryEdits?.length ||
                accepted.proposal.sourceEdits?.length ||
                !original)
            ? 'accepted'
            : original
              ? 'structural'
              : 'binding',
      };
    });
  const support = caseSupport(effective, occurrence, comparison, decisions);
  const carried = carriedSupport(effective, occurrence, comparison);
  const assessment = assessCaseRelations(query, comparison, support);
  for (const relation of relations) {
    const assessed = assessment.relations.find((item) => item.edge.id === relation.queryEdgeId);
    Object.assign(relation, { status: assessed.status, caseConnections: assessed.connections });
  }
  return {
    sourceId: source?.id ?? null,
    occurrenceId: occurrence?.id ?? null,
    accepted,
    effective,
    query,
    sourceGraph,
    relations,
    assessment,
    caseSupport: support,
    carriedSupport: carried,
    complete: comparison?.complete ?? false,
    forSourceEdge(sourceId, edgeId) {
      if (sourceId !== source?.id) return [];
      const direct = relations.filter((item) => item.sourceEdgeId === edgeId);
      const connections = [...support.connections, ...carried.connections].filter(
        (item) =>
          item.sourceEdgeId === edgeId ||
          item.witnesses.some((pair) => pair.sourceEdgeId === edgeId),
      );
      const refs = new Set(connections.map((item) => item.queryEdgeId));
      return [
        ...direct,
        ...relations
          .filter(
            (item) => refs.has(item.queryEdgeId) && !direct.some((other) => other.ref === item.ref),
          )
          .map((item) => ({
            ...item,
            basis: support.connections.some(
              (connection) =>
                connection.queryEdgeId === item.queryEdgeId &&
                (connection.sourceEdgeId === edgeId ||
                  connection.witnesses.some((pair) => pair.sourceEdgeId === edgeId)),
            )
              ? 'case'
              : 'context',
          })),
      ];
    },
  };
}

/** Rank question content before answer-slot overlap; carried evidence breaks content ties. */
export function rankedFindings(ix, decisions = noDecisions) {
  const knowledge = ix.answerKnowledge ?? ix.recording.knowledge;
  if (!rankings.has(ix) || rankings.get(ix).knowledge !== knowledge)
    rankings.set(ix, { knowledge, cache: new WeakMap() });
  const cache = rankings.get(ix).cache;
  if (cache.has(decisions)) return cache.get(decisions);
  const query = ix.graphs.get(ix.recording.inquiry.graphId);
  const labels = new Map(query.nodes.map((node) => [node.id, node.concept]));
  const results = [...projectInterpretations(ix, decisions).occurrences.values()]
    .map((occurrence) => {
      const source = ix.sources.get(occurrence.sourceId);
      const queryEvent =
        occurrence.requiredRefs[0]?.eventNode ??
        query.nodes.find((node) => node.concept === occurrence.concept)?.id;
      const interpretation = acceptedInterpretation(ix, occurrence, decisions);
      const comparison =
        interpretation?.review.after ??
        compareGraphs(query, ix.graphs.get(source.graphId), {
          queryEvent,
          sourceEvent: occurrence.sourceEventNodeId,
          binding: occurrence.bindings?.length === 1 ? occurrence.bindings[0] : null,
        });
      const effective = interpretedIndex(ix, occurrence, interpretation);
      const effectiveQuery = effective.graphs.get(ix.recording.inquiry.graphId);
      const support = caseSupport(effective, occurrence, comparison, decisions);
      const carried = carriedSupport(effective, occurrence, comparison);
      const assessment = assessCaseRelations(effectiveQuery, comparison, support);
      const unknowns = new Set(
        effectiveQuery.nodes
          .filter((node) => node.concept === 'amr-unknown')
          .map((node) => node.id),
      );
      const answerEdge = (edge) => unknowns.has(edge.from) || unknowns.has(edge.to);
      const contentSupport = assessment.relations.filter(
        (item) => ['matched', 'case-supported'].includes(item.status) && !answerEdge(item.edge),
      ).length;
      const answerMatched = assessment.relations.filter(
        (item) => item.status === 'matched' && answerEdge(item.edge),
      ).length;
      const caseLinked = assessment.caseSupported;
      const shared = comparison.shared.filter(
        (pair) =>
          !(pair.queryEdge.role === ':polarity' && labels.get(pair.queryEdge.to) === 'amr-unknown'),
      );
      const direct = shared.filter(
        ({ queryEdge: edge }) => edge.from === queryEvent || edge.to === queryEvent,
      ).length;
      const visit = ix.recording.visits.find((item) =>
        occurrence.authored
          ? item.nodeId === occurrence.nodeId
          : item.occurrenceIds.includes(occurrence.id),
      );
      const route = [];
      for (let item = visit; item; item = ix.visits.get(item.parentVisitId))
        route.unshift(ix.nodes.get(item.nodeId).label);
      return {
        id: occurrence.id,
        nodeId: occurrence.nodeId,
        occurrence,
        route,
        path: route.join(' → '),
        assumptions: interpretation ? [interpretation.proposal.id] : [],
        interpretationState: interpretation
          ? interpretation.publicationIds?.length
            ? 'applied'
            : 'accepted'
          : null,
        contentSupport,
        answerMatched,
        caseLinked,
        caseSupport: support,
        carried: carried.linked,
        carriedSupport: carried,
        direct,
        shared: shared.length,
        matched: assessment.matched,
        unresolved: assessment.unsupported,
        complete: comparison.complete,
        affinity: source.affinity ?? -1,
      };
    })
    .sort(
      (a, b) =>
        b.contentSupport - a.contentSupport ||
        b.caseLinked - a.caseLinked ||
        b.carried - a.carried ||
        b.shared - a.shared ||
        b.direct - a.direct ||
        a.unresolved - b.unresolved ||
        b.affinity - a.affinity ||
        a.id.localeCompare(b.id),
    );
  cache.set(decisions, results);
  return results;
}

/** Distinguish same-concept occurrences using their actual local attachments. */
export function occurrenceRelations(ix, occurrence) {
  if (!occurrence) return [];
  const graph = ix.graphs.get(ix.sources.get(occurrence.sourceId)?.graphId);
  if (!graph) return [];
  const label = (id) =>
    graph.nodes
      .find((n) => n.id === id)
      ?.concept.replace(/-\d+$/u, '')
      .replaceAll('-', ' ') ?? id;
  const event = occurrence.sourceEventNodeId;
  const outgoing = graph.edges.filter((e) => e.from === event);
  const edges = outgoing.length ? outgoing : graph.edges.filter((e) => e.to === event);
  return edges.map((e) => {
    const concept = graph.nodes.find((n) => n.id === e.from)?.concept;
    const role = e.role;
    const target = graph.nodes.find((n) => n.id === e.to)?.concept;
    const members = ['and', 'or'].includes(target)
      ? graph.edges.filter((edge) => edge.from === e.to && /^:op\d+$/u.test(edge.role))
      : [];
    const destination = members.length
      ? members.map((edge) => label(edge.to)).join(` ${target} `)
      : label(e.to);
    return `${label(e.from)} ${role} → ${destination} [${event}]`;
  });
}

/** One edge per row, under a single consistent node mapping. No path expansion. */
export function relationComparison(ix, occurrence) {
  if (!occurrence) return [];
  if (!comparisons.has(ix)) comparisons.set(ix, new Map());
  const cache = comparisons.get(ix);
  if (cache.has(occurrence.id)) return cache.get(occurrence.id);
  const query = ix.graphs.get(ix.recording.inquiry.graphId);
  const sourceRecord = ix.sources.get(occurrence.sourceId);
  const source = ix.graphs.get(sourceRecord.graphId);
  const sameConcept = query.nodes.filter((node) => node.concept === occurrence.concept);
  const options = {
    queryEvent:
      occurrence.requiredRefs[0]?.eventNode ??
      (sameConcept.length === 1 ? sameConcept[0].id : null),
    sourceEvent: occurrence.sourceEventNodeId,
  };
  if (!options.queryEvent) return [];
  const before = compareGraphs(query, source, options);
  // Several candidates are kept separate in the technical view, never merged.
  const binding = occurrence.bindings?.length === 1 ? occurrence.bindings[0] : null;
  const after = binding ? compareGraphs(query, source, { ...options, binding }) : before;
  const previous = new Set(before.shared.map((pair) => pair.queryEdge.id));
  const current = new Set(after.shared.map((pair) => pair.queryEdge.id));
  const highlights = binding ? bindingHighlights(ix, occurrence) : [];
  const concepts = [...query.nodes, ...source.nodes].map((node) => node.concept);
  function label(graph, id, side) {
    const node = graph.nodes.find((item) => item.id === id);
    const mark = highlights.find((item) => item[`${side}NodeId`] === id);
    const span = mark?.[`${side}Span`];
    const text = side === 'query' ? ix.recording.inquiry.text : sourceRecord.text;
    const wording = span ?? sourceWording(graph, id, text);
    const fallback =
      node.concept === 'amr-unknown'
        ? 'unknown'
        : node.concept === '-'
          ? 'negative'
          : node.concept.replace(/-\d+$/u, '').replaceAll('-', ' ');
    const duplicate = graph.nodes.filter((item) => item.concept === node.concept).length > 1;
    const ambiguous = concepts.some(
      (concept) =>
        concept !== node.concept &&
        concept.replace(/-\d+$/u, '') === node.concept.replace(/-\d+$/u, ''),
    );
    return {
      text:
        (wording
          ? text.slice(wording.start, wording.end)
          : fallback + (duplicate ? ` [${id}]` : '')) + (ambiguous ? ` [${node.concept}]` : ''),
      color: mark?.color,
    };
  }
  function line(graph, edge, side) {
    const from = label(graph, edge.from, side),
      to = label(graph, edge.to, side);
    const concept = graph.nodes.find((node) => node.id === edge.from).concept;
    const role =
      {
        ':polarity': 'polarity',
        ':time': 'time',
        ':manner': 'manner',
        ':mod': 'modifier',
        ':name': 'name',
      }[edge.role] ?? (/^:op\d+$/u.test(edge.role) ? `member ${edge.role.slice(3)}` : edge.role);
    const prefix = `${from.text} ${role} → `;
    return {
      text: prefix + to.text,
      ...(side === 'source' ? { sourceEdgeId: edge.id } : {}),
      spans: [
        ...(from.color !== undefined
          ? [{ start: 0, end: from.text.length, color: from.color }]
          : []),
        ...(to.color !== undefined
          ? [{ start: prefix.length, end: prefix.length + to.text.length, color: to.color }]
          : []),
      ],
    };
  }
  const assessment = assessCaseRelations(query, after, caseSupport(ix, occurrence, after));
  const retained = after.shared.filter((pair) => previous.has(pair.queryEdge.id));
  const added = after.shared.filter((pair) => !previous.has(pair.queryEdge.id));
  const lost = before.shared.filter((pair) => !current.has(pair.queryEdge.id));
  const groups = [
    {
      title: 'Shared relations',
      tone: 'located',
      lines: retained.map((pair) => line(source, pair.sourceEdge, 'source')),
    },
    ...(binding
      ? [
          {
            title: 'Added by proposed binding',
            tone: 'located',
            lines: added.map((pair) => line(source, pair.sourceEdge, 'source')),
          },
        ]
      : []),
    ...(lost.length
      ? [
          {
            title: 'Mapping restriction - one-to-one',
            tone: 'warning',
            lines: [...lost.map((pair) => line(query, pair.queryEdge, 'query'))],
          },
        ]
      : []),
    ...(assessment.caseSupported
      ? [
          {
            title: 'Case-supported relations',
            tone: 'located',
            lines: assessment.relations
              .filter((item) => item.status === 'case-supported')
              .map((item) => ({
                ...line(query, item.edge, 'query'),
                text: interpretationEdge(query, item.edge),
              })),
          },
        ]
      : []),
    {
      title: 'Open inquiry relations',
      tone: 'open',
      lines: assessment.relations
        .filter((item) => ['open', 'unresolved'].includes(item.status))
        .map((item) => line(query, item.edge, 'query')),
    },
    {
      title: 'Unmatched source relations',
      tone: 'plain',
      lines: after.sourceOnly.map((edge) => line(source, edge, 'source')),
    },
    {
      title: 'Graph comparison',
      tone: 'muted',
      lines: [
        {
          text: `${before.complete && after.complete ? 'Exact constrained overlap' : 'Search limit reached (partial overlap)'}; event fixed${binding ? '; binding fixed' : ''}`,
        },
        { text: 'Answer: open' },
      ],
    },
  ];
  cache.set(occurrence.id, groups);
  return groups;
}

export function carriedContext(ix, visits, localSourceId = null) {
  if (!ix.recording.caseState) return [];
  const inherited = new Map();
  for (const visit of visits) {
    const chain = [];
    for (
      let parent = ix.visits.get(visit.parentVisitId);
      parent;
      parent = ix.visits.get(parent.parentVisitId)
    )
      chain.unshift(parent);
    const root = ix.recording.caseState.rootNodeId;
    if (
      ix.recording.caseState.policy === 'selected-context-v2' &&
      visit.nodeId !== root &&
      !chain.some((item) => item.nodeId === root)
    )
      chain.unshift({ nodeId: root });
    for (const parent of chain) {
      const node = ix.nodes.get(parent.nodeId);
      for (const id of node.sourceIds) {
        if (!inherited.has(id))
          inherited.set(id, {
            source: ix.sources.get(id),
            node,
            kind:
              node.id === ix.recording.caseState.rootNodeId ? 'Case state' : 'Inherited context',
            checks: [],
          });
        const item = inherited.get(id);
        for (const check of visit.contextChecks ?? []) {
          if (
            check.inheritedSourceId === id &&
            (!localSourceId || check.localSourceId === localSourceId) &&
            !item.checks.some((old) => JSON.stringify(old) === JSON.stringify(check))
          )
            item.checks.push(check);
        }
      }
    }
  }
  return [...inherited.values()];
}

/** Collapse repeated query associations to the same source path within one event. */
export function sourceAlternatives(occurrence) {
  const seen = new Set();
  return (occurrence?.alternatives ?? []).filter((alternative) => {
    const key = JSON.stringify([
      alternative.observed,
      alternative.sourceNodeIds,
      alternative.sourceEdgeIds,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
function uniqueWording(text, phrases) {
  const spans = new Map();
  for (const phrase of phrases) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapePattern(phrase).replaceAll(' ', '\\s+')}(?![\\p{L}\\p{N}_])`,
      'giu',
    );
    for (const match of text.matchAll(pattern))
      spans.set(`${match.index}:${match[0].length}`, {
        start: match.index,
        end: match.index + match[0].length,
      });
  }
  return spans.size === 1 ? [...spans.values()][0] : null;
}

// Conservative display anchors, not new evidence: explicit spellings, names,
// and conjunctions only. Repeated words/nodes and unsupported forms stay unmarked.
function sourceWording(graph, id, text, seen = new Set()) {
  if (seen.has(id)) return null;
  const concept = graph.nodes.find((node) => node.id === id)?.concept;
  if (!concept) return null;
  const next = new Set([...seen, id]);
  const edges = graph.edges.filter((edge) => edge.from === id);
  const label = (node) => graph.nodes.find((item) => item.id === node)?.concept;
  if (concept === 'and' || concept === 'or') {
    const members = edges
      .filter((edge) => /^:op\d+$/u.test(edge.role))
      .sort((a, b) => Number(a.role.slice(3)) - Number(b.role.slice(3)));
    if (members.length < 2) return null;
    const spans = members.map((edge) => sourceWording(graph, edge.to, text, next));
    if (spans.some((span) => !span)) return null;
    for (let i = 1; i < spans.length; i++) {
      if (spans[i - 1].end >= spans[i].start) return null;
      const separator = text
        .slice(spans[i - 1].end, spans[i].start)
        .trim()
        .toLowerCase();
      if (
        i === spans.length - 1 ? ![concept, `, ${concept}`].includes(separator) : separator !== ','
      )
        return null;
    }
    return { start: spans[0].start, end: spans.at(-1).end };
  }
  const named = edges.find((edge) => edge.role === ':name');
  if (named) {
    const words = graph.edges
      .filter((edge) => edge.from === named.to && /^:op\d+$/u.test(edge.role))
      .sort((a, b) => Number(a.role.slice(3)) - Number(b.role.slice(3)))
      .map((edge) => label(edge.to)?.replace(/^"|"$/gu, ''));
    if (
      graph.edges.filter((edge) => edge.role === ':name' && edge.to === named.to).length !== 1 ||
      words.some(
        (word) =>
          graph.nodes.filter((node) => node.concept.replace(/^"|"$/gu, '') === word).length !== 1,
      )
    )
      return null;
    return words.length && words.every(Boolean) ? uniqueWording(text, [words.join(' ')]) : null;
  }
  if (graph.nodes.filter((node) => node.concept === concept).length !== 1) return null;
  const alignment = graph.alignments?.find((entry) => entry.nodeId === id);
  if (
    alignment &&
    Number.isInteger(alignment.start) &&
    Number.isInteger(alignment.end) &&
    alignment.start >= 0 &&
    alignment.end > alignment.start &&
    alignment.end <= text.length &&
    typeof alignment.text === 'string' &&
    text.slice(alignment.start, alignment.end) === alignment.text
  )
    return { start: alignment.start, end: alignment.end };
  return uniqueWording(text, [
    concept.replace(/-\d+$/u, '').replaceAll('-', ' ').replace(/^"|"$/gu, ''),
  ]);
}

export function bindingHighlights(ix, occurrence) {
  if (!occurrence?.bindings?.length) return [];
  const source = ix.sources.get(occurrence.sourceId),
    graph = ix.graphs.get(source.graphId);
  const unknowns = ix.graphs
    .get(ix.recording.inquiry.graphId)
    .nodes.filter((node) => node.concept === 'amr-unknown');
  const questionSpan =
    unknowns.length === 1 ? uniqueWording(ix.recording.inquiry.text, ['what', 'who']) : null;
  return occurrence.bindings.map((binding) => ({
    queryNodeId: binding.queryNodeId,
    sourceNodeId: binding.sourceNodeId,
    color: unknowns.findIndex((node) => node.id === binding.queryNodeId),
    querySpan: questionSpan,
    sourceSpan: sourceWording(graph, binding.sourceNodeId, source.text),
  }));
}

export function sliceHighlights(spans = [], start, end, padding = 0) {
  return spans
    .filter((span) => span.end > start && span.start < end)
    .map((span) => ({
      ...span,
      start: Math.max(start, span.start) - start + padding,
      end: Math.min(end, span.end) - start + padding,
    }));
}

export function bindingPresentation(occurrence, ix) {
  const previous = new Set(occurrence?.alignedRefs.map((ref) => ref.queryPathId) ?? []);
  const highlights = ix ? bindingHighlights(ix, occurrence) : [];
  return (occurrence?.bindings ?? []).map((binding, index) => {
    const located = new Set(binding.locatedRefs.map((ref) => ref.queryPathId));
    const open = new Set(binding.openRefs);
    const mark = highlights[index];
    const question = mark?.querySpan
      ? ix.recording.inquiry.text.slice(mark.querySpan.start, mark.querySpan.end)
      : ix
        ? nodeReading(
            ix.graphs.get(ix.recording.inquiry.graphId),
            binding.queryNodeId,
            ix.recording.inquiry.text,
          ).label
        : binding.queryNodeId;
    const source = mark?.sourceSpan
      ? ix.sources.get(occurrence.sourceId).text.slice(mark.sourceSpan.start, mark.sourceSpan.end)
      : ix
        ? nodeReading(
            ix.graphs.get(ix.sources.get(occurrence.sourceId).graphId),
            binding.sourceNodeId,
            ix.sources.get(occurrence.sourceId).text,
          ).label
        : binding.sourceNodeId;
    const caption = `${question} → ${source}`;
    const spans = [
      ...(mark?.querySpan ? [{ start: 0, end: question.length, color: mark.color }] : []),
      ...(mark?.sourceSpan
        ? [{ start: question.length + 3, end: caption.length, color: mark.color }]
        : []),
    ];
    return {
      concept: binding.concept,
      caption,
      spans,
      before: previous.size,
      added: [...located].filter((id) => !previous.has(id)).length,
      lost: [...previous].filter((id) => !located.has(id)).length,
      open: open.size,
    };
  });
}

/** Exact graph references only: recordings do not yet carry word alignments. */
export function bindingSummary(occurrence, ix) {
  return bindingPresentation(occurrence, ix).flatMap((item) => [
    item.caption,
    `Already matched: ${item.before} ${item.before === 1 ? 'path' : 'paths'}`,
    `Added by binding: ${item.added} ${item.added === 1 ? 'path' : 'paths'}`,
    ...(item.lost ? [`No longer matched: ${item.lost}`] : []),
    `Still unmatched: ${item.open} ${item.open === 1 ? 'path' : 'paths'}`,
    'Scope: unchecked',
  ]);
}

function bindingDetails(occurrence, ix) {
  return (occurrence?.bindings ?? []).flatMap((binding) => {
    const located = new Set(binding.locatedRefs.map((ref) => ref.queryPathId));
    const previous = new Set(occurrence.alignedRefs.map((ref) => ref.queryPathId));
    return [
      'BOUND PATH CHECKS',
      ...(occurrence.bindings.length > 1
        ? [bindingPresentation({ ...occurrence, bindings: [binding] }, ix)[0].caption]
        : []),
      ...occurrence.requiredRefs.map(
        (path) =>
          `BOUND ${located.has(path.id) ? '=' : '?'} ${path.text}${
            located.has(path.id) && !previous.has(path.id)
              ? ' (added by binding)'
              : !located.has(path.id) && previous.has(path.id)
                ? ' (no longer matched)'
                : ''
          }`,
      ),
    ];
  });
}

function sourceAmr(response) {
  if (response.penman) return [response.penman];
  const lines = (response.decode_error ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const reason = [...new Set([lines[0], lines.at(-1)].filter(Boolean))].join('; ');
  return [
    'AMR parsing failed',
    `Parser reason: ${reason || 'No decoding reason was recorded.'}`,
    'Graph unavailable',
  ];
}

export function indexRecording(recording) {
  validateRecording(recording);
  const table = (name) => new Map(recording[name].map((item) => [item.id, item]));
  return {
    recording,
    failedSources: recording.sources.filter((source) => !source.graphId),
    nodes: table('nodes'),
    visits: table('visits'),
    occurrences: table('occurrences'),
    sources: table('sources'),
    openings: table('openings'),
    proposals: table('proposals'),
    graphs: table('graphs'),
    amrs: table('amrs'),
    saliences: table('saliences'),
    mappings: table('mappings'),
    groups: table('neighborhoods'),
    cycles: table('cycleStops'),
  };
}

const nodeVisits = (ix, nodeId) => ix.recording.visits.filter((visit) => visit.nodeId === nodeId);
const nodeOccurrences = (ix, nodeId, visitId = null) => {
  const ids = visitId ? new Set(ix.visits.get(visitId)?.occurrenceIds ?? []) : null;
  return [...ix.occurrences.values()].filter(
    (item) => item.nodeId === nodeId && (!ids || ids.has(item.id)),
  );
};
export function navigable(ix, nodeId) {
  const node = ix.nodes.get(nodeId);
  const group = ix.groups.get(node.groupId);
  // Project captures have one recorded branch. Keep its list stable while
  // browsing: selecting a leaf must not remove its siblings from navigation.
  if (ix.recording.routing?.policy === 'local-then-ranked-children-v1') {
    const ids = [
      ...new Set([
        ...ix.recording.visits.map((visit) => visit.nodeId),
        ...ix.recording.nodes.map((item) => item.id),
      ]),
    ];
    return { group, siblings: ids, outgoing: [], incoming: [], ids };
  }
  const siblings = group?.nodeIds ?? [nodeId];
  const outside = (ids) => ids.filter((id) => !siblings.includes(id));
  const outgoing = outside(node.crossingIds);
  const incoming = outside(
    ix.recording.nodes.filter((item) => item.crossingIds.includes(nodeId)).map((item) => item.id),
  );
  return {
    group,
    siblings,
    outgoing,
    incoming,
    ids: [...new Set([...siblings, ...outgoing, ...incoming])],
  };
}
const first = (items) => items[0]?.id ?? null;
export function initialSelection(ix) {
  const nodeId = ix.visits.get(ix.recording.rootVisitId).nodeId;
  return {
    nodeId,
    visitId: ix.recording.rootVisitId,
    occurrenceId: first(nodeOccurrences(ix, nodeId, ix.recording.rootVisitId)),
    pane: 'neighborhood',
    detail: 'mapping',
  };
}
export function selectNode(ix, state, nodeId) {
  if (!ix.nodes.has(nodeId)) throw new Error(`unknown node ${nodeId}`);
  return { ...state, nodeId, visitId: null, occurrenceId: first(nodeOccurrences(ix, nodeId)) };
}
export function cycleNode(ix, state, change) {
  const { ids } = navigable(ix, state.nodeId);
  const at = ids.indexOf(state.nodeId);
  return selectNode(ix, state, ids[(at + change + ids.length) % ids.length]);
}
export function cycleOccurrence(ix, state, change = 1) {
  const occurrences = nodeOccurrences(ix, state.nodeId, state.visitId);
  if (!occurrences.length) return state;
  const at = occurrences.findIndex((item) => item.id === state.occurrenceId);
  return {
    ...state,
    occurrenceId: occurrences[(at + change + occurrences.length) % occurrences.length].id,
  };
}

export function pathLabel(path) {
  const root = path.text.split(' ')[0];
  if (!path.steps.length) return root;
  const endpoint = path.steps.at(-1).concept;
  const firstStep = path.steps[0];
  if (
    path.steps.length === 3 &&
    path.steps.at(-1).role === ':op1' &&
    path.steps.at(-2).role === ':name'
  ) {
    return `${root} ${firstStep.direction === 'out' ? '─' : '←'}${firstStep.role}${firstStep.direction === 'out' ? '→' : '─'} ${endpoint}`;
  }
  return `${root} ${path.steps.map((step) => `${step.direction === 'out' ? '─' : '←'}${step.role}${step.direction === 'out' ? '→' : '─'} ${step.concept}`).join(' ')}`;
}

function mappingLabel(mapping, paths) {
  const status = mapping.status ?? 'matched'; // v1 recordings predate explicit status
  if (status === 'matched')
    return `${pathLabel(paths.find((path) => path.id === mapping.queryPathId))} [selector matched]`;
  return `selector ${mapping.authoredSelector.event} / ${mapping.authoredSelector.roles.join(' → ')} [${status}: no unique path]`;
}

function alternativeLabel(ix, source, alternative, paths) {
  const graph = ix.graphs.get(source.graphId);
  const endpoint =
    graph.nodes.find((node) => node.id === alternative.sourceNodeIds.at(-1))?.concept ?? '?';
  const expected = paths.find((path) => path.id === alternative.expectedPathId);
  return `≠ ${pathLabel(expected)}; same-role source alternative ${endpoint}`;
}

function status(ix, node, visits, occurrences) {
  if (!node.sourceIds.length) return 'unavailable (no source authored)';
  if (!visits.length) return 'unvisited (no recorded crossing)';
  if (visits.every((visit) => visit.validSourceCount === 0))
    return 'invalid parse (no valid source graph)';
  if (!occurrences.length)
    return visits.some((visit) => visit.unchanged)
      ? 'visited unchanged (no same-concept event)'
      : 'visited (no matching occurrence)';
  return `visited (${visits.length} visit(s), ${occurrences.length} source occurrence(s))`;
}

function history(ix, visit, limit = 4) {
  const result = [],
    seen = new Set();
  let item = visit;
  for (
    ;
    item && !seen.has(item.id) && result.length < limit;
    item = ix.visits.get(item.parentVisitId)
  ) {
    seen.add(item.id);
    result.push(ix.nodes.get(item.nodeId).label);
  }
  return `${item ? '… → ' : ''}${result.reverse().join(' → ')}`;
}

export function visitSummary(ix, visit, separator = '\n') {
  const onward = visit.return.childVisitIds.map(
    (id) => ix.nodes.get(ix.visits.get(id).nodeId).label,
  );
  const stops = visit.return.cycleStopIds.map(
    (id) =>
      `return to ${ix.nodes.get(ix.cycles.get(id).targetNodeId).label} stopped (already on this route)`,
  );
  return [
    history(ix, visit),
    ...(onward.length ? [`continued to ${onward.join(', ')}`] : []),
    ...stops,
  ].join(separator);
}

export function visitRouteLines(ix, visit) {
  return [
    history(ix, visit, Infinity),
    ...visit.return.childVisitIds.map((id) => `↳ ${ix.nodes.get(ix.visits.get(id).nodeId).label}`),
    ...visit.return.cycleStopIds.map(
      (id) => `↺ ${ix.nodes.get(ix.cycles.get(id).targetNodeId).label}`,
    ),
  ];
}

export function routePresentation(ix, visits) {
  let text = '';
  const selectedSpans = [];
  for (const visit of visits) {
    if (text) text += '   |   ';
    const lines = visitRouteLines(ix, visit);
    const end = text.length + lines[0].length;
    selectedSpans.push({ start: end - ix.nodes.get(visit.nodeId).label.length, end });
    text += lines.join('   ');
  }
  return { text, selectedSpans };
}

export function viewModel(ix, selection) {
  const { recording } = ix;
  const node = ix.nodes.get(selection.nodeId);
  if (!node) throw new Error(`unknown selected node ${selection.nodeId}`);
  const { group, siblings, outgoing, incoming: incomingOutside } = navigable(ix, node.id);
  const visits = nodeVisits(ix, node.id),
    occurrences = nodeOccurrences(ix, node.id, selection.visitId);
  const visit = ix.visits.get(selection.visitId) ?? null;
  if (visit && visit.nodeId !== node.id) throw new Error('visit belongs to another node');
  const occurrence = ix.occurrences.get(selection.occurrenceId) ?? null;
  if (occurrence && occurrence.nodeId !== node.id)
    throw new Error('occurrence belongs to another node');
  if (occurrence && visit && !visit.occurrenceIds.includes(occurrence.id))
    throw new Error('occurrence belongs to another visit');
  const source = occurrence ? ix.sources.get(occurrence.sourceId) : null;
  const paths = recording.inquiry.obligation.branches.flatMap((branch) => branch.requiredRefs);
  const selectedMappings = recording.mappings.filter(
    (mapping) => ix.saliences.get(mapping.salienceId)?.nodeId === node.id,
  );
  const neighborhoodMappings = recording.mappings.filter((mapping) =>
    (group?.nodeIds ?? [node.id]).includes(ix.saliences.get(mapping.salienceId)?.nodeId),
  );
  const saliences = node.salienceIds.map((id) => ix.saliences.get(id));
  const neighbors = new Set(node.crossingIds);
  const incoming = recording.nodes.filter((candidate) => candidate.crossingIds.includes(node.id));
  const linkedLine = (id, kind) => {
    const item = ix.nodes.get(id);
    const otherGroup = ix.groups.get(item.groupId)?.label ?? '(no authored group)';
    return (
      `  ${item.label} [${id}] - ${kind} - group ${otherGroup}\n` +
      `    ${
        item.salienceIds.map((salienceId) => ix.saliences.get(salienceId)?.question).join('; ') ||
        '(no authored salience)'
      }`
    );
  };
  const neighborhood = [
    `GROUP ${group?.label ?? '(no authored group)'}`,
    ...siblings.map((id) => {
      const item = ix.nodes.get(id);
      const kinds = [
        id === node.id ? 'current' : null,
        neighbors.has(id) ? 'outgoing' : null,
        incoming.some((other) => other.id === id) ? 'incoming' : null,
      ].filter(Boolean);
      const itemSaliences = item.salienceIds.map(
        (salienceId) => ix.saliences.get(salienceId)?.question,
      );
      return (
        `${id === node.id ? '▶' : ' '} ${item.label} [${id}] ${kinds.length ? `(${kinds.join(', ')})` : ''}\n` +
        `    ${itemSaliences.length ? itemSaliences.join('; ') : '(no authored salience)'}`
      );
    }),
    ...(outgoing.length
      ? [
          'OUTGOING CROSSINGS - browse only',
          ...outgoing.map((id) => linkedLine(id, 'authored crossing')),
        ]
      : []),
    ...(incomingOutside.filter((id) => !outgoing.includes(id)).length
      ? [
          'INCOMING CROSSINGS - browse only',
          ...incomingOutside
            .filter((id) => !outgoing.includes(id))
            .map((id) => linkedLine(id, 'incoming crossing')),
        ]
      : []),
    `AUTHORED CROSSINGS ${node.crossingIds.length ? node.crossingIds.join(', ') : '(none)'} (arrows browse, never execute)`,
  ];
  const aligned = new Set(occurrence?.alignedRefs.map((ref) => ref.queryPathId) ?? []);
  const open = new Set(occurrence?.openRefs ?? []);
  const inquiry = [
    recording.inquiry.text,
    `Interpretation: ${recording.inquiry.interpretationId}`,
    `Retention: ${recording.inquiry.retention}`,
    ...paths.map(
      (path) => `${aligned.has(path.id) ? '=' : open.has(path.id) ? '?' : '-'} ${pathLabel(path)}`,
    ),
    ...(recording.inquiry.obligation.parentContext.length
      ? [`! shared scope open: ${recording.inquiry.obligation.parentContext.join('; ')}`]
      : ['! whole-question scope open']),
    ...(neighborhoodMappings.length ? ['MAPPINGS'] : []),
    ...neighborhoodMappings.map((mapping) => {
      const atNode = ix.saliences.get(mapping.salienceId).nodeId;
      return `${atNode} → ${mappingLabel(mapping, paths)} [${mapping.id}]`;
    }),
  ];
  const local = [
    `Concept: ${node.label}`,
    `State: ${status(ix, node, visits, occurrences)}`,
    `visit ${visit ? history(ix, visit) : '(all recorded routes)'}`,
    `occurrence ${occurrence ? `${occurrence.id} (${occurrences.indexOf(occurrence) + 1}/${occurrences.length})` : '(none)'}`,
    ...(source
      ? [
          `SOURCE ${source.text}`,
          `Source graph: ${source.graphId}`,
          Number.isFinite(source.affinity)
            ? `Embedding cosine: ${source.affinity.toFixed(3)} (source inspection order)`
            : 'Inspection order: authored scope; retained AMRs',
        ]
      : node.sourceIds.map((id) => {
          const item = ix.sources.get(id);
          return `SOURCE ${id} ${item.graphId ? '(parsed)' : '(invalid parse)'}: ${item.text}`;
        })),
    ...(occurrence
      ? [
          ...paths.map(
            (path) =>
              `${aligned.has(path.id) ? '=' : open.has(path.id) ? '?' : '-'} ${pathLabel(path)}`,
          ),
          ...occurrence.alternatives.map((alt) => alternativeLabel(ix, source, alt, paths)),
          occurrence.openRefs.length
            ? 'Unlocated relations remain in carry.'
            : 'All listed local paths located on this event; question still open.',
        ]
      : [visits.length ? 'No source occurrence at this node.' : 'No recorded local finding.']),
    ...(visit?.unchanged ? ['Return: unchanged uncertainty.'] : []),
    ...(occurrence?.bindings?.length
      ? ['CANDIDATE BINDING', ...bindingSummary(occurrence, ix)]
      : []),
    ...(visit ? [visitSummary(ix, visit)] : []),
  ];
  const detail =
    selection.detail === 'scope'
      ? [
          ...(source
            ? [
                `SOURCE ${source.text}`,
                '',
                ...ix.graphs
                  .get(source.graphId)
                  .edges.map((edge) => interpretationEdge(ix.graphs.get(source.graphId), edge)),
              ]
            : ['No matching source event selected.']),
        ]
      : selection.detail === 'source'
        ? [
            'QUERY AMR',
            ix.amrs.get(recording.inquiry.amrId).response.penman,
            ...(source
              ? [
                  `SOURCE ${source.text}`,
                  ...(occurrence?.bindings?.length
                    ? [
                        'CANDIDATE BINDING',
                        ...bindingPresentation(occurrence, ix).map((item) => item.caption),
                      ]
                    : []),
                  'AMR',
                  ...sourceAmr(ix.amrs.get(source.amrId).response),
                ]
              : node.sourceIds.flatMap((id) => {
                  const item = ix.sources.get(id),
                    amr = ix.amrs.get(item.amrId);
                  return [`SOURCE ${item.text}`, 'AMR', ...sourceAmr(amr.response)];
                })),
            ...(occurrence
              ? [
                  ...(occurrence.bindings?.length
                    ? bindingDetails(occurrence, ix)
                    : occurrence.requiredRefs.map(
                        (path) => `${aligned.has(path.id) ? '=' : '?'} ${path.text}`,
                      )),
                  ...sourceAlternatives(occurrence).map(
                    (alt) => `ALTERNATIVE ${alt.observed} [${alt.sourceEdgeIds.join(', ')}]`,
                  ),
                ]
              : []),
          ]
        : selection.detail === 'provenance'
          ? provenanceSections(ix, { node, occurrence }).flatMap(([title, lines]) => [
              title,
              ...lines.map((line) => `  ${line}`),
              '',
            ])
          : selection.detail === 'proposal'
            ? [
                ...(visit?.proposalIds.map((id) => {
                  const item = ix.proposals.get(id);
                  return `${item.status}: ${item.patch.from} → ${item.patch.to}; ${item.english}`;
                }) ?? []),
                ...visits
                  .filter((item) => item.id !== visit?.id)
                  .flatMap((item) =>
                    item.proposalIds.map((id) => {
                      const proposal = ix.proposals.get(id);
                      return `${item.id} ${proposal.status}: ${proposal.patch.from} → ${proposal.patch.to}; ${proposal.english}`;
                    }),
                  ),
              ]
            : [
                ...saliences.map(
                  (item) =>
                    `${item.id}: ${item.question} — ${item.purpose} (${item.attribution.author})`,
                ),
                ...selectedMappings.map(
                  (item) =>
                    `${item.id} → ${mappingLabel(item, paths)}\n` +
                    `    ${item.reason ? `${item.reason} ` : ''}${item.rationale} (${item.attribution.author})` +
                    (item.candidatePathIds?.length
                      ? `\n    Candidate paths: ${item.candidatePathIds.join(', ')}`
                      : ''),
                ),
              ];
  return {
    node,
    visit,
    occurrence,
    group,
    paths,
    neighborhood,
    inquiry,
    local,
    detail,
    selection,
    visits,
    occurrences,
    status: status(ix, node, visits, occurrences),
  };
}

export function conditionalReturnSections(ix, decisions, nodeId) {
  return interpretationReturns(ix, decisions, nodeId).flatMap((item) => {
    const applied = item.publicationIds.length > 0;
    const scope = item.proposal.scope;
    const query = item.review.query ?? ix.graphs.get(scope.queryGraphId);
    const source = item.review.source ?? ix.graphs.get(scope.sourceGraphId);
    const added = new Set(item.review.added.map((edge) => edge.id));
    const assessment = assessCaseRelations(
      query,
      item.review.after,
      caseSupport(
        interpretedIndex(ix, item.occurrence, item),
        item.occurrence,
        item.review.after,
        decisions,
      ),
    );
    const unsupported = assessment.relations.filter((relation) =>
      ['open', 'unresolved'].includes(relation.status),
    );
    const supported = assessment.relations.filter(
      (relation) => relation.status === 'case-supported',
    );
    return [
      [
        `Conditional return - ${applied ? 'applied' : 'accepted'} interpretation`,
        [
          ix.recording.inquiry.text,
          `Source statement: ${ix.sources.get(scope.sourceId).text}`,
          `Matched: ${applied ? '' : `${item.review.beforeCount} → `}${item.review.afterCount}   Case-supported: ${assessment.caseSupported}   Open: ${assessment.unsupported}`,
        ],
      ],
      ['Where', item.routes.map((ids) => ids.map((id) => ix.nodes.get(id).label).join(' → '))],
      [
        applied ? 'Applied interpretation' : 'Accepted assumption',
        [
          proposalReading(item.proposal, {
            query,
            source,
            queryText: ix.recording.inquiry.text,
            sourceText: ix.sources.get(scope.sourceId).text,
            caseLabel: ix.nodes.get(ix.recording.caseState?.rootNodeId)?.label,
          }),
        ],
      ],
      [
        'Matched relations from this source',
        item.review.after.shared.map(
          ({ queryEdge, sourceEdge }) =>
            `${interpretationEdge(query, queryEdge)} ↔ ${interpretationEdge(source, sourceEdge)}${added.has(queryEdge.id) ? ' (under accepted correspondence)' : ''}`,
        ),
      ],
      ...(supported.length
        ? [
            [
              'Case-supported inquiry relations',
              supported.map((relation) => interpretationEdge(query, relation.edge)),
            ],
          ]
        : []),
      ...(unsupported.length
        ? [
            [
              'Open inquiry relations',
              unsupported.map((relation) => interpretationEdge(query, relation.edge)),
            ],
          ]
        : []),
      [
        'Return provenance',
        [
          `Source: ${scope.sourceId}`,
          `Occurrence: ${scope.occurrenceId}`,
          `${applied ? 'Applied' : 'Accepted'} interpretation: ${interpretationLabel(item.proposal)}`,
          `Interpretation ID: ${item.proposal.id}`,
          ...(item.decisionId ? [`Decision ID: ${item.decisionId}`] : []),
          ...item.publicationIds.map((id) => `Publication: ${id}`),
        ],
      ],
    ];
  });
}

export function snapshot(ix, selection, decisions = []) {
  const view = viewModel(ix, selection);
  const sections = [
    ['INQUIRY', view.inquiry],
    ['NEIGHBORHOOD', view.neighborhood],
    ['SELECTED NODE / OCCURRENCE', view.local],
    [`DETAIL - ${selection.detail.toUpperCase()}`, view.detail],
    ...conditionalReturnSections(ix, decisions, selection.nodeId),
  ];
  return (
    sections
      .filter(([, lines]) => lines.length)
      .map(
        ([heading, lines]) =>
          `${heading}\n${lines
            .flatMap((line) => line.split('\n'))
            .map((line) => `  ${line}`)
            .join('\n')}`,
      )
      .join('\n\n') + '\n'
  );
}

/** Evidence metadata shared by the terminal page and text snapshots. */
export function provenanceSections(ix, { node, occurrence }) {
  const { recording } = ix;
  const source = occurrence ? ix.sources.get(occurrence.sourceId) : null;
  const sections = [];
  if (source)
    sections.push(
      ['Source sentence', [source.text]],
      [
        'Selected event',
        [
          `Concept: ${occurrence.concept}`,
          `Node: ${occurrence.sourceEventNodeId}`,
          `Graph: ${source.graphId}`,
          `Occurrence: ${occurrence.id}`,
        ],
      ],
    );
  const witnesses =
    occurrence?.alignedRefs.flatMap((ref) => [
      occurrence.requiredRefs.find((path) => path.id === ref.queryPathId)?.text ?? ref.queryPathId,
      `Path: ${ref.queryPathId}`,
      `Source nodes: ${ref.sourceNodeIds.join(' → ')}`,
      `Source edges: ${ref.sourceEdgeIds.join(', ')}`,
    ]) ?? [];
  if (witnesses.length) sections.push(['Recorded path witnesses', witnesses]);
  const bindings =
    occurrence?.bindings?.flatMap((binding) =>
      binding.locatedRefs.flatMap((ref) => [
        `Proposed binding: ${binding.queryNodeId} → ${binding.sourceNodeId}`,
        `Path: ${ref.queryPathId}`,
        `Source nodes: ${ref.sourceNodeIds.join(' → ')}`,
        `Source edges: ${ref.sourceEdgeIds.join(', ')}`,
      ]),
    ) ?? [];
  if (bindings.length) sections.push(['Binding witnesses', bindings]);
  sections.push(
    [
      'Inquiry context',
      [
        ...(recording.caseState
          ? [
              `Case state: ${ix.nodes.get(recording.caseState.rootNodeId).label}`,
              `Policy: ${recording.caseState.policy}`,
            ]
          : []),
        ...(recording.inquiry.obligation.parentContext.length
          ? [`Parent scope: ${recording.inquiry.obligation.parentContext.join('; ')}`]
          : []),
      ],
    ],
    [
      'Recording',
      [
        `ID: ${recording.id}`,
        `Asset: ${recording.asset.name}`,
        ...(recording.asset.revision ? [`Revision: ${recording.asset.revision}`] : []),
      ],
    ],
    [
      'Integrity - SHA-256',
      [
        `Asset: ${recording.asset.digest}`,
        `Inquiry text: ${ix.amrs.get(recording.inquiry.amrId).textDigest}`,
        ...(source
          ? [`Source text: ${source.textDigest}`]
          : node.sourceIds.map((id) => `Source ${id}: ${ix.sources.get(id).textDigest}`)),
      ],
    ],
    [
      'Models',
      [
        `AMR: ${recording.models.amr}`,
        ...(recording.models.embedding
          ? [`Embedding: ${recording.models.embedding}`]
          : ['Acquisition: retained AMRs; no model calls']),
      ],
    ],
    ...(recording.embedding
      ? [
          [
            'Similarity',
            [
              ...(Number.isFinite(source?.affinity)
                ? [`Selected source: ${source.affinity.toFixed(3)} cosine`]
                : []),
              `Comparison: inquiry text ↔ each source passage`,
              `Prompt: ${recording.embedding.prompt}`,
              `Acquired dimensions: ${recording.embedding.acquiredDimensions}`,
              `Used dimensions: ${recording.embedding.usedDimensions}`,
              `Normalization: ${recording.embedding.normalization}`,
              'Source order: cosine similarity within each node',
              `Child order: ${recording.routing?.policy === 'local-then-ranked-children-v1' ? 'ranked names and descriptions' : 'authored'}`,
              'AMR checks: graph paths',
            ],
          ],
        ]
      : [
          [
            'Inspection',
            [
              'Authored scope order; no embeddings',
              'AMR checks: graph paths and connected fragment correspondences',
            ],
          ],
        ]),
  );
  return sections.filter(([, lines]) => lines.length);
}
