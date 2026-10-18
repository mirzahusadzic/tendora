/** Audit query AMR paths without turning local graph overlap into a verdict.
 * A single focus and each `and :opN` branch use the same same-concept check.
 */
const opNumber = (role) => (/^:op\d+$/u.test(role) ? Number(role.slice(3)) : null);
const from = (graph, id) => graph.edges.filter((edge) => edge.from === id && edge.role !== ':wiki');
const name = (graph, id) => graph.labels.get(id) ?? '?';

function value(graph, id) {
  const children = from(graph, id).map((edge) => `${edge.role} ${name(graph, edge.to)}`);
  return `${name(graph, id)}${children.length ? ` [${children.join(', ')}]` : ''}`;
}

function text(root, steps) {
  return (
    root +
    steps
      .map((step) =>
        step.direction === 'out'
          ? ` ─${step.role}→ ${step.concept}`
          : ` ←${step.role}─ ${step.concept}`,
      )
      .join('')
  );
}

function requirements(graph, event, parent) {
  const result = [];
  // A conjunction branch owns its child event, not the parent or the other
  // :opN events. Shared actors can otherwise pull sibling branches into it.
  const excluded = new Set(
    parent
      ? [
          parent,
          ...from(graph, parent)
            .filter((edge) => opNumber(edge.role) !== null && edge.to !== event)
            .map((edge) => edge.to),
        ]
      : [],
  );
  function descend(node, steps, seen) {
    const children = graph.edges.flatMap((edge, index) => {
      if (edge.role === ':wiki') return [];
      // `:polarity amr-unknown` asks for an answer, not a negative fact.
      if (edge.role === ':polarity' && name(graph, edge.to) === 'amr-unknown') return [];
      const direction = edge.from === node ? 'out' : edge.to === node ? 'in' : null;
      if (!direction) return [];
      const next = direction === 'out' ? edge.to : edge.from;
      return seen.has(next) || excluded.has(next)
        ? []
        : [
            {
              next,
              direction,
              role: edge.role,
              concept: name(graph, next),
              edgeId: edge.id ?? `e${index}`,
            },
          ];
    });
    if (!children.length) {
      if (steps.length) result.push(steps);
      return;
    }
    for (const { next, direction, role, concept, edgeId } of children)
      descend(
        next,
        [...steps, { direction, role, concept, edgeId, from: node, to: next }],
        new Set([...seen, next]),
      );
  }
  descend(event, [], new Set([event]));
  // Inverse PENMAN roles are normalized to incoming edges by eGemma. Follow
  // them at every node, including nested `token :ARG1-of form-01` attachments.
  return result.map((steps) => ({
    id: `p:${event}:${steps.map((step) => `${step.direction}${step.edgeId}`).join('/')}`,
    eventNode: event,
    queryNodeIds: [event, ...steps.map((step) => step.to)],
    queryEdgeIds: steps.map((step) => step.edgeId),
    steps,
    text: text(name(graph, event), steps),
  }));
}

function matchPath(graph, event, steps) {
  let trails = [{ node: event, nodeIds: [event], edgeIds: [] }];
  for (const step of steps) {
    trails = trails.flatMap((trail) =>
      graph.edges.flatMap((edge, index) => {
        if (
          edge.role !== step.role ||
          (step.direction === 'out' ? edge.from !== trail.node : edge.to !== trail.node)
        )
          return [];
        const node = step.direction === 'out' ? edge.to : edge.from;
        return name(graph, node) === step.concept
          ? [
              {
                node,
                nodeIds: [...trail.nodeIds, node],
                edgeIds: [...trail.edgeIds, edge.id ?? `e${index}`],
              },
            ]
          : [];
      }),
    );
    if (!trails.length) return null;
  }
  return trails[0]; // one attributed local witness, never a global binding
}

// A provisional question-slot binding is checked separately from exact overlap.
// Pin both the event and the unknown; re-entrancies must refer to the same source
// node throughout a path. Other unknowns are not wildcards.
function matchBoundPath(graph, event, path, queryNode, sourceNode) {
  let trails = [
    {
      node: event,
      nodeIds: [event],
      edgeIds: [],
      bindings: new Map([
        [path.eventNode, event],
        [queryNode, sourceNode],
      ]),
    },
  ];
  for (const step of path.steps) {
    trails = trails.flatMap((trail) =>
      graph.edges.flatMap((edge, index) => {
        if (
          edge.role !== step.role ||
          (step.direction === 'out' ? edge.from !== trail.node : edge.to !== trail.node)
        )
          return [];
        const node = step.direction === 'out' ? edge.to : edge.from;
        if (
          (trail.bindings.has(step.to) && trail.bindings.get(step.to) !== node) ||
          (step.to !== queryNode && name(graph, node) !== step.concept)
        )
          return [];
        return [
          {
            node,
            nodeIds: [...trail.nodeIds, node],
            edgeIds: [...trail.edgeIds, edge.id ?? `e${index}`],
            bindings: new Map([...trail.bindings, [step.to, node]]),
          },
        ];
      }),
    );
    if (!trails.length) return null;
  }
  return trails[0];
}

