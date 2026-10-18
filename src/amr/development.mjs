/** Question/answer interfaces and authored wording correspondences. No domain vocabulary. */
import { inquiryPattern } from './patterns.mjs';
import { createGrammarMatcher } from './hrg-query.mjs';
import { validateGraph } from './revision.mjs';
import { validateRule } from './inference.mjs';
import { conditionalReading } from './conditions.mjs';
import { clauseFragments } from './clause-fragments.mjs';
import { sourceSemanticTypes } from './semantic-types.mjs';

export function graphFacts(graph, sourceId = 'contribution') {
  const triples = [
    ...clauseFragments(graph)
      .fragments.filter(
        (fragment) =>
          !graph.nodes.some((n) => ['amr-unknown', 'amr-empty'].includes(n.concept)) &&
          !conditionalReading(fragment.graph),
      )
      .map((fragment) => [fragment.root, '@asserted', 'true']),
    ...graph.nodes.flatMap((n) => [
      [n.id, ':instance', n.concept],
      ...(n.literal !== undefined ? [[n.id, '@literal', n.literal]] : []),
      ...sourceSemanticTypes(n).map((type) => [n.id, '@semanticType', type]),
    ]),
    ...graph.edges.map((e) => [e.from, e.role, e.to]),
  ];
  return triples.map((triple, i) => ({ id: `${sourceId}/${i}`, triple, sourceIds: [sourceId] }));
}

export function answerSlots(graph, { descriptorFallback = false } = {}) {
  const p = inquiryPattern(graph, { descriptorFallback });
  return [...new Set(p.answerSlotIds)]
    .map((id) => graph.nodes.find((node) => node.id === id))
    .filter(Boolean);
}

/** Only asserted clause projections are independent branches. Embedded topics,
 * conditions and shared participants retain their enclosing obligations.
 */
export function questionBranches(question) {
  const pattern = inquiryPattern(question, { composeClauses: true });
  return pattern.decomposition.fragments.filter((fragment) => fragment.kind === 'clause');
}

export function connectQuestion(question, graph, { partial = false } = {}) {
  const pattern = inquiryPattern(question, { composeClauses: true }),
    unknown = new Set(pattern.unknowns.map((n) => pattern.variables.get(n.id))),
    matcher = createGrammarMatcher(),
    facts = graphFacts(graph),
    sourceFragments = clauseFragments(graph).fragments,
    account = { work: 0, limit: 200000 };
  const match = (patterns) => {
    const obligations = patterns.filter((t) =>
      partial ? !t.some((v) => unknown.has(v)) && t[1] !== '@asserted' : true,
    );
    if (!obligations.some((t) => t[1].startsWith(':') && t[1] !== ':instance'))
      return { matches: [], complete: true };
    const result = matcher.match(obligations, facts, { account });
    if (!partial)
      result.matches = result.matches.filter((row) => {
        const witnessed = new Set(row.witnesses),
          roots = obligations.filter((t) => t[1] === '@asserted').map((t) => row.values[t[0]]);
        return sourceFragments
          .filter((f) => roots.includes(f.root))
          .every((f) =>
            f.guards.every((id) => {
              const edge = graph.edges.find((e) => e.id === id),
                fact = facts.find(
                  (fact) =>
                    fact.triple[0] === edge.from &&
                    fact.triple[1] === edge.role &&
                    fact.triple[2] === edge.to,
                );
              return witnessed.has(fact?.id);
            }),
          );
      });
    return result;
  };
  const whole = match(pattern.patterns),
    fragments = pattern.decomposition.fragments.filter((fragment) => fragment.kind === 'clause'),
    branches = fragments.map((fragment) => {
      const local = inquiryPattern(fragment.graph),
        rename = new Map([...local.variables].map(([id, v]) => [v, pattern.variables.get(id)])),
        patterns = local.patterns.map((triple) => triple.map((term) => rename.get(term) ?? term));
      return {
        root: fragment.root,
        ports: fragment.ports,
        ...match(patterns),
        variables: pattern.variables,
        asserted: false,
      };
    });
  return {
    ...whole,
    complete: whole.complete && branches.every((branch) => branch.complete),
    variables: pattern.variables,
    branches,
  };
}

