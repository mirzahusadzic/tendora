/** One situated unknown, connected meanings, source envelopes and computed residuals. */
import { prepareGraphs, normalizedRoleProfile } from '../models/graph-preparation.mjs';
import { compareGraphs } from '../models/semantic-comparison.mjs';
import {
  connectedFragments,
  checkFragmentMap,
  literalCorrespondence,
  composeEnvelopes,
  verifyEnvelope,
  alignmentGaps,
  relationPath,
  foldRelation,
  expandRelation,
} from '../amr/fragment-composition.mjs';
import { prepareInquiry } from './preparation.mjs';

export const semanticChainProfile = 'amr-inquiry-chain-v1';
const operators = new Set(['and', 'or', 'either', 'neither', 'contrast-01', 'amr-unknown']);
const byId = (graph, id) => graph.nodes.find((node) => node.id === id);
const contents = (graph) =>
  JSON.stringify([
    graph.top,
    graph.assertionTop,
    graph.nodes.map((node) => [node.id, node.concept, node.literal]).sort(),
    graph.edges.map((edge) => [edge.id, edge.from, edge.role, edge.to]).sort(),
  ]);
const words = (concept) => concept.replace(/-\d+$/u, '').replaceAll('-', ' ');
const subgraph = (graph, ids, top = ids[0]) => ({
  top,
  nodes: graph.nodes.filter((node) => ids.includes(node.id)),
  edges: graph.edges.filter((edge) => ids.includes(edge.from) && ids.includes(edge.to)),
});

export function unknownRoles(graph) {
  return graph.nodes
    .filter((node) => node.concept === 'amr-unknown')
    .flatMap((unknown) =>
      graph.edges
        .filter((edge) => edge.to === unknown.id)
        .flatMap((edge) => {
          const owner = byId(graph, edge.from);
          if (edge.role === ':polarity')
            return { unknownId: unknown.id, kind: 'polarity', edge, owner };
          const parents = graph.edges.filter(
            (parent) => parent.to === owner.id && /-\d+$/u.test(byId(graph, parent.from).concept),
          );
          return parents.length && !/-\d+$/u.test(owner.concept)
            ? parents.map((parent) => ({
                unknownId: unknown.id,
                kind: 'descriptor',
                edge,
                owner,
                role: parent,
              }))
            : [{ unknownId: unknown.id, kind: 'argument', edge, owner, role: edge }];
        }),
    );
}

function nodeText(graph, id, eventId, text = '') {
  const node = byId(graph, id);
  if (node.literal !== undefined) {
    try {
      return String(JSON.parse(node.literal));
    } catch {
      return node.literal;
    }
  }
  const name = graph.edges.find((edge) => edge.from === id && edge.role === ':name');
  if (name)
    return graph.edges
      .filter((edge) => edge.from === name.to && /^:op\d+$/u.test(edge.role))
      .sort((a, b) => Number(a.role.slice(3)) - Number(b.role.slice(3)))
      .map((edge) => nodeText(graph, edge.to))
      .join(' ');
  const descriptors = graph.edges
    .flatMap((edge) =>
      edge.from === id && edge.role === ':mod'
        ? [edge.to]
        : edge.to === id && edge.from !== eventId && /^:ARG\d+$/u.test(edge.role)
          ? [edge.from]
          : [],
    )
    .map((id) => byId(graph, id))
    .filter((node) => !operators.has(node.concept));
  const sourceWords = text.match(/[\p{L}]+/gu) ?? [];
  const descriptor = (node) => {
    const stem = words(node.concept);
    return (
      sourceWords.find((word) => word.toLowerCase() === stem) ??
      sourceWords.find((word) =>
        ['ing', 'ed', 's'].some((suffix) => word.toLowerCase() === stem + suffix),
      ) ??
      stem
    );
  };
  return [...new Set(descriptors.map(descriptor)), words(node.concept)].join(' ');
}

