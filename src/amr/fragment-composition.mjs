/** Connected AMR candidates and source-preserving composition along a given map. */
import { validateGraph } from './revision.mjs';
const key = (value) => JSON.stringify(value);
const edgeKey = (edge) => key([edge.from, edge.role, edge.to]);

export function connectedFragments(graph, bound = 4, limit = Infinity) {
  validateGraph(graph);
  const subsets = new Map(graph.nodes.map((node) => [key([node.id]), [node.id]]));
  for (let size = 1; size < bound; size++)
    for (const ids of [...subsets.values()].filter((ids) => ids.length === size)) {
      const selected = new Set(ids);
      for (const edge of graph.edges) {
        const extra =
          selected.has(edge.from) && !selected.has(edge.to)
            ? edge.to
            : selected.has(edge.to) && !selected.has(edge.from)
              ? edge.from
              : null;
        if (extra !== null) {
          const next = [...ids, extra].sort();
          subsets.set(key(next), next);
          if (subsets.size > limit)
            throw Object.assign(
              new Error(`Connected fragment enumeration reached its ${limit} subset limit`),
              { code: 'FRAGMENT_LIMIT' },
            );
        }
      }
    }
  return [...subsets.values()]
    .filter((ids) => ids.length >= 2)
    .map((ids) => {
      const selected = new Set(ids),
        nodes = graph.nodes.filter((node) => selected.has(node.id));
      return {
        graph: {
          top: nodes.find((node) => node.literal === undefined)?.id ?? nodes[0].id,
          nodes,
          edges: graph.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)),
        },
        boundary: graph.edges.filter((edge) => selected.has(edge.from) !== selected.has(edge.to)),
      };
    });
}

/** An alignment is independently checked against the actual normalized relations. */
export function literalCorrespondence(left, right, pairs) {
  const mapping = new Map(pairs),
    used = new Set(mapping.values()),
    result = [...pairs];
  for (const node of left.nodes.filter(
    (node) => node.literal !== undefined && !mapping.has(node.id),
  )) {
    const incoming = left.edges.filter((edge) => edge.to === node.id);
    const candidates = right.nodes.filter(
      (other) =>
        other.literal === node.literal &&
        other.concept === node.concept &&
        !used.has(other.id) &&
        incoming.length &&
        incoming.every((edge) =>
          right.edges.some(
            (target) =>
              target.from === mapping.get(edge.from) &&
              target.role === edge.role &&
              target.to === other.id,
          ),
        ),
    );
    if (candidates.length === 1) {
      result.push([node.id, candidates[0].id]);
      mapping.set(node.id, candidates[0].id);
      used.add(candidates[0].id);
    }
  }
  return result;
}

export function checkFragmentMap(left, right, pairs) {
  if (
    new Map(pairs).size !== pairs.length ||
    new Set(pairs.map((pair) => pair[1])).size !== pairs.length
  )
    return false;
  const mapping = new Map(literalCorrespondence(left, right, pairs)),
    target = new Map(right.nodes.map((node) => [node.id, node]));
  if (
    mapping.size !== left.nodes.length ||
    new Set(mapping.values()).size !== right.nodes.length ||
    left.nodes.length !== right.nodes.length
  )
    return false;
  if (
    !left.nodes.every(
      (node) =>
        target.get(mapping.get(node.id))?.concept === node.concept &&
        target.get(mapping.get(node.id))?.literal === node.literal,
    )
  )
    return false;
  const mapped = left.edges
    .map((edge) => edgeKey({ ...edge, from: mapping.get(edge.from), to: mapping.get(edge.to) }))
    .sort();
  return key(mapped) === key(right.edges.map(edgeKey).sort());
}

/** Keep the corpus definition separate from the carried case. A joined view is a
 * candidate application, not an assertion that source and case events are identical.
 * Other relational variants can supply maps after their expansions are checked. */
