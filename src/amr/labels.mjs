/** Surface labels for display only; predicate concepts and roles remain unchanged. */
export function labelReading(graph, text, checks = []) {
  const lexical = new Map(checks.filter((c) => c.evidence).map((c) => [c.nodeId, c.evidence]));
  const labels = new Map();
  for (const node of graph.nodes) {
    const name = graph.edges.find((e) => e.from === node.id && e.role === ':name');
    const parts =
      name &&
      graph.edges
        .filter((e) => e.from === name.to && /^:op\d+$/u.test(e.role))
        .sort((a, b) => Number(a.role.slice(3)) - Number(b.role.slice(3)))
        .map((e) => graph.nodes.find((n) => n.id === e.to)?.literal?.replace(/^"|"$/gu, ''))
        .filter(Boolean);
    if (parts?.length) labels.set(node.id, parts.join(' '));
    else if (lexical.has(node.id)) labels.set(node.id, lexical.get(node.id).text);
    else {
      const words = text.match(/[\p{L}][\p{L}'-]*/gu) ?? [];
      const word = words.find(
        (w) =>
          w.toLowerCase() === node.concept ||
          w.toLowerCase() === node.concept + 's' ||
          w.toLowerCase() + 's' === node.concept,
      );
      if (word) labels.set(node.id, word);
      else {
        const descriptors = graph.edges
          .filter((e) => e.to === node.id && /^:ARG[01]$/u.test(e.role))
          .map((e) => lexical.get(e.from))
          .filter((e) => e && e.method !== 'surface');
        if (descriptors.length === 1) labels.set(node.id, descriptors[0].text);
      }
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      labels.has(n.id) ? { ...n, surfaceLabel: labels.get(n.id) } : n,
    ),
  };
}

/** An abstract participant reads by the word its source used for it, when the
 * vocabulary check attested that word: person :ARG0-of conserve-01 is the
 * “conservator”. Concepts and roles stay as acquired.
 */
const abstract = (node) => ['person', 'thing'].includes(node.concept) && !node.surfaceLabel;
export function abstractLabels(graph, text, checks = []) {
  const read = labelReading(graph, text, checks);
  const labels = new Map(read.nodes.map((n) => [n.id, n.surfaceLabel]));
  // A person who holds a role reads by that role's word: the custodian.
  for (const role of graph.nodes.filter((n) =>
    ['have-org-role-91', 'have-rel-role-91'].includes(n.concept),
  )) {
    const holder = graph.edges.find((e) => e.from === role.id && e.role === ':ARG0')?.to,
      title = graph.edges.find((e) => e.from === role.id && e.role === ':ARG2')?.to;
    if (holder && title && !labels.get(holder) && labels.get(title))
      labels.set(holder, labels.get(title));
  }
  return Object.fromEntries(
    graph.nodes.filter((n) => abstract(n) && labels.get(n.id)).map((n) => [n.id, labels.get(n.id)]),
  );
}

/** An answer may bind a predicate used as a noun. It reads by the word the
 * vocabulary check attested for it: commit-01 is “commitments”, never its
 * concept name. Concepts and roles stay as acquired.
 */
const predicate = (node) =>
  /-\d+$/u.test(node.concept) && !/-91$/u.test(node.concept) && !node.surfaceLabel;
export function answerLabels(graph, text, checks = []) {
  const attested = new Map(checks.filter((c) => c.evidence).map((c) => [c.nodeId, c.evidence]));
  return {
    ...Object.fromEntries(
      graph.nodes
        .filter((n) => predicate(n) && attested.has(n.id))
        .map((n) => [n.id, attested.get(n.id).text]),
    ),
    ...abstractLabels(graph, text, checks),
  };
}

/** Apply reading labels to a graph; other nodes keep their labels. */
export function withAbstractLabels(graph, labels = {}) {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      (abstract(n) || predicate(n)) && typeof labels[n.id] === 'string'
        ? { ...n, surfaceLabel: labels[n.id] }
        : n,
    ),
  };
}