/** The acquired carrier explicitly puts the answer in answer-01 :ARG2. */
export function answerFromCarrier(graph) {
  const wrappers = graph.nodes.filter((n) => n.concept === 'answer-01');
  if (wrappers.length !== 1)
    throw new Error('Could not read this answer. Try a complete sentence.');
  const ports = graph.edges.filter((e) => e.from === wrappers[0].id && e.role === ':ARG2');
  if (ports.length !== 1) throw new Error('Could not locate the answer. Try a complete sentence.');
  const kept = new Set([ports[0].to]);
  for (const id of kept)
    for (const e of graph.edges) {
      if (e.from === wrappers[0].id || e.to === wrappers[0].id) continue;
      if (e.from === id) kept.add(e.to);
      if (e.to === id) kept.add(e.from);
    }
  return validateGraph({
    top: ports[0].to,
    nodes: graph.nodes.filter((n) => kept.has(n.id)),
    edges: graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
  });
}

export function composeAnswer(question, answer, { truth = null, label = '' } = {}) {
  const slots = answerSlots(question),
    unknowns = new Set(question.nodes.filter((n) => n.concept === 'amr-unknown').map((n) => n.id));
  if (!slots.length && truth !== null) {
    const graph = {
      top: question.top,
      nodes: question.nodes.filter((n) => !unknowns.has(n.id)),
      edges: question.edges.filter((e) => !unknowns.has(e.from) && !unknowns.has(e.to)),
    };
    if (!truth) {
      if (graph.edges.some((e) => e.from === graph.top && e.role === ':polarity'))
        throw new Error('Use an affirmative question before choosing No.');
      graph.nodes.push({ id: 'answer:negative', concept: '-', literal: '-' });
      graph.edges.push({
        id: 'answer:polarity',
        from: graph.top,
        role: ':polarity',
        to: 'answer:negative',
      });
    }
    return { graph: validateGraph(graph), operation: 'authored-polarity', truth };
  }
  if (!answer) throw new Error('This question needs an answer or can be kept open.');
  // An interrogative can match itself structurally, but never supplies its own evidence.
  if (answer.nodes.some((n) => n.concept === 'amr-unknown' || n.concept === 'amr-empty'))
    throw new Error(
      'This answer still has an unknown. Keep it open or give a supporting sentence.',
    );
  const complete = connectQuestion(question, answer);
  if (complete.matches.length) {
    return {
      graph: validateGraph(structuredClone(answer)),
      operation: 'supporting-assertion',
      derivation: complete.matches[0].derivation,
    };
  }
  const supported = complete.branches.filter((branch) => branch.complete && branch.matches.length);
  if (supported.length)
    return {
      graph: validateGraph(structuredClone(answer)),
      operation: 'supporting-partial-assertion',
      connection: 'partial',
      branches: supported.map(({ root, ports, matches }) => ({ root, ports, matches })),
    };
  if (
    answer.nodes.some(
      (n) => n.concept === question.nodes.find((n) => n.id === question.top)?.concept,
    )
  )
    return {
      graph: validateGraph(structuredClone(answer)),
      operation: 'supporting-observation',
      connection: 'unresolved',
    };
  if (slots.length !== 1)
    throw new Error('Give a supporting sentence, or develop one unanswered part at a time.');
  const slot = slots[0].id,
    names = new Map(answer.nodes.map((n) => [n.id, n.id === answer.top ? slot : `answer:${n.id}`]));
  const graph = {
    top: question.top === slot ? names.get(answer.top) : question.top,
    nodes: [
      ...question.nodes.filter((n) => !unknowns.has(n.id)),
      ...answer.nodes.map((n) => ({
        ...n,
        id: names.get(n.id),
        ...(n.id === answer.top && label ? { authoredLabel: label } : {}),
      })),
    ],
    edges: [
      ...question.edges.filter(
        (e) => (!unknowns.has(e.from) || e.from === slot) && (!unknowns.has(e.to) || e.to === slot),
      ),
      ...answer.edges.map((e, i) => ({
        ...e,
        id: `answer:e${i}`,
        from: names.get(e.from),
        to: names.get(e.to),
      })),
    ],
  };
  validateGraph(graph);
  const check = connectQuestion(question, graph);
  if (!check.complete || !check.matches.length)
    throw new Error('Answer interface did not compose.');
  return { graph, operation: 'answer-interface', slot, derivation: check.matches[0].derivation };
}

