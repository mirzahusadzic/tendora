/** Assertion-backed coverage of an unchanged question, with explicit residuals.
 * A part is an attributed match inside its source context, never a new assertion.
 */
import { inquiryPattern } from './patterns.mjs';
import { guardedEvidence, traceRelations } from './inference.mjs';
import { createGrammarMatcher } from './hrg-query.mjs';

export const partialCoverageProfile = 'assertion-backed-query-coverage-v2';

// Object/array traversal order and temporary recording IDs are not identities.
export function partialIdentity(value) {
  const ordered = (item) =>
    Array.isArray(item)
      ? item.map(ordered)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, ordered(item[key])]),
          )
        : item;
  const text = JSON.stringify(ordered(value));
  let h1 = 1779033703 ^ text.length;
  let h2 = 3144134277 ^ text.length;
  let h3 = 1013904242 ^ text.length;
  let h4 = 2773480762 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 597399067);
    h2 = Math.imul(h2 ^ code, 2869860233);
    h3 = Math.imul(h3 ^ code, 951274213);
    h4 = Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1, h2, h3, h4].map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('');
}

export const partialQueryRevision = (graph) =>
  partialIdentity({
    top: graph.top,
    assertionTop: graph.assertionTop,
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
  });

/** Identify occurrences, including generated participants, by their provenance. */
function participantIdentity(material, facts) {
  const byFact = new Map(facts.map((fact) => [fact.id, fact]));
  const memo = new Map();
  const sources = [...material.sources].sort((a, b) => b.id.length - a.id.length);
  const sourceKey = (source) => [source.nodeId, source.sentenceId ?? source.id];
  const sourceTerm = (id) => {
    const source = sources.find(
      (source) =>
        id === source.id || id.startsWith(`${source.id}#`) || id.startsWith(`${source.id}/clause/`),
    );
    return source ? ['source', sourceKey(source), id.slice(source.id.length)] : id;
  };
  const identify = (id, visiting = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (!id.startsWith('derived:')) return sourceTerm(id);
    // Fresh participants are interned by inference in traversal order. Recover
    // the generating application from its attributed premises instead.
    if (visiting.has(id)) return ['recursive', id.split(':').at(-1)];
    const next = new Set([...visiting, id]);
    const symbol = id.slice(id.lastIndexOf(':') + 1);
    const applications = facts
      .flatMap((fact) =>
        fact.triple.includes(id)
          ? [fact, ...(fact.alternatives ?? [])].filter(
              (proof) =>
                proof.ruleId &&
                proof.premises?.length &&
                material.rules.some(
                  (rule) =>
                    rule.id === proof.ruleId &&
                    rule.then.some((triple) =>
                      triple.some((term, index) => term === symbol && fact.triple[index] === id),
                    ),
                ),
            )
          : [],
      )
      .map((proof) => [
        sourceTerm(proof.ruleId),
        proof.premises
          .map((key) => byFact.get(key).triple.map((term) => identify(term, next)))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ]);
    const value = [
      'generated',
      id.split(':').at(-1),
      [
        ...new Map(
          applications.map((application) => [partialIdentity(application), application]),
        ).values(),
      ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ];
    memo.set(id, value);
    return value;
  };
  return identify;
}

// Selecting a qualified participant/event must retain its identity and guards.
// Other unmatched relations remain explicit obligations of the original query.
const requiredRoles = new Set([
  ':polarity',
  ':mode',
  ':condition',
  ':concession',
  ':name',
  ':quant',
]);
const genericParticipants = new Set([
  'person',
  'thing',
  'entity',
  'agent',
  'organization',
  'group',
]);
const unique = (values) => [...new Set(values)];

export function partialQueryCoverage(
  query,
  material,
  facts,
  {
    matcher = createGrammarMatcher().match,
    openings = [],
    stateLimit = 256,
    partLimit = 64,
    matchBudget = 50000,
    matchLimit = 2000,
    targets = [],
    scope = null,
    resolved = false,
  } = {},
) {
  const { variables, unknownIds, assertions, decomposition, connectors } = inquiryPattern(query, {
    composeClauses: true,
  });
  const byNode = new Map(query.nodes.map((node) => [node.id, node]));
  const byFact = new Map(facts.map((fact) => [fact.id, fact]));
  const identify = participantIdentity(material, facts);
  const edges = query.edges.filter(
    (edge) => !connectors.has(edge.from) && !(edge.role === ':polarity' && unknownIds.has(edge.to)),
  );
  const account = { work: 0, limit: matchBudget };
  let complete = true,
    searched = 0;
  const match = (patterns) => {
    const result = matcher(patterns, facts, { account, limit: matchLimit, budget: matchBudget });
    complete &&= result.complete;
    return result;
  };
  const nodePatterns = (ids) =>
    unique(ids).flatMap((id) => {
      const node = byNode.get(id);
      return [
        ...(!unknownIds.has(id) ? [[variables.get(id), ':instance', node.concept]] : []),
        ...(node.literal !== undefined ? [[variables.get(id), '@literal', node.literal]] : []),
        ...(unknownIds.has(id) ? (node.semanticTypes ?? []) : []).map((type) => [
          variables.get(id),
          '@semanticType',
          type,
        ]),
      ];
    });
  const edgePatterns = (selected) =>
    selected.map((edge) => [variables.get(edge.from), edge.role, variables.get(edge.to)]);
  const residual = (selected) =>
    edges
      .filter((edge) => !selected.has(edge.id))
      .map((edge) => {
        const diagnostic = openings.find((item) => item.kind === 'relation' && item.id === edge.id);
        return {
          ...diagnostic,
          kind: 'relation',
          id: edge.id,
          edgeId: edge.id,
          from: byNode.get(edge.from).concept,
          to: byNode.get(edge.to).concept,
          role: edge.role,
          anchor: {
            kind: 'edge',
            edgeId: edge.id,
            from: edge.from,
            to: edge.to,
            role: edge.role,
          },
          state: diagnostic?.state ?? 'unresolved',
          reason: diagnostic?.reason ?? 'This relation is not established by this supported part.',
        };
      });
  const potential = new Set();
  const triples = new Set(facts.map((fact) => JSON.stringify(fact.triple)));
  const acceptsNode = (nodeId, value) =>
    nodePatterns([nodeId]).every((pattern) =>
      triples.has(JSON.stringify([value, pattern[1], pattern[2]])),
    );
  // A cheap over-approximation only removes impossible edges. The complete
  // connected part below still needs a coherent attributed HRG derivation.
  for (const edge of edges) {
    if (
      facts.some(
        ({ triple: [from, role, to] }) =>
          role === edge.role &&
          (edge.from === edge.to ? from === to : from !== to) &&
          acceptsNode(edge.from, from) &&
          acceptsNode(edge.to, to),
      )
    )
      potential.add(edge.id);
  }
  const parts = [];
  for (const { root } of assertions) {
    if (!complete) break;
    if (searched >= stateLimit) {
      complete = false;
      break;
    }
    if (unknownIds.has(root)) continue;
    const fragment = decomposition.fragments.find((item) => item.root === root);
    const allowed = edges.filter((edge) => fragment.graph.edges.some((e) => e.id === edge.id));
    // Canonical inverse nominal heads lie outside the root's directed graph.
    // Do not mistake the enclosing check/event for a participant descriptor.
    const forward = new Set([root]);
    for (const id of forward)
      for (const edge of allowed) if (edge.from === id) forward.add(edge.to);
    const descriptors = new Map();
    for (const participant of fragment.graph.nodes) {
      if (!genericParticipants.has(participant.concept)) continue;
      const branch = new Set([participant.id]),
        required = new Set();
      for (const id of branch)
        for (const edge of allowed) {
          const inverse = edge.to === id && /^:ARG\d+$/u.test(edge.role);
          // Retain nominal themes and modifiers, but leave other agents as
          // independent query obligations (e.g. the owner of an intention).
          const theme =
            id !== participant.id && edge.from === id && /^:(?:ARG[1-9]\d*|mod)$/u.test(edge.role);
          const next = inverse ? edge.from : theme ? edge.to : null;
          if (next === null || (inverse && forward.has(next))) continue;
          required.add(edge.id);
          if (!forward.has(next)) branch.add(next);
        }
      descriptors.set(participant.id, required);
    }
    const connected = (selected) => {
      const nodes = new Set([root]),
        found = new Set();
      let added = true;
      while (added) {
        added = false;
        for (const edge of allowed)
          if (
            selected.has(edge.id) &&
            !found.has(edge.id) &&
            (nodes.has(edge.from) || nodes.has(edge.to))
          ) {
            found.add(edge.id);
            nodes.add(edge.from);
            nodes.add(edge.to);
            added = true;
          }
      }
      return { nodes, selected: found };
    };
    const close = (selected) => {
      const result = connected(selected);
      let added = true;
      while (added) {
        added = false;
        for (const edge of allowed)
          if (
            !result.selected.has(edge.id) &&
            [...result.nodes].some((id) => descriptors.get(id)?.has(edge.id))
          ) {
            result.selected.add(edge.id);
            result.nodes.add(edge.from);
            result.nodes.add(edge.to);
            added = true;
          }
        for (const guard of allowed.filter(
          (edge) => result.nodes.has(edge.from) && requiredRoles.has(edge.role),
        )) {
          const branch = new Set([guard.to]);
          const retain = (edge) => {
            if (!result.selected.has(edge.id)) added = true;
            result.selected.add(edge.id);
            result.nodes.add(edge.from);
            result.nodes.add(edge.to);
          };
          retain(guard);
          // Canonical inverse nominal relations point into the guarded branch.
          // Follow either direction, stopping at the owning event/participant.
          for (const node of branch)
            for (const edge of allowed) {
              const next = edge.from === node ? edge.to : edge.to === node ? edge.from : null;
              if (next === null || next === guard.from) continue;
              retain(edge);
              branch.add(next);
            }
        }
      }
      return result;
    };
    const queue = [
        ...targets
          .filter((part) => part.root === root)
          .map((part) => ({
            ...close(new Set(part.edgeIds)),
            revisit: true,
          })),
        close(potential),
      ],
      visited = new Set();
    while (queue.length && complete) {
      queue.sort(
        (a, b) =>
          Number(Boolean(b.revisit)) - Number(Boolean(a.revisit)) ||
          b.selected.size - a.selected.size,
      );
      const state = queue.shift();
      const signature = [...state.selected].sort().join('\n');
      if (visited.has(signature) || !state.selected.size) continue;
      visited.add(signature);
      if (searched++ >= stateLimit) {
        complete = false;
        break;
      }
      // A larger coherent query part already supplies this structural coverage.
      if (
        parts.some(
          (part) =>
            part.root === root && [...state.selected].every((id) => part.edgeIds.includes(id)),
        )
      )
        continue;
      const selected = allowed.filter((edge) => state.selected.has(edge.id));
      const patterns = [
        [variables.get(root), '@asserted', 'true'],
        ...nodePatterns([...state.nodes]),
        ...edgePatterns(selected),
      ];
      const result = match(patterns);
      const supported = result.matches.filter((item) => {
        const witnesses = new Set(item.witnesses);
        const assigned = [...state.nodes].map((id) => item.values[variables.get(id)]);
        return (
          new Set(assigned).size === assigned.length &&
          item.witnesses.every((id) => guardedEvidence(byFact.get(id), witnesses).length)
        );
      });
      for (const item of supported) {
        if (parts.length >= partLimit) {
          complete = false;
          break;
        }
        const proof = traceRelations(facts, item.witnesses);
        const sourceIds = proof.sourceIds;
        // Keep omitted source context visible. A match of a smaller question
        // graph does not manufacture an unqualified, standalone assertion.
        const proofFacts = new Set(proof.facts.map((fact) => fact.id));
        const fragmentIds = new Set(proof.fragmentIds);
        const context = material.facts.filter(
          (fact) =>
            fact.fragmentIds?.some((id) => fragmentIds.has(id)) &&
            fact.triple[1].startsWith(':') &&
            fact.triple[1] !== ':instance' &&
            !proofFacts.has(fact.id ?? JSON.stringify(fact.triple)),
        );
        const dependencies = sourceIds
          .map((id) => {
            const source = material.sources.find((entry) => entry.id === id);
            return {
              ...source,
              graphRevision: material.sourceGraphs.find((entry) => entry.sourceId === id)?.revision,
            };
          })
          .filter(Boolean);
        const bindings = [...state.nodes].map((nodeId) => ({
          nodeId,
          id: item.values[variables.get(nodeId)],
          participant: identify(item.values[variables.get(nodeId)]),
        }));
        const edgeIds = selected.map((edge) => edge.id);
        const anchor = { kind: 'node', nodeId: root };
        // A part owns one asserted occurrence. Its coherent support variants
        // remain separate; growing a branch does not replace that owner.
        const id = partialIdentity([anchor, identify(item.values[variables.get(root)])]);
        parts.push({
          id: `partial:${id}`,
          anchor,
          scope,
          root,
          graph: {
            ...query,
            top: root,
            assertionTop: root,
            nodes: query.nodes.filter((node) => state.nodes.has(node.id)),
            edges: selected,
          },
          nodeIds: [...state.nodes],
          edgeIds,
          sourceIds,
          ruleIds: proof.ruleIds,
          ruleIdentities: proof.ruleIds.map((id) => identify(id)),
          ruleDependencies: proof.ruleIds.map((id) => {
            const rule = material.rules.find((rule) => rule.id === id);
            const terms = (triples) =>
              (triples ?? []).map((triple) => triple.map((term) => identify(term)));
            return {
              id,
              identity: identify(id),
              revision: partialIdentity({
                when: terms(rule.when),
                then: terms(rule.then),
                guards: terms(rule.guards),
              }),
            };
          }),
          bindingIds: proof.bindingIds ?? [],
          bindingDependencies: (proof.bindingIds ?? []).map((id) => {
            const binding = material.bindings.find((binding) => binding.id === id);
            return { id, revision: partialIdentity(binding.references) };
          }),
          bindings,
          candidateConnections: residual(state.selected).map(({ anchor }) => ({
            kind: 'unresolved-query-relation',
            anchor,
          })),
          witnesses: item.witnesses,
          derivation: item.derivation,
          dependencies,
          qualifications: unique([
            ...facts
              .filter(
                (fact) =>
                  fact.triple[0] === item.values[variables.get(root)] &&
                  fact.triple[1] === '@qualification',
              )
              .map((fact) => fact.triple[2]),
            ...material.sources
              .filter((source) => context.some((fact) => fact.sourceIds.includes(source.id)))
              .map((source) => source.text),
          ]),
          openings: residual(state.selected),
        });
      }
      if (supported.length) continue;
      for (const edge of selected)
        queue.push(close(new Set([...state.selected].filter((id) => id !== edge.id))));
    }
  }
  const maximal = parts.filter(
    (part) =>
      !parts.some(
        (other) =>
          other.id === part.id &&
          other.edgeIds.length > part.edgeIds.length &&
          part.edgeIds.every((id) => other.edgeIds.includes(id)) &&
          part.bindings.every((binding) =>
            other.bindings.some(
              (entry) => entry.nodeId === binding.nodeId && entry.id === binding.id,
            ),
          ),
      ),
  );
  const covered = new Set(maximal.flatMap((part) => part.edgeIds));
  const connections = openings.filter((opening) => opening.kind === 'connection');
  const remaining = [...connections, ...residual(covered)];
  if (maximal.length && !remaining.length && !resolved)
    remaining.push({
      kind: 'connection',
      state: 'unjoined',
      reason:
        'The supported parts do not form one complete assertion with consistent participant identities.',
      partIds: maximal.map((part) => part.id),
      queryNodeIds: unique(maximal.flatMap((part) => part.nodeIds)),
    });
  const located = remaining.map((opening) => {
    const anchor = opening.anchor ?? {
      kind: 'node',
      nodeId: opening.queryNodeIds?.[0] ?? query.top,
    };
    const bindings = maximal.flatMap((part) =>
      part.bindings.filter((binding) =>
        [anchor.nodeId, anchor.from, anchor.to].includes(binding.nodeId),
      ),
    );
    return {
      ...opening,
      identity: `aporia:${partialIdentity([opening.kind, anchor])}`,
      anchor,
      scope,
      bindings,
      dependencies: maximal.flatMap((part) => part.dependencies),
      candidateConnections:
        opening.candidateConnections?.map((candidate) => ({
          ...candidate,
          ruleIdentities: candidate.ruleIds.map((id) => identify(id)),
          bindings: candidate.bindings.map((binding) => ({
            ...binding,
            participant: identify(binding.id),
          })),
          dependencies: candidate.sourceIds.map((id) => ({
            ...material.sources.find((source) => source.id === id),
            graphRevision: material.sourceGraphs.find((entry) => entry.sourceId === id)?.revision,
          })),
        })) ??
        (opening.sourceIds ?? []).map((sourceId) => ({
          kind: 'unjoined-evidence',
          sourceId,
          source: material.sources.find((source) => source.id === sourceId),
          ruleIds: opening.ruleIds ?? [],
        })),
    };
  });
  return {
    profile: partialCoverageProfile,
    parts: maximal,
    openings: located,
    complete,
    work: account.work,
    resolved,
  };
}