export function composeEnvelopes(source, carried, pairs) {
  validateGraph(source);
  validateGraph(carried);
  const sourceNodes = new Map(source.nodes.map((node) => [node.id, node]));
  const caseNodes = new Map(carried.nodes.map((node) => [node.id, node]));
  const mapping = new Map(pairs);
  if (
    !mapping.size ||
    mapping.size !== pairs.length ||
    new Set(mapping.values()).size !== pairs.length
  )
    throw new Error('Injective interface required');
  for (const [left, right] of mapping)
    if (
      !sourceNodes.has(left) ||
      !caseNodes.has(right) ||
      sourceNodes.get(left).concept !== caseNodes.get(right).concept ||
      sourceNodes.get(left).literal !== caseNodes.get(right).literal
    )
      throw new Error('Interface changes an aligned concept');
  const induced = (graph, ids) => ({
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
  });
  if (
    !checkFragmentMap(
      induced(source, new Set(mapping.keys())),
      induced(carried, new Set(mapping.values())),
      pairs,
    )
  )
    throw new Error('Interface changes an aligned relation');
  const nodes = [],
    embeddings = [{}, {}],
    originNodes = {},
    originEdges = {};
  const addNode = (node, side) => {
    const id = `${node.literal !== undefined ? 'literal:' : 'n'}${nodes.length}`;
    nodes.push({ ...node, id });
    embeddings[side][node.id] = id;
    originNodes[id] = [{ side, node: node.id }];
    return id;
  };
  for (const node of source.nodes) addNode(node, 0);
  const reverse = new Map(pairs.map(([left, right]) => [right, left]));
  for (const node of carried.nodes) {
    if (!reverse.has(node.id)) addNode(node, 1);
    else {
      const id = embeddings[0][reverse.get(node.id)];
      embeddings[1][node.id] = id;
      originNodes[id].push({ side: 1, node: node.id });
    }
  }
  // PENMAN attributes denote constants. Intern equal literal values while
  // retaining every origin. Relation deduplication below then preserves one
  // attribute for each owner/role/value, including reentrant literal inputs.
  const literalValues = new Map(),
    redirected = new Map();
  for (const node of nodes.filter((node) => node.literal !== undefined)) {
    const signature = key([node.concept, node.literal]);
    if (!literalValues.has(signature)) literalValues.set(signature, node.id);
    else redirected.set(node.id, literalValues.get(signature));
  }
  for (const [removed, retained] of redirected) {
    for (const embedding of embeddings)
      for (const [id, target] of Object.entries(embedding))
        if (target === removed) embedding[id] = retained;
    originNodes[retained].push(...originNodes[removed]);
    delete originNodes[removed];
  }
  nodes.splice(0, nodes.length, ...nodes.filter((node) => !redirected.has(node.id)));
  const byRelation = new Map(),
    edges = [];
  for (const [side, graph] of [source, carried].entries())
    for (const edge of graph.edges) {
      const item = {
          from: embeddings[side][edge.from],
          role: edge.role,
          to: embeddings[side][edge.to],
        },
        signature = edgeKey(item);
      if (!byRelation.has(signature)) {
        const id = `e${edges.length}`;
        byRelation.set(signature, id);
        edges.push({ ...item, id });
        originEdges[id] = [];
      }
      originEdges[byRelation.get(signature)].push({ side, edge: edge.id });
    }
  const graph = { top: embeddings[0][source.top], nodes, edges };
  validateGraph(graph);
  return {
    graph,
    embeddings,
    origins: { nodes: originNodes, edges: originEdges },
    anchors: [source, carried].map((input, side) => ({
      side,
      top: embeddings[side][input.top],
      assertionTop: embeddings[side][input.assertionTop ?? input.top],
    })),
    definition: structuredClone(source),
    carried: structuredClone(carried),
    interface: pairs,
  };
}

/** Replay an envelope through its embedding; additions cannot erase its content. */
export function verifyEnvelope(input, composed, side) {
  const embedding = composed.embeddings[side];
  return (
    input.nodes.every((node) =>
      composed.graph.nodes.some(
        (other) =>
          other.id === embedding[node.id] &&
          other.concept === node.concept &&
          other.literal === node.literal,
      ),
    ) &&
    input.edges.every((edge) =>
      composed.graph.edges.some(
        (other) =>
          other.from === embedding[edge.from] &&
          other.role === edge.role &&
          other.to === embedding[edge.to],
      ),
    )
  );
}

/** Diagnostic missing connections under the metric's actual correspondence. */
export function alignmentGaps(query, source, pairs) {
  const mapping = new Map(pairs),
    target = new Map(source.nodes.map((node) => [node.id, node]));
  const compatible = (node) =>
    target.get(mapping.get(node.id))?.concept === node.concept &&
    target.get(mapping.get(node.id))?.literal === node.literal;
  const exact = new Set(query.nodes.filter(compatible).map((node) => node.id));
  const nodes = query.nodes
    .filter((node) => !exact.has(node.id) && node.concept !== 'amr-unknown')
    .map((node) => ({
      ...node,
      candidate: target.get(mapping.get(node.id)) ?? null,
    }));
  const edges = query.edges.filter((edge) => {
    if (query.nodes.find((node) => node.id === edge.to)?.concept === 'amr-unknown') return false;
    return (
      !exact.has(edge.from) ||
      !exact.has(edge.to) ||
      !source.edges.some(
        (other) =>
          other.from === mapping.get(edge.from) &&
          other.role === edge.role &&
          other.to === mapping.get(edge.to),
      )
    );
  });
  return { nodes, edges, matchedNodes: [...exact], correspondence: pairs };
}

