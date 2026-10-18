/** Gildea, Satta & Peng (2019), Algorithm 2 and section 5.2.
 * Orders are explicit; optimality is relative to that order.
 * Terminals are hyperedges. Their endpoints form a clique for decomposition.
 */
export function orderedDecomposition(vertices, terminals) {
  const n = vertices.length;
  if (n > 128)
    throw Object.assign(new Error('Ordered decomposition exceeds 128 vertices'), {
      code: 'GRAMMAR_LIMIT',
    });
  const positions = new Map(vertices.map((v, i) => [v, i]));
  if (positions.size !== n) throw new Error('Duplicate decomposition vertex');
  const bits = vertices.map((_, i) => 1n << BigInt(i));
  const adjacency = bits.map(() => 0n);
  for (const terminal of terminals) {
    const ends = terminal.vertices.map((v) => {
      if (!positions.has(v)) throw new Error('Undeclared terminal endpoint');
      return positions.get(v);
    });
    for (const a of ends) for (const b of ends) if (a !== b) adjacency[a] |= bits[b];
  }
  const table = Array.from({ length: n + 1 }, () => Array(n + 1));
  const count = (value) => {
    let total = 0;
    while (value) {
      value &= value - 1n;
      total++;
    }
    return total;
  };
  for (let i = 0; i <= n; i++) {
    table[i][i] = { span: 0n, outside: 0n, size: 0 };
    let neighbors = 0n,
      span = 0n;
    for (let j = i + 1; j <= n; j++) {
      span |= bits[j - 1];
      neighbors |= adjacency[j - 1];
      const outside = neighbors & ~span;
      table[i][j] = { span, outside, size: Infinity, boundary: count(outside) };
    }
  }
  const separated = (a, b) => !(a.outside & b.span) && !(a.span & b.outside);
  for (let length = 1; length <= n; length++)
    for (let i = 0; i + length <= n; i++) {
      const j = i + length,
        entry = table[i][j];
      for (let k = i + 1; k < j; k++) {
        const left = table[i][k],
          right = table[k][j];
        const size = Math.max(entry.boundary, left.size, right.size);
        if (separated(left, right) && size < entry.size)
          Object.assign(entry, { size, split: k, anchor: false });
      }
      for (let k = i; k < j; k++) {
        const left = table[i][k],
          right = table[k + 1][j];
        const size = Math.max(entry.boundary + 1, left.size, right.size);
        if (separated(left, right) && size < entry.size)
          Object.assign(entry, { size, split: k, anchor: true });
      }
    }
  const bags = [];
  const build = (i, j, parent = null) => {
    const entry = table[i][j],
      k = entry.split;
    const mask = entry.outside | (entry.anchor ? bits[k] : 0n);
    const bag = {
      id: bags.length,
      parent,
      vertices: vertices.filter((_, at) => mask & bits[at]),
      children: [],
    };
    bags.push(bag);
    if (i < j)
      for (const [a, b] of [
        [i, k],
        [entry.anchor ? k + 1 : k, j],
      ])
        if (a < b) bag.children.push(build(a, b, bag.id));
    return bag.id;
  };
  build(0, n);
  return { bags, width: Math.max(0, table[0][n].size - 1), order: vertices };
}

/** One rule per bag; parent/child intersections are the ordered external ports. */
export function extractHrg(vertices, terminals) {
  const decomposition = orderedDecomposition(vertices, terminals);
  const { bags } = decomposition;
  const assigned = bags.map(() => []);
  for (const terminal of terminals) {
    // Choose the deepest containing bag, as permitted by section 5.2.
    const containing = bags.filter((bag) =>
      terminal.vertices.every((v) => bag.vertices.includes(v)),
    );
    const depth = (bag) => (bag.parent === null ? 0 : 1 + depth(bags[bag.parent]));
    const owner = containing.reduce((a, b) => (depth(a) >= depth(b) ? a : b));
    assigned[owner.id].push(terminal);
  }
  const rules = bags.map((bag) => {
    const external =
      bag.parent === null ? [] : bag.vertices.filter((v) => bags[bag.parent].vertices.includes(v));
    const local = [...external, ...bag.vertices.filter((v) => !external.includes(v))];
    const index = (v) => local.indexOf(v);
    return {
      id: bag.id,
      rank: external.length,
      vertices: local,
      terminals: assigned[bag.id].map((term) => ({ ...term, ports: term.vertices.map(index) })),
      children: bag.children.map((id) => ({
        id,
        ports: bags[id].vertices.filter((v) => bag.vertices.includes(v)).map(index),
      })),
    };
  });
  return { ...decomposition, rules, start: 0 };
}

export function graphTerminals(graph) {
  return [
    ...graph.nodes.map((node) => ({
      id: `node:${node.id}`,
      label: JSON.stringify(['concept', node.concept, node.literal ?? null]),
      vertices: [node.id],
    })),
    ...graph.edges.map((edge) => ({
      id: edge.id,
      label: JSON.stringify(['role', edge.role]),
      vertices: [edge.from, edge.to],
    })),
    { id: '@top', label: 'root', vertices: [graph.top] },
    { id: '@assertion', label: 'assertion', vertices: [graph.assertionTop ?? graph.top] },
  ];
}

/** Section 5.3.1: incident terminal labels still generated below each port.
 * Unary concept labels are lexical content; they do not constrain valence.
 */
export function boundaryValences(extracted) {
  const below = new Map();
  const collect = (id) => {
    const rule = extracted.rules[id];
    const terminals = [...rule.terminals, ...rule.children.flatMap((c) => collect(c.id))];
    below.set(id, terminals);
    return terminals;
  };
  collect(extracted.start);
  return extracted.rules.map((rule) =>
    rule.vertices.slice(0, rule.rank).map((port) =>
      below
        .get(rule.id)
        .flatMap((term) =>
          term.vertices.length < 2
            ? []
            : term.vertices.flatMap((v, at) => (v === port ? [[term.label, at]] : [])),
        )
        .sort(),
    ),
  );
}