/** Align occurrences through the chart, then resolve only unambiguous local
 * ports. Repeated labels never establish identity across independent branches.
 * This is a proposed/declared correspondence, not an entailment test.
 */
export function wordingAlignment(
  source,
  target,
  {
    perspective = false,
    answerNodeId = null,
    answerNodeIds = {},
    account = { work: 0, limit: 100000 },
  } = {},
) {
  const a = inquiryPattern(source),
    b = inquiryPattern(target),
    slots = answerSlots(target),
    leftSlots = answerSlots(source),
    mapping = new Map([[b.variables.get(target.top), a.variables.get(source.top)]]),
    sourceIds = new Map([...a.variables].map(([id, variable]) => [variable, id])),
    targetIds = new Map([...b.variables].map(([id, variable]) => [variable, id]));
  const bind = (targetId, sourceId) => {
    const variable = b.variables.get(targetId),
      mapped = a.variables.get(sourceId);
    if (
      !variable ||
      !mapped ||
      (mapping.has(variable) && mapping.get(variable) !== mapped) ||
      [...mapping].some(([v, value]) => v !== variable && value === mapped)
    )
      throw new Error(
        'The correspondence merges independent participants or changes a shared port.',
      );
    mapping.set(variable, mapped);
  };
  if (answerNodeId) {
    if (!perspective || slots.length !== 1)
      throw new Error('This answer attachment needs one answer slot.');
    bind(slots[0].id, answerNodeId);
  }
  for (const [slot, id] of Object.entries(answerNodeIds)) {
    if (!perspective || !slots.some((n) => n.id === slot))
      throw new Error('This answer attachment is unavailable. Choose an existing participant.');
    bind(slot, id);
  }
  // A single declared answer may move roles. Multiple answers require distinct
  // structural witnesses; array order is never a port correspondence.
  if (!perspective && slots.length === 1 && leftSlots.length === 1)
    bind(slots[0].id, leftSlots[0].id);
  const key = (n) => JSON.stringify([n.concept, n.literal ?? null]);
  const concepts = () => {
    for (const node of target.nodes) {
      if (node.concept === 'amr-unknown' || mapping.has(b.variables.get(node.id))) continue;
      const candidates = source.nodes.filter((n) => key(n) === key(node));
      if (
        candidates.length === 1 &&
        target.nodes.filter((n) => key(n) === key(node)).length === 1 &&
        ![...mapping.values()].includes(a.variables.get(candidates[0].id))
      )
        bind(node.id, candidates[0].id);
    }
  };
  concepts();
  const matcher = createGrammarMatcher(),
    facts = graphFacts(source);
  const compatible = (values) => {
    const resolved = new Map(mapping);
    for (const [variable, id] of Object.entries(values))
      resolved.set(variable, a.variables.get(id));
    if (new Set(resolved.values()).size !== resolved.size) return false;
    return [...resolved].every(([v, mapped]) => {
      const node = target.nodes.find((n) => n.id === targetIds.get(v)),
        original = source.nodes.find((n) => n.id === sourceIds.get(mapped));
      return (
        original &&
        (node.literal === undefined || node.literal === original.literal) &&
        (perspective || node.concept !== 'amr-unknown' || original.concept === 'amr-unknown')
      );
    });
  };
  const resolve = (id) =>
    mapping.has(b.variables.get(id))
      ? sourceIds.get(mapping.get(b.variables.get(id)))
      : b.variables.get(id);
  const structural = target.edges.map((e) => [resolve(e.from), e.role, resolve(e.to)]),
    aligned = structural.length ? matcher.match(structural, facts, { account, limit: 256 }) : null;
  let derivation = null;
  if (aligned && !aligned.complete)
    throw new Error('Correspondence search reached its bound. Develop a smaller part.');
  const candidates = aligned?.matches.filter((match) => compatible(match.values)) ?? [];
  // Exact concept/literal witnesses can disambiguate repeated directed roles.
  // A tie remains open; a graph/node ordering choice is not reference evidence.
  const score = (match) =>
    Object.entries(match.values).filter(
      ([v, id]) =>
        key(target.nodes.find((n) => n.id === targetIds.get(v))) ===
        key(source.nodes.find((n) => n.id === id)),
    ).length;
  const bestScore = Math.max(...candidates.map(score)),
    best = candidates.filter((match) => score(match) === bestScore);
  if (best.length === 1) {
    for (const [v, id] of Object.entries(best[0].values)) bind(targetIds.get(v), id);
    derivation = best[0].derivation;
  } else {
    // Join all already anchored incident roles together. Resolving one edge at
    // a time can silently choose an occurrence in a different branch.
    for (let round = 0; round < target.nodes.length; round++) {
      let changed = false;
      for (const node of target.nodes) {
        const variable = b.variables.get(node.id);
        if (mapping.has(variable)) continue;
        const edges = target.edges.filter(
          (e) =>
            (e.from === node.id && mapping.has(b.variables.get(e.to))) ||
            (e.to === node.id && mapping.has(b.variables.get(e.from))),
        );
        if (!edges.length) continue;
        const found = matcher.match(
          edges.map((e) => [resolve(e.from), e.role, resolve(e.to)]),
          facts,
          { account },
        );
        if (!found.complete)
          throw new Error('Correspondence search reached its bound. Develop a smaller part.');
        const choices = found.matches.filter((match) => compatible(match.values));
        if (choices.length !== 1) continue;
        bind(node.id, choices[0].values[variable]);
        changed = true;
      }
      if (!changed) break;
    }
  }
  return { mapping, derivation };
}