export function relationPath(graph, from, to) {
  const queue = [{ node: from, path: [] }],
    seen = new Set([from]);
  for (const item of queue) {
    if (item.node === to) return item.path;
    for (const edge of graph.edges) {
      const next = edge.from === item.node ? edge.to : edge.to === item.node ? edge.from : null;
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push({
          node: next,
          path: [
            ...item.path,
            {
              edge: edge.id,
              from: item.node,
              to: next,
              role: edge.role,
              forward: edge.from === item.node,
            },
          ],
        });
      }
    }
  }
  return null;
}

/** A definitional relation variant. Boundary ports keep its enclosing scope in
 * the context; expanding the occurrence must recover the entire original AMR.
 * This extends the relation vocabulary, without asserting a different predicate. */
export function foldRelation(graph, ids, exposed = []) {
  validateGraph(graph);
  const selected = new Set(ids);
  if (
    selected.size !== ids.length ||
    selected.size < 2 ||
    ids.some((id) => !graph.nodes.some((node) => node.id === id))
  )
    throw new Error('A connected fragment is required');
  if (exposed.some((id) => !selected.has(id)))
    throw new Error('Exposed port is outside the fragment');
  const definition = {
    top: ids.includes(graph.top) ? graph.top : ids[0],
    nodes: graph.nodes.filter((node) => selected.has(node.id)),
    edges: graph.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)),
  };
  if (!ids.every((id) => relationPath(definition, definition.top, id) !== null))
    throw new Error('A connected fragment is required');
  const boundary = graph.edges.filter((edge) => selected.has(edge.from) !== selected.has(edge.to));
  const anchors = [graph.top, graph.assertionTop].filter((id) => selected.has(id));
  const ports = [
    ...new Set([
      ...anchors,
      ...exposed,
      ...boundary.flatMap((edge) => [edge.from, edge.to].filter((id) => selected.has(id))),
    ]),
  ];
  const keep = new Set(ports),
    internalEdges = new Set(definition.edges.map((edge) => edge.id));
  const context = {
    ...graph,
    nodes: graph.nodes.filter((node) => !selected.has(node.id) || keep.has(node.id)),
    edges: graph.edges.filter((edge) => !internalEdges.has(edge.id)),
  };
  return {
    context: structuredClone(context),
    definition: structuredClone(definition),
    ports,
    boundary: structuredClone(boundary),
    occurrence: {
      bindings: Object.fromEntries(ids.map((id) => [id, id])),
      edgeBindings: Object.fromEntries(definition.edges.map((edge) => [edge.id, edge.id])),
    },
  };
}

export function expandRelation(variant) {
  const { context, definition, ports, occurrence } = structuredClone(variant);
  const mapping = occurrence.bindings,
    nodes = [...context.nodes],
    byId = new Map(nodes.map((node) => [node.id, node]));
  if (
    Object.keys(mapping).length !== definition.nodes.length ||
    definition.nodes.some((node) => !Object.hasOwn(mapping, node.id)) ||
    new Set(Object.values(mapping)).size !== definition.nodes.length
  )
    throw new Error('Invalid relation bindings');
  const mapped = (id) => mapping[id];
  for (const node of definition.nodes) {
    const id = mapped(node.id),
      existing = byId.get(id);
    if (ports.includes(node.id)) {
      if (!existing || existing.concept !== node.concept || existing.literal !== node.literal)
        throw new Error('Relation port changes meaning');
    } else {
      if (existing) throw new Error('Relation internal node collides with context');
      const copy = { ...node, id };
      nodes.push(copy);
      byId.set(id, copy);
    }
  }
  const graph = {
    ...context,
    nodes,
    edges: [
      ...context.edges,
      ...definition.edges.map((edge) => ({
        ...edge,
        id: occurrence.edgeBindings?.[edge.id] ?? edge.id,
        from: mapped(edge.from),
        to: mapped(edge.to),
      })),
    ],
  };
  validateGraph(graph);
  return graph;
}
