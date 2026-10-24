/** Executable reading of an explicit AMR condition, independent of the inquiry. */
import { claimRoot } from './patterns.mjs';
import { sourceSemanticTypes } from './semantic-types.mjs';

/** `have-condition-91` is AMR's reified `:condition`: read its :ARG1 under its :ARG2. */
function dereifiedCondition(graph) {
  const top = claimRoot(graph),
    node = graph.nodes.find((n) => n.id === top);
  if (node?.concept !== 'have-condition-91') return graph;
  const out = graph.edges.filter((edge) => edge.from === top),
    conclusion = out.find((edge) => edge.role === ':ARG1'),
    condition = out.find((edge) => edge.role === ':ARG2');
  if (out.length !== 2 || !conclusion || !condition || graph.edges.some((e) => e.to === top))
    return { reason: 'A reified condition with other roles requires an explicit interpretation.' };
  return {
    ...graph,
    top: conclusion.to,
    assertionTop: conclusion.to,
    nodes: graph.nodes.filter((n) => n.id !== top),
    edges: [
      ...graph.edges.filter((edge) => edge.from !== top),
      { ...condition, from: conclusion.to, role: ':condition' },
    ],
  };
}

export function conditionalReading(
  reading,
  literals = new Map(),
  { negativeConclusions = false } = {},
) {
  const graph = dereifiedCondition(reading);
  if (graph.reason) return graph;
  const root = claimRoot(graph),
    conditions = graph.edges.filter((edge) => edge.from === root && edge.role === ':condition');
  if (!conditions.length) return null;
  const fail = (reason) => ({ reason });
  if (
    conditions.length !== 1 ||
    graph.edges.some((edge) => edge.role === ':condition' && edge.from !== root)
  )
    return fail('Nested or multiple conditions require an explicit interpretation.');
  if (graph.edges.some((edge) => edge.role === ':concession'))
    return fail('Concessive conditions require an explicit interpretation.');
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  // “Only when X, Y” says Y requires X, not that X brings Y about: read as a
  // sufficient condition it would answer Yes wherever X holds.
  if (
    graph.edges.some(
      (edge) =>
        edge.from === conditions[0].to &&
        edge.role === ':mod' &&
        nodes.get(edge.to)?.concept === 'only',
    )
  )
    return fail('A necessary condition (only when, only if) requires an explicit interpretation.');
  if (graph.nodes.some((node) => node.concept === 'amr-unknown'))
    return fail('A question cannot supply a conditional assertion.');
  const condition = conditions[0],
    edges = graph.edges.filter((edge) => edge !== condition);
  const reach = (starts, incoming = false, excluded = new Set()) => {
    const seen = new Set(starts),
      queue = [...starts];
    for (const id of queue)
      for (const edge of edges) {
        const next = edge.from === id ? edge.to : incoming && edge.to === id ? edge.from : null;
        if (next !== null && !seen.has(next) && !excluded.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    return seen;
  };
  const head = reach([root]);
  if (head.has(condition.to))
    return fail('The condition also occupies a conclusion role; check the parser’s references.');
  const body = reach([condition.to]);
  if (body.has(root)) return fail('The conclusion occurs inside its own condition.');
  // Include inverse modifiers (e.g. frequent :ARG1 failure), without traversing
  // back into the conclusion through participants shared by both clauses.
  const extra = reach([...body], true, new Set([...head].filter((id) => !body.has(id))));
  for (const id of extra) body.add(id);
  // Head-only inverse modifiers still belong to the conclusion.
  for (const id of reach([...head], true, new Set([...body].filter((id) => !head.has(id)))))
    head.add(id);
  // An explicitly asserted negative antecedent can be matched structurally.
  // Keep its polarity and modal wrapper; absence of a positive fact is not proof.
  // A negative conclusion carries its polarity as an output guard: every fact
  // it derives can be read only with the negation as a witness. Callers that
  // cannot carry guards keep refusing it.
  const negations = edges.filter((edge) => edge.role === ':polarity' && head.has(edge.from));
  if (negations.length && !negativeConclusions)
    return fail('Negative conclusions require an explicit interpretation.');
  const conjunctions = new Set(),
    roots = [];
  let invalidConjunction = false;
  const expand = (id) => {
    if (nodes.get(id)?.concept !== 'and') {
      roots.push(id);
      return;
    }
    if (conjunctions.has(id)) {
      invalidConjunction = true;
      return;
    }
    conjunctions.add(id);
    const children = edges.filter((edge) => edge.from === id);
    if (!children.length || children.some((edge) => !/^:op\d+$/u.test(edge.role))) {
      invalidConjunction = true;
      return;
    }
    for (const edge of children) expand(edge.to);
  };
  expand(condition.to);
  if (invalidConjunction || !roots.length || [...conjunctions].some((id) => head.has(id)))
    return fail('Unsupported condition conjunction.');
  if ([...body].some((id) => nodes.get(id)?.concept === 'or'))
    return fail('Alternative conditions require an explicit interpretation.');
  const names = new Map(
    graph.nodes.map((node, index) => [node.id, `${body.has(node.id) ? '?' : '$'}c${index}`]),
  );
  const triples = (ids, omitConjunctions = false, includeTypes = true) => [
    ...graph.nodes
      .filter((node) => ids.has(node.id) && (!omitConjunctions || !conjunctions.has(node.id)))
      .flatMap((node) => [
        [names.get(node.id), ':instance', node.concept],
        ...(literals.has(node.id) ? [[names.get(node.id), '@literal', literals.get(node.id)]] : []),
        ...(includeTypes ? sourceSemanticTypes(node) : []).map((type) => [
          names.get(node.id),
          '@semanticType',
          type,
        ]),
      ]),
    ...edges
      .filter(
        (edge) =>
          ids.has(edge.from) &&
          ids.has(edge.to) &&
          (!omitConjunctions || !conjunctions.has(edge.from)),
      )
      .map((edge) => [names.get(edge.from), edge.role, names.get(edge.to)]),
  ];
  // Known antecedent concepts do not require optional acquisition annotations.
  // Preserve the declared categories on instantiated consequence participants.
  const when = [
    ...triples(body, true, false),
    ...roots.map((id) => [names.get(id), '@asserted', 'true']),
  ];
  const then = [
    ...triples(head),
    ...graph.nodes
      .filter(
        (n) =>
          head.has(n.id) && names.get(n.id).startsWith('$') && (n.authoredLabel || n.surfaceLabel),
      )
      .map((n) => [names.get(n.id), '@label', n.authoredLabel ?? n.surfaceLabel]),
  ];
  const bound = new Set(when.flat().filter((term) => term.startsWith('?')));
  if (then.flat().some((term) => term.startsWith('?') && !bound.has(term)))
    return fail('A conclusion participant is not bound by the condition.');
  return {
    when,
    then,
    ...(negations.length
      ? { guards: negations.map((edge) => [names.get(edge.from), edge.role, names.get(edge.to)]) }
      : {}),
    root: names.get(root),
    conclusion: {
      top: root,
      nodes: graph.nodes.filter((n) => head.has(n.id)),
      edges: edges.filter((e) => head.has(e.from) && head.has(e.to)),
    },
  };
}