function questionBindings(query, event, required, source, sourceEvent) {
  const slots = new Map();
  for (const path of required) {
    const step = path.steps[0];
    if (step?.concept === 'amr-unknown' && step.role !== ':polarity') slots.set(step.to, step);
  }
  if (!slots.size) return [];
  const reachable = new Set(),
    seen = new Set([sourceEvent]),
    pending = [sourceEvent];
  while (pending.length) {
    const node = pending.pop();
    for (const [index, edge] of source.edges.entries()) {
      if (edge.role === ':wiki' || (edge.from !== node && edge.to !== node)) continue;
      reachable.add(edge.id ?? `e${index}`);
      const next = edge.from === node ? edge.to : edge.from;
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  const sourceScope = source.edges.flatMap((edge, index) => {
    const id = edge.id ?? `e${index}`;
    if (
      !reachable.has(id) ||
      !(
        [':polarity', ':mode', ':time', ':frequency', ':condition'].includes(edge.role) ||
        [name(source, edge.from), name(source, edge.to)].some((concept) =>
          ['possible-01', 'obligate-01'].includes(concept),
        )
      )
    )
      return [];
    return [
      {
        text: `${name(source, edge.from)} ─${edge.role}→ ${value(source, edge.to)}`,
        sourceNodeIds: [edge.from, edge.to],
        sourceEdgeIds: [id],
      },
    ];
  });
  const result = [];
  for (const [queryNodeId, step] of slots) {
    for (const [index, edge] of source.edges.entries()) {
      if (
        edge.role !== step.role ||
        (step.direction === 'out' ? edge.from !== sourceEvent : edge.to !== sourceEvent)
      )
        continue;
      const sourceNodeId = step.direction === 'out' ? edge.to : edge.from;
      if (name(source, sourceNodeId) === 'amr-unknown') continue;
      const checked = required.map((path) => ({
        path,
        witness: matchBoundPath(source, sourceEvent, path, queryNodeId, sourceNodeId),
      }));
      result.push({
        status: 'provisional',
        queryNodeId,
        sourceNodeId,
        role: step.role,
        direction: step.direction,
        sourceEdgeId: edge.id ?? `e${index}`,
        concept: name(source, sourceNodeId),
        locatedRefs: checked
          .filter((item) => item.witness)
          .map(({ path, witness }) => ({
            queryPathId: path.id,
            sourceNodeIds: witness.nodeIds,
            sourceEdgeIds: witness.edgeIds,
          })),
        openRefs: checked.filter((item) => !item.witness).map((item) => item.path.id),
        // Retain source-side scope even when the inquiry does not mention it.
        sourceScope,
      });
    }
  }
  return result;
}

// Show a source path that follows the same roles up to the first different
// concept. This is a graph alternative, not a claim that the source is false.
function alternatives(graph, event, steps) {
  let frontier = [{ node: event, text: name(graph, event), nodeIds: [event], edgeIds: [] }];
  for (const step of steps) {
    const peers = frontier.flatMap(({ node, text: prefix, nodeIds, edgeIds }) =>
      graph.edges.flatMap((edge, index) => {
        if (
          edge.role !== step.role ||
          (step.direction === 'out' ? edge.from !== node : edge.to !== node)
        )
          return [];
        const next = step.direction === 'out' ? edge.to : edge.from;
        const concept = name(graph, next);
        return [
          {
            node: next,
            concept,
            nodeIds: [...nodeIds, next],
            edgeIds: [...edgeIds, edge.id ?? `e${index}`],
            text:
              prefix +
              (step.direction === 'out'
                ? ` ─${step.role}→ ${concept}`
                : ` ←${step.role}─ ${concept}`),
          },
        ];
      }),
    );
    const exact = peers.filter((peer) => peer.concept === step.concept);
    if (!exact.length) return [...new Map(peers.map((peer) => [peer.text, peer])).values()];
    frontier = exact;
  }
  return [];
}

function sourceContext(graph, event) {
  return graph.edges
    .filter((edge) => edge.to === event)
    .map((edge) => {
      const modifiers = from(graph, edge.from).filter((item) =>
        [':time', ':frequency', ':mode', ':condition', ':polarity'].includes(item.role),
      );
      return (
        `${name(graph, edge.from)} ─${edge.role}→ ${name(graph, event)}` +
        (modifiers.length
          ? `; parent ${modifiers.map((item) => `${item.role} ${value(graph, item.to)}`).join('; ')}`
          : '')
      );
    });
}

function nodeMarkers(graph, event) {
  return from(graph, event)
    .filter((edge) =>
      [':polarity', ':mode', ':time', ':frequency', ':condition'].includes(edge.role),
    )
    .map((edge) => `${edge.role} ${value(graph, edge.to)}`);
}

function inspectNode(query, event, parent, sources, op = null) {
  const concept = name(query, event);
  const required = requirements(query, event, parent);
  const occurrences = sources.flatMap((source, sourceIndex) =>
    source
      ? [...source.labels]
          .filter(([, label]) => label === concept)
          .map(([node]) => ({ source, sourceIndex, node }))
      : [],
  );
  const candidates = occurrences
    .map(({ source, sourceIndex, node }) => {
      const checked = required.map((item) => ({
        item,
        witness: matchPath(source, node, item.steps),
      }));
      const aligned = checked.filter(({ witness }) => witness);
      const open = checked.filter(({ witness }) => !witness);
      return {
        sourceIndex,
        eventNode: node,
        context: sourceContext(source, node),
        bindings: questionBindings(query, event, required, source, node),
        markers: nodeMarkers(source, node),
        aligned: aligned.map(({ item }) => item.text),
        open: open.map(({ item }) => item.text),
        alignedRefs: aligned.map(({ item, witness }) => ({
          queryPathId: item.id,
          sourceNodeIds: witness.nodeIds,
          sourceEdgeIds: witness.edgeIds,
        })),
        openRefs: open.map(({ item }) => item.id),
        alternatives: open.flatMap(({ item }) =>
          alternatives(source, node, item.steps).map((observed) => ({
            expected: item.text,
            expectedPathId: item.id,
            observed: observed.text,
            sourceNodeIds: observed.nodeIds,
            sourceEdgeIds: observed.edgeIds,
          })),
        ),
      };
    })
    .sort((a, b) => b.aligned.length - a.aligned.length || a.sourceIndex - b.sourceIndex);
  // A located path is still not a qualified event or answer. Retain paths
  // not located on any exact same-concept source node for a later visit.
  const unlocated = required
    .filter(
      (item) =>
        !candidates.some((candidate) =>
          candidate.alignedRefs.some((ref) => ref.queryPathId === item.id),
        ),
    )
    .map((item) => ({
      id: item.id,
      text: item.text,
      steps: item.steps,
      queryNodeIds: item.queryNodeIds,
      queryEdgeIds: item.queryEdgeIds,
    }));
  return {
    op,
    concept,
    required: required.map((item) => item.text),
    requiredRefs: required,
    candidates,
    unlocated,
  };
}

function carry(branch) {
  return {
    op: branch.op,
    concept: branch.concept,
    nodeUnlocated: !branch.candidates.length,
    paths: branch.unlocated,
  };
}

/** A participant-selected comparison anchor keeps its own graph attachment. */
export function inspectAnchor(query, sources, event) {
  if (!query?.labels.has(event)) throw new Error('Query anchor unavailable');
  return inspectNode(query, event, null, sources);
}

export function inspectFocus(query, sources, event) {
  if (!query || !event) return null;
  // Examine the action beneath an unambiguous possibility wrapper. Keep the
  // wrapper in requirements: locating the action does not establish modality.
  const seen = new Set();
  while (name(query, event) === 'possible-01' && !seen.has(event)) {
    seen.add(event);
    const actions = from(query, event).filter((edge) => edge.role === ':ARG1');
    if (
      actions.length !== 1 ||
      !/-\d+$/u.test(name(query, actions[0].to)) ||
      seen.has(actions[0].to)
    )
      break;
    event = actions[0].to;
  }
  // Unlike an explicit `and :opN`, a simple focus has no declared wrapper to
  // discard: an incoming edge may be the very modality the question asks for.
  const branch = inspectNode(query, event, null, sources);
  return {
    branch,
    carry: carry(branch),
    opening:
      'Local paths are inventoried; graph overlap alone does not qualify the whole question, its scope, or an answer.',
  };
}

export function inspectConjunction(query, sources) {
  if (!query || name(query, query.top) !== 'and') return null;
  const ops = from(query, query.top)
    .filter((edge) => opNumber(edge.role) !== null)
    .sort((a, b) => opNumber(a.role) - opNumber(b.role));
  if (!ops.length) return null;
  const parentContext = from(query, query.top)
    .filter((edge) => opNumber(edge.role) === null)
    .map((edge) => `${edge.role} ${value(query, edge.to)}`);
  const branches = ops.map((op) => inspectNode(query, op.to, query.top, sources, op.role));
  return {
    parentContext,
    branches,
    carry: branches.map(carry),
    opening:
      'The child graph paths are inventoried; shared scope, cross-sentence bonds, and the parent conjunction are not qualified.',
  };
}