/** Path evidence keeps every intermediate relation and its enclosing source. */
function casePaths(record, eventId, valueId, cases, frequency) {
  return cases
    .flatMap((carried) =>
      carried.graph.nodes
        .filter((node) => node.literal === undefined && !operators.has(node.concept))
        .flatMap((node) =>
          record.graph.nodes
            .filter((other) => other.literal === undefined && other.concept === node.concept)
            .flatMap((other) => {
              const path = relationPath(record.graph, eventId, other.id),
                toValue = relationPath(record.graph, other.id, valueId);
              if (!path || !toValue) return [];
              const context = path
                .flatMap((step) => [step.from, step.to])
                .filter((id) => operators.has(byId(record.graph, id).concept));
              return [
                {
                  caseId: carried.id,
                  caseNodeId: node.id,
                  sourceNodeId: other.id,
                  concept: node.concept,
                  casePath: relationPath(carried.graph, carried.graph.top, node.id),
                  sourcePath: path,
                  valuePath: toValue,
                  context: [...new Set(context)],
                  relevance:
                    1 /
                    ((frequency.get(node.concept) ?? 1) *
                      (path.length + 1) *
                      (context.some((id) =>
                        ['or', 'contrast-01'].includes(byId(record.graph, id).concept),
                      )
                        ? 4
                        : 1)),
                },
              ];
            }),
        ),
    )
    .sort(
      (a, b) =>
        b.relevance - a.relevance ||
        a.sourcePath.length - b.sourcePath.length ||
        a.concept.localeCompare(b.concept),
    );
}