/** Author declares two questions equivalent; the engine compiles the correspondence. */
export function compileWording(
  question,
  alternative,
  { perspective = false, answerNodeId = null, answerNodeIds = {}, isolated = false, account } = {},
) {
  if (perspective) {
    const conditional = conditionalReading(question);
    if (conditional?.reason) throw new Error(conditional.reason);
    // A perspective on a conditional contribution describes its conclusion.
    // It still requires an asserted witness produced by satisfying the condition.
    if (conditional) question = conditional.conclusion;
  }
  const a = inquiryPattern(question, { composeClauses: true }),
    b = inquiryPattern(alternative, { composeClauses: true }),
    left = answerSlots(question),
    right = answerSlots(alternative);
  if (!perspective && left.length !== right.length)
    throw new Error('Use another wording with the same answer slots, or two yes/no questions.');
  const guards = (g) =>
    JSON.stringify([
      g.nodes
        .filter((n) => /^(possible|recommend|obligate|say|report|believe)-\d+$/u.test(n.concept))
        .map((n) => n.concept)
        .sort(),
      g.edges
        .filter((e) => e.role === ':polarity')
        .map((e) => g.nodes.find((n) => n.id === e.to)?.concept)
        .filter((c) => c !== 'amr-unknown')
        .sort(),
    ]);
  if (guards(question) !== guards(alternative))
    throw new Error(
      'These readings differ in negation, possibility or reported belief. Develop that distinction separately.',
    );
  if (scopedGuards(question) !== scopedGuards(alternative))
    throw new Error(
      'These readings move a negation, condition or reported possibility. Develop that distinction separately.',
    );
  const { mapping, derivation } = wordingAlignment(question, alternative, {
    perspective,
    answerNodeId,
    answerNodeIds,
    account,
  });
  const leftNodes = new Map([...a.variables].map(([id, variable]) => [variable, id]));
  // Equal path labels can hide two different occurrences (e.g. repeated
  // :topic branches). Qualifications must agree at the aligned occurrence too.
  const qualification = (graph, edge) =>
    [':polarity', ':condition', ':concession', ':mode'].includes(edge.role) ||
    [edge.from, edge.to].some((id) =>
      /^(possible|recommend|obligate|say|tell|report|quote|think|believe)-\d+$/u.test(
        graph.nodes.find((n) => n.id === id)?.concept,
      ),
    );
  for (const edge of alternative.edges.filter((e) => qualification(alternative, e))) {
    if (
      alternative.nodes.find((n) => n.id === edge.to)?.concept === 'amr-unknown' &&
      edge.role === ':polarity'
    )
      continue;
    const from = leftNodes.get(mapping.get(b.variables.get(edge.from))),
      to = leftNodes.get(mapping.get(b.variables.get(edge.to)));
    if (!question.edges.some((e) => e.from === from && e.to === to && e.role === edge.role))
      throw new Error('This correspondence moves a qualification to another scope or participant.');
  }
  for (const slot of alternative.nodes) {
    const incident = alternative.edges.filter((e) => e.to === slot.id);
    if (incident.length < 2) continue;
    const original = leftNodes.get(mapping.get(b.variables.get(slot.id)));
    if (!original) throw new Error('A shared reference has no corresponding source participant.');
    for (const edge of incident) {
      const from = leftNodes.get(mapping.get(b.variables.get(edge.from))),
        ports = question.edges.filter((e) => e.from === from && e.role === edge.role);
      if (ports.length && !ports.some((e) => e.to === original))
        throw new Error('The correspondence merges independent participants at a shared port.');
    }
  }
  if (perspective) {
    if (right.some((n) => !mapping.has(b.variables.get(n.id)))) {
      const used = new Set(mapping.values());
      const choices = question.nodes.filter(
        (n) =>
          n.literal === undefined &&
          !used.has(a.variables.get(n.id)) &&
          question.edges.some(
            (e) =>
              (e.from === question.top && e.to === n.id) ||
              (e.to === question.top && e.from === n.id),
          ),
      );
      throw Object.assign(
        new Error(
          choices.length
            ? 'Which existing participant answers this perspective?'
            : 'This question asks for a new connection. Develop it separately and supply its answer.',
        ),
        choices.length
          ? {
              code: 'ANSWER_ATTACHMENT',
              choices: choices.map((n) => ({
                id: n.id,
                label:
                  n.authoredLabel ??
                  n.surfaceLabel ??
                  n.concept.replace(/-\d+$/u, '').replaceAll('-', ' '),
              })),
            }
          : {},
      );
    }
    // A new perspective can change the answer position, not the identity of a
    // named participant or literal. Ambiguous attachments remain unbound.
    for (const node of alternative.nodes.filter((n) => n.literal !== undefined)) {
      const variable = mapping.get(b.variables.get(node.id));
      if (
        !variable ||
        question.nodes.find((n) => a.variables.get(n.id) === variable)?.literal !== node.literal
      )
        throw new Error(
          'This reading changes a named participant or value. Develop it as a separate contribution.',
        );
    }
  }
  if (right.some((n) => !mapping.has(b.variables.get(n.id))))
    throw new Error('The answer slots do not have an unambiguous correspondence.');
  if (
    !perspective &&
    right.some(
      (n) => !left.some((slot) => a.variables.get(slot.id) === mapping.get(b.variables.get(n.id))),
    )
  )
    throw new Error('The correspondence changes an answer slot into a fixed participant.');
  // An unchanged frame can retain its occurrence (and independent source
  // count). A changed predicate or role requires an interpretation-local frame.
  const sourceId = (id) => leftNodes.get(mapping.get(b.variables.get(id))),
    isolate =
      isolated ||
      alternative.nodes.some((node) => {
        const original = question.nodes.find((n) => n.id === sourceId(node.id));
        return (
          original &&
          (node.id === alternative.top || /-\d+$/u.test(node.concept)) &&
          original.concept !== node.concept
        );
      }) ||
      alternative.edges.some(
        (edge) =>
          sourceId(edge.from) &&
          !question.edges.some(
            (e) =>
              e.from === sourceId(edge.from) && e.to === sourceId(edge.to) && e.role === edge.role,
          ),
      ),
    shared = isolate ? sharedWordingPorts(question, alternative, a, b, mapping) : mapping;
  const resolve = (v) =>
    v.startsWith('?') ? (shared.get(v) ?? `$v${[...b.variables.values()].indexOf(v)}`) : v;
  const when = a.patterns.map((t) => (t[1] === '@asserted' ? [t[0], t[1], 'true'] : t));
  const then = b.patterns.map((t) =>
    t[1] === '@asserted' ? [resolve(t[0]), t[1], 'true'] : t.map(resolve),
  );
  if (isolate)
    for (const node of alternative.nodes.filter((n) => n.concept !== 'amr-unknown')) {
      const variable = b.variables.get(node.id),
        original = question.nodes.find((n) => a.variables.get(n.id) === mapping.get(variable)),
        label =
          node.authoredLabel ??
          node.surfaceLabel ??
          original?.authoredLabel ??
          original?.surfaceLabel;
      if (label && !shared.has(variable)) then.push([resolve(variable), '@label', label]);
    }
  return validateRule({
    name: perspective ? 'Authored perspective' : 'Authored equivalent question',
    correspondence: {
      ports: Object.fromEntries(
        [...mapping].map(([v, mapped]) => [
          [...b.variables].find(([, variable]) => variable === v)[0],
          leftNodes.get(mapped),
        ]),
      ),
      ...(derivation ? { derivation } : {}),
    },
    when,
    then,
    ...(alternative.edges.some((e) => e.role === ':polarity')
      ? {
          guards: alternative.edges
            .filter(
              (e) =>
                e.role === ':polarity' &&
                alternative.nodes.find((n) => n.id === e.to)?.concept !== 'amr-unknown',
            )
            .map((e) => [resolve(b.variables.get(e.from)), e.role, resolve(b.variables.get(e.to))]),
        }
      : {}),
  });
}

