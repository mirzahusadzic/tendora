/** Read-only AMR path and scope diagnostics for source-first exploration.
 * These descriptions never establish a world answer or merge source events.
 */
import { focus } from './graph.mjs';

export function path(graph, start, end) {
  if (start === end) return [];
  const queue = [start];
  const seen = new Map([[start, null]]);
  for (let i = 0; i < queue.length; i++) {
    for (const step of graph.adjacent.get(queue[i]) ?? []) {
      if (seen.has(step.to)) continue;
      seen.set(step.to, { from: queue[i], ...step });
      if (step.to === end) {
        const result = [];
        for (let node = end; node !== start; node = seen.get(node).from)
          result.unshift(seen.get(node));
        return result;
      }
      queue.push(step.to);
    }
  }
  return null;
}
export function showPath(graph, start, steps) {
  if (!steps) return 'no path in this sentence graph';
  return `${graph.labels.get(start)}${steps
    .map(
      (step) =>
        ` ${step.forward ? `─${step.role}→` : `←${step.role}─`} ${graph.labels.get(step.to)}`,
    )
    .join('')}`;
}
// Display-only filter for choosing readable anchor pairs. It never removes
// these nodes from the retained graph or changes sentence retrieval.
const scaffolding = new Set([
  'amr-unknown',
  '-',
  'person',
  'thing',
  'name',
  'date-entity',
  'and',
  'or',
  'multi-sentence',
  'truth-value',
  'both',
]);
export function sharedPath(query, source) {
  const queryIds = [...query.labels].filter(([, label]) => !scaffolding.has(label));
  const sourceIds = [...source.labels].filter(([, label]) => !scaffolding.has(label));
  let chosen = null;
  for (let a = 0; a < queryIds.length; a++)
    for (let b = a + 1; b < queryIds.length; b++) {
      const [qa, first] = queryIds[a],
        [qb, second] = queryIds[b];
      if (first === second) continue;
      const sa = sourceIds.find(([, label]) => label === first)?.[0];
      const sb = sourceIds.find(([, label]) => label === second)?.[0];
      if (!sa || !sb) continue;
      const qp = path(query, qa, qb),
        sp = path(source, sa, sb);
      if (!qp || !sp || qp.length < 2) continue;
      const roles = (steps) =>
        steps.map((step) => `${step.forward ? '>' : '<'}${step.role}`).join(' ');
      const sameRoles = roles(qp) === roles(sp);
      const queryConcepts = [query.labels.get(qa), ...qp.map((step) => query.labels.get(step.to))];
      const sourceConcepts = [
        source.labels.get(sa),
        ...sp.map((step) => source.labels.get(step.to)),
      ];
      const sameConcepts = queryConcepts.every((label, i) => label === sourceConcepts[i]);
      const touchesFocus =
        qa === focus(query) || qb === focus(query) || qp.some((step) => step.to === focus(query));
      const score =
        (sameRoles ? 100 : 0) +
        (touchesFocus ? 50 : 0) +
        (sameConcepts ? 30 : 0) +
        Math.min(qp.length, 8) -
        Math.abs(qp.length - sp.length);
      if (!chosen || score > chosen.score)
        chosen = {
          qa,
          sa,
          qp,
          sp,
          sameRoles,
          sameConcepts,
          touchesFocus,
          score,
        };
    }
  return chosen;
}
function describe(graph, id) {
  const label = graph.labels.get(id);
  const named = graph.edges
    .filter((edge) => edge.from === id && edge.role === ':name')
    .flatMap((edge) =>
      graph.edges
        .filter((part) => part.from === edge.to && /^:op\d+$/u.test(part.role))
        .map((part) => graph.labels.get(part.to)),
    );
  const frames = graph.edges
    .filter((edge) => edge.to === id && /^:ARG\d+$/u.test(edge.role))
    .map((edge) => graph.labels.get(edge.from))
    .filter((value) => /-\d\d$/u.test(value));
  return `${label}${named.length ? `(${named.join(' ')})` : ''}${frames.length ? `[${[...new Set(frames)].sort().join(', ')}]` : ''}`;
}
function compatibleReferent(query, queryId, source, sourceId) {
  if (query.labels.get(queryId) !== source.labels.get(sourceId)) return false;
  const named = (graph, id) =>
    graph.edges
      .filter((edge) => edge.from === id && edge.role === ':name')
      .flatMap((edge) =>
        graph.edges
          .filter((part) => part.from === edge.to && /^:op\d+$/u.test(part.role))
          .map((part) => graph.labels.get(part.to)),
      );
  const queryNames = named(query, queryId),
    sourceNames = named(source, sourceId);
  if (queryNames.length && sourceNames.length && queryNames.join(' ') !== sourceNames.join(' '))
    return false;
  const frames = (graph, id) =>
    graph.edges
      .filter((edge) => edge.to === id && /^:ARG\d+$/u.test(edge.role))
      .map((edge) => graph.labels.get(edge.from))
      .filter((value) => /-\d\d$/u.test(value));
  const queryFrames = frames(query, queryId),
    sourceFrames = frames(source, sourceId);
  return (
    !queryFrames.length ||
    !sourceFrames.length ||
    queryFrames.some((value) => sourceFrames.includes(value))
  );
}
export function localOpening(query, source) {
  const queryFocus = focus(query),
    concept = query.labels.get(queryFocus);
  const possible = [...source.labels].filter(([, label]) => label === concept).map(([id]) => id);
  if (!possible.length)
    return `exact query focus ${concept} is absent; a semantic bridge is needed`;
  const queryEdges = query.edges.filter(
    (edge) => edge.from === queryFocus && edge.role !== ':polarity',
  );
  const selected = possible.sort(
    (a, b) =>
      queryEdges.filter((edge) =>
        source.edges.some((item) => item.from === b && item.role === edge.role),
      ).length -
      queryEdges.filter((edge) =>
        source.edges.some((item) => item.from === a && item.role === edge.role),
      ).length,
  )[0];
  const missing = queryEdges.flatMap((edge) => {
    const peers = source.edges.filter((item) => item.from === selected && item.role === edge.role);
    if (!peers.length) return [`${edge.role} absent at ${concept}`];
    if (query.labels.get(edge.to) === 'amr-unknown') return [];
    return peers.some((item) => compatibleReferent(query, edge.to, source, item.to))
      ? []
      : [
          `${edge.role} query=${describe(query, edge.to)}, source=${peers.map((item) => describe(source, item.to)).join(' / ')}`,
        ];
  });
  const polarity = source.edges.find((edge) => edge.from === selected && edge.role === ':polarity');
  if (polarity)
    missing.unshift(`source ${concept} has :polarity ${source.labels.get(polarity.to)}`);
  return missing.length
    ? missing.join('; ')
    : `local roles resemble ${concept}; referents, scope, and any cross-sentence join remain unqualified`;
}
export function visibleScope(graph) {
  const edges = graph.edges.filter((edge) =>
    [':polarity', ':time', ':mode', ':condition'].includes(edge.role),
  );
  return (
    `root=${graph.labels.get(graph.top)}; ` +
    (edges.length
      ? edges
          .slice(0, 6)
          .map((edge) => `${graph.labels.get(edge.from)} ${edge.role} ${graph.labels.get(edge.to)}`)
          .join('; ') + (edges.length > 6 ? `; +${edges.length - 6} more` : '')
      : 'no explicit polarity/time/mode/condition edge')
  );
}
export function focusArgumentPath(query, source) {
  const queryFocus = focus(query);
  const sourceFocus = [...source.labels].find(
    ([, label]) => label === query.labels.get(queryFocus),
  )?.[0];
  if (!sourceFocus) return null;
  const candidates = query.edges
    .filter(
      (edge) =>
        edge.from === queryFocus &&
        edge.role !== ':polarity' &&
        !scaffolding.has(query.labels.get(edge.to)),
    )
    .flatMap((edge) =>
      [...source.labels]
        .filter(([, label]) => label === query.labels.get(edge.to))
        .map(([target]) => ({
          role: edge.role,
          label: query.labels.get(edge.to),
          steps: path(source, sourceFocus, target),
        })),
    )
    .filter((item) => item.steps);
  candidates.sort((a, b) => b.steps.length - a.steps.length);
  return candidates.length ? { start: sourceFocus, ...candidates[0] } : null;
}