export async function traceInquiry(
  input,
  {
    signal,
    phase = async () => {},
    clients = { prepare: prepareGraphs, compare: compareGraphs },
    bounds = {},
    preparedInput,
  } = {},
) {
  const maximumNodes = bounds.maximumFragmentNodes ?? 4,
    maximumPairs = bounds.maximumPairs ?? 4096;
  const { records, openings } =
    preparedInput ?? (await prepareInquiry(input, { signal, phase, prepare: clients.prepare }));
  const callsLimited = [];
  if (!records.at(-1)?.graph)
    return {
      profile: semanticChainProfile,
      status: 'open',
      inputs: records,
      candidates: [],
      openings,
      definitions: [],
      applications: [],
      chains: [],
    };
  const encoded = new Map();
  async function prepare(items) {
    const output = [];
    for (let i = 0; i < items.length; i += 128) {
      signal?.throwIfAborted();
      const batch = await clients.prepare(items.slice(i, i + 128), {
        profile: normalizedRoleProfile,
        signal,
      });
      for (const item of batch.results)
        if (!item.ok) throw new Error(item.diagnostics.map((item) => item.message).join('; '));
      output.push(...batch.results);
    }
    return output;
  }
  async function compare(pairs) {
    if (!pairs.length) return [];
    if (pairs.length > maximumPairs)
      throw Object.assign(new Error(`Semantic comparison reached its ${maximumPairs} pair bound`), {
        code: 'FRAGMENT_LIMIT',
      });
    const graphs = [...new Set(pairs.flatMap((pair) => [pair.left, pair.right]))].filter(
      (graph) => !encoded.has(graph),
    );
    const values = await prepare(graphs.map((graph) => ({ graph })));
    for (const [index, graph] of graphs.entries()) encoded.set(graph, values[index].penman);
    const results = [];
    for (let i = 0; i < pairs.length; i += 128) {
      const batch = await clients.compare(
        pairs.slice(i, i + 128).map((pair) => ({
          reference: encoded.get(pair.left),
          hypothesis: encoded.get(pair.right),
        })),
        { signal },
      );
      for (const value of batch.results)
        if (!value.complete) callsLimited.push(value.reason ?? 'Metric comparison is incomplete');
      results.push(...batch.results);
    }
    return results;
  }
  for (const record of records) if (record.penman) encoded.set(record.graph, record.penman);
  const sources = records.slice(0, input.sources.length).filter((record) => record.graph),
    cases = records.slice(input.sources.length, -1).filter((record) => record.graph),
    question = records.at(-1);
  const slots = unknownRoles(question.graph);
  const frequency = new Map();
  for (const record of sources)
    for (const node of record.graph.nodes)
      frequency.set(node.concept, (frequency.get(node.concept) ?? 0) + 1);
  await phase('fragments', 'Derive connected units and compare their case interfaces');
  const fragments = sources.flatMap((source) =>
    connectedFragments(source.graph, maximumNodes, 20000).map((fragment) => ({
      ...fragment,
      source,
    })),
  );
  const caseFragments = cases.flatMap((source) =>
    connectedFragments(source.graph, maximumNodes, 20000).map((fragment) => ({
      ...fragment,
      source,
    })),
  );
  const pairs = fragments.flatMap((left) =>
    caseFragments
      .filter(
        (right) =>
          left.graph.nodes.length === right.graph.nodes.length &&
          left.graph.nodes.filter(
            (node) =>
              !operators.has(node.concept) &&
              right.graph.nodes.some((other) => other.concept === node.concept),
          ).length >= 2,
      )
      .map((right) => ({ left: left.graph, right: right.graph, source: left, carried: right })),
  );
  const scores = await compare(pairs);
  const reuse = pairs
    .flatMap((pair, index) => {
      const score = scores[index];
      if (!score.complete || !checkFragmentMap(pair.left, pair.right, score.local.correspondence))
        return [];
      return [
        {
          ...pair,
          comparison: score,
          correspondence: literalCorrespondence(pair.left, pair.right, score.local.correspondence),
        },
      ];
    })
    .sort(
      (a, b) =>
        b.left.nodes.length - a.left.nodes.length || b.left.edges.length - a.left.edges.length,
    );
  await phase('compose', 'Reuse verified definitions with their full enclosing relations');
  const definitions = [],
    applications = [];
  for (const match of reuse.slice(0, bounds.maximumApplications ?? 16)) {
    const source = match.source.source,
      carried = match.carried.source;
    const definition = foldRelation(
      source.graph,
      match.left.nodes.map((node) => node.id),
    );
    if (contents(expandRelation(definition)) !== contents(source.graph))
      throw new Error('Definition expansion changed its source');
    const composition = composeEnvelopes(source.graph, carried.graph, match.correspondence);
    if (
      !verifyEnvelope(source.graph, composition, 0) ||
      !verifyEnvelope(carried.graph, composition, 1)
    )
      throw new Error('Composition lost an input relation');
    definitions.push({ sourceId: source.id, ...definition });
    applications.push({
      sourceId: source.id,
      caseId: carried.id,
      comparison: match.comparison,
      composition,
      standing: 'case application candidate',
      verified: { sourcePreserved: true, casePreserved: true, expansion: true },
    });
  }
  await phase('unknown', 'Trace the requested unknown through case and source relations');
  const roleOptions = slots
    .filter((slot) => slot.kind !== 'polarity')
    .flatMap((slot) =>
      sources.flatMap((source) =>
        source.graph.edges
          .filter((edge) => edge.role === slot.role.role)
          .map((edge) => {
            const target = byId(source.graph, edge.to),
              origin = byId(question.graph, slot.role.from);
            const queryGraph =
              slot.kind === 'descriptor'
                ? subgraph(question.graph, [slot.role.from, slot.role.to], slot.role.from)
                : {
                    top: slot.role.from,
                    nodes: [
                      origin,
                      {
                        ...byId(question.graph, slot.role.to),
                        concept: target.concept,
                        literal: target.literal,
                      },
                    ],
                    edges: [slot.role],
                  };
            const sourceGraph = subgraph(source.graph, [edge.from, edge.to], edge.from);
            return {
              slot,
              source,
              edge,
              queryGraph,
              sourceGraph,
              paths: casePaths(source, edge.from, edge.to, cases, frequency),
            };
          })
          .filter((option) =>
            option.queryGraph.nodes.some((node) =>
              option.sourceGraph.nodes.some((other) => other.concept === node.concept),
            ),
          ),
      ),
    );
  const roleScores = await compare(
    roleOptions.map((option) => ({ left: option.queryGraph, right: option.sourceGraph })),
  );
  const candidates = roleOptions
    .flatMap((option, index) => {
      const comparison = roleScores[index];
      if (
        !comparison.complete ||
        !checkFragmentMap(option.queryGraph, option.sourceGraph, comparison.local.correspondence)
      )
        return [];
      if (cases.length && !option.paths.length) return [];
      return [
        {
          unknownId: option.slot.unknownId,
          sourceId: option.source.id,
          valueNodeId: option.edge.to,
          sourceEventNodeId: option.edge.from,
          role: option.edge.role,
          text: nodeText(option.source.graph, option.edge.to, option.edge.from, option.source.text),
          paths: option.paths,
          comparison,
          relevance: option.paths[0]?.relevance ?? 1,
          standing: 'candidate',
          sourceGraph: option.source.graph,
          queryUnit: option.queryGraph,
          sourceUnit: option.sourceGraph,
          correspondence: literalCorrespondence(
            option.queryGraph,
            option.sourceGraph,
            comparison.local.correspondence,
          ),
        },
      ];
    })
    .sort((a, b) => b.relevance - a.relevance || a.text.localeCompare(b.text));
  await phase('boundaries', 'Follow candidate boundaries into other scoped sources');
  const boundaryPairs = candidates.slice(0, 8).flatMap((candidate) =>
    fragments
      .filter(
        (fragment) =>
          fragment.source.id === candidate.sourceId &&
          fragment.graph.nodes.some((node) => node.id === candidate.valueNodeId),
      )
      .flatMap((left) =>
        fragments
          .filter(
            (right) =>
              right.source.id !== candidate.sourceId &&
              left.graph.nodes.length === right.graph.nodes.length &&
              left.graph.nodes.filter(
                (node) =>
                  !operators.has(node.concept) &&
                  right.graph.nodes.some((other) => other.concept === node.concept),
              ).length >= 2,
          )
          .map((right) => ({
            left: left.graph,
            right: right.graph,
            candidate,
            source: left.source,
            other: right.source,
          })),
      ),
  );
  const boundaryScores = await compare(boundaryPairs);
  const chains = [];
  for (const [index, pair] of boundaryPairs.entries()) {
    const comparison = boundaryScores[index];
    if (
      !comparison.complete ||
      !checkFragmentMap(pair.left, pair.right, comparison.local.correspondence)
    )
      continue;
    const composition = composeEnvelopes(
      pair.source.graph,
      pair.other.graph,
      literalCorrespondence(pair.left, pair.right, comparison.local.correspondence),
    );
    if (
      !verifyEnvelope(pair.source.graph, composition, 0) ||
      !verifyEnvelope(pair.other.graph, composition, 1)
    )
      throw new Error('Boundary composition lost a source');
    const definition = foldRelation(
      pair.source.graph,
      pair.left.nodes.map((node) => node.id),
    );
    if (contents(expandRelation(definition)) !== contents(pair.source.graph))
      throw new Error('Boundary definition changed its source');
    chains.push({
      sourceId: pair.source.id,
      otherSourceId: pair.other.id,
      candidate: candidates.indexOf(pair.candidate),
      comparison,
      composition,
      definition,
      verified: { sourcePreserved: true, otherPreserved: true, expansion: true },
    });
    if (chains.length >= (bounds.maximumApplications ?? 16)) break;
  }
  await phase('relations', 'Compare the complete question with source and carried envelopes');
  const envelopes = [
    ...sources.map((source) => ({ sourceId: source.id, graph: source.graph })),
    ...chains.map((chain) => ({
      sourceId: chain.sourceId,
      otherSourceId: chain.otherSourceId,
      graph: chain.composition.graph,
      composition: chain.composition,
      candidate: chain.candidate,
    })),
    ...applications.slice(0, 4).map((application) => ({
      sourceId: application.sourceId,
      caseId: application.caseId,
      graph: application.composition.graph,
      composition: application.composition,
    })),
  ];
  const fits = await compare(
    envelopes.map((envelope) => ({ left: question.graph, right: envelope.graph })),
  );
  const ranked = envelopes
    .map((envelope, index) => ({
      ...envelope,
      comparison: fits[index],
      gaps: fits[index].complete
        ? alignmentGaps(question.graph, envelope.graph, fits[index].local.correspondence)
        : null,
    }))
    .sort((a, b) => (b.comparison.score ?? -1) - (a.comparison.score ?? -1));
  // The unknown's independently checked role remains fixed when inspecting its
  // enclosing question. A free metric alignment may otherwise select a different
  // event. Other proposed mappings remain metric evidence, not equivalence.
  const primary = candidates[0];
  const fit = primary
    ? (ranked.find((item) => item.gaps && item.candidate === 0) ??
      ranked.find((item) => item.gaps && item.sourceId === primary.sourceId))
    : ranked.find((item) => item.gaps);
  if (fit && primary) {
    const fixed = primary.correspondence.map(([left, right]) => [
      left,
      fit.composition ? fit.composition.embeddings[0][right] : right,
    ]);
    const left = new Set(fixed.map((pair) => pair[0])),
      right = new Set(fixed.map((pair) => pair[1]));
    const correspondence = [
      ...fixed,
      ...fit.comparison.local.correspondence.filter(
        (pair) => !left.has(pair[0]) && !right.has(pair[1]),
      ),
    ];
    fit.gaps = alignmentGaps(question.graph, fit.graph, correspondence);
    fit.alignment = { method: 'verified role plus proposed metric correspondence', correspondence };
  }
  if (fit) {
    for (const node of fit.gaps.nodes)
      openings.push({
        id: `node:${node.id}`,
        kind: 'concept',
        queryNodeId: node.id,
        sourceId: fit.sourceId,
        label: `${node.concept} ↔ ${node.candidate?.concept ?? '?'}`,
        required: node.concept,
        candidate: node.candidate?.concept ?? null,
        reason: node.candidate
          ? 'The metric proposes a correspondence between different concepts.'
          : 'This requested concept has no mapped source occurrence.',
      });
    for (const edge of fit.gaps.edges)
      openings.push({
        id: `edge:${edge.id}`,
        kind: 'relation',
        queryEdgeId: edge.id,
        sourceId: fit.sourceId,
        label: `${byId(question.graph, edge.from).concept} ${edge.role} ${byId(question.graph, edge.to).concept}`,
        reason: 'This complete question relation is not preserved by the proposed correspondence.',
      });
  }
  if (!slots.length)
    openings.push({
      id: 'unknown',
      kind: 'question',
      reason: 'The retained question has no represented amr-unknown.',
    });
  if (!fit)
    openings.push({
      id: 'support',
      kind: 'support',
      reason: 'No complete source comparison is available for the requested graph.',
    });
  if (callsLimited.length)
    openings.push({
      id: 'comparison-limit',
      kind: 'limit',
      reason: [...new Set(callsLimited)].join('; '),
    });
  return {
    profile: semanticChainProfile,
    status: callsLimited.length ? 'limited' : 'open',
    inputs: records,
    question: question.id,
    slots,
    candidates,
    openings,
    definitions,
    applications,
    chains,
    ranked,
    selectedFit: fit ?? null,
    retrieval: {
      maximumFragmentNodes: maximumNodes,
      pairs: pairs.length,
      reused: reuse.length,
      complete: false,
      reason: 'Connected candidate search is bounded; ranking does not establish an answer.',
    },
  };
}