/** Interpretation-local frames cannot add another predicate's roles to a source event.
 * The answer port and unchanged entity descriptions retain their original identities.
 */
function sharedWordingPorts(source, target, a, b, mapping) {
  const shared = new Map();
  const frame = (graph, node) =>
    node.id === graph.top ||
    graph.edges.some(
      (e) => e.from === node.id && (/^:ARG\d/u.test(e.role) || /-\d+$/u.test(node.concept)),
    );
  for (const node of target.nodes) {
    const variable = b.variables.get(node.id),
      mapped = mapping.get(variable),
      original = source.nodes.find((n) => a.variables.get(n.id) === mapped);
    if (!original || node.id === target.top) continue;
    if (
      node.concept === 'amr-unknown' ||
      (node.literal === original.literal &&
        ((!frame(target, node) && !frame(source, original)) || node.concept === original.concept))
    )
      shared.set(variable, mapped);
  }
  // Sharing an entity must not graft a changed name, property or nested frame
  // onto its source occurrence. Propagate this boundary through descriptions.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of target.edges) {
      const from = b.variables.get(edge.from),
        to = b.variables.get(edge.to);
      if (!shared.has(from)) continue;
      const originalFrom = source.nodes.find((n) => a.variables.get(n.id) === shared.get(from)),
        originalTo = source.nodes.find((n) => a.variables.get(n.id) === shared.get(to));
      if (
        !originalTo ||
        !source.edges.some(
          (e) => e.from === originalFrom.id && e.to === originalTo.id && e.role === edge.role,
        )
      ) {
        shared.delete(from);
        changed = true;
      }
    }
  }
  // A constrained answer must remain the selected source participant, never an
  // invented replacement whose label merely resembles that participant.
  if (answerSlots(target).some((n) => !shared.has(b.variables.get(n.id))))
    throw new Error(
      'This answer changes an existing participant. Develop its description separately.',
    );
  return shared;
}

/** Compare scope positions, not just a bag of negative/modal words. */
function scopedGuards(graph) {
  const paths = new Map([[graph.top, []]]),
    queue = [graph.top];
  for (const id of queue)
    for (const edge of [...graph.edges].sort((a, b) => a.role.localeCompare(b.role))) {
      const next = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
      if (next === null || paths.has(next)) continue;
      paths.set(next, [...paths.get(id), `${edge.from === id ? '' : '^'}${edge.role}`]);
      queue.push(next);
    }
  const entries = graph.nodes
    .filter((n) =>
      /^(possible|recommend|obligate|say|tell|report|quote|think|believe)-\d+$/u.test(n.concept),
    )
    .map((n) => [paths.get(n.id), n.concept]);
  for (const edge of graph.edges) {
    const node = graph.nodes.find((n) => n.id === edge.to);
    if (
      [':polarity', ':condition', ':concession', ':mode'].includes(edge.role) &&
      node.concept !== 'amr-unknown'
    )
      entries.push([paths.get(edge.from), edge.role, node.literal ?? node.concept]);
  }
  return JSON.stringify(entries.map(JSON.stringify).sort());
}
