/** Display a graph as AMR; aliases and traversal never change the stored graph. */
export function graphPenmanLines(graph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node])),
    seen = new Set(),
    edges = new Set(),
    lines = [],
    variables = new Map(),
    reserved = new Set(nodes.keys());
  const isLiteral = (node) => node.literal !== undefined || node.id.startsWith('literal:');
  for (const node of graph.nodes) {
    if (isLiteral(node)) continue;
    let name = node.id;
    if (!/^[a-zA-Z_][\w-]*$/u.test(name)) {
      let index = variables.size;
      do name = `v${index++}`;
      while (reserved.has(name));
      reserved.add(name);
    }
    variables.set(node.id, name);
  }
  const literal = (node) => {
    if (node.literal !== undefined) {
      let value = node.literal;
      try {
        value = JSON.parse(value);
      } catch {
        // PENMAN also has bare symbols, such as polarity and mode values.
      }
      if (String(value) === node.concept) return node.literal;
    }
    return /^(?:[-+]|-?\d+(?:\.\d+)?)$/.test(node.concept)
      ? node.concept
      : JSON.stringify(node.concept);
  };
  const visit = (id, depth, prefix = '', edgeId = null) => {
    const node = nodes.get(id),
      indent = '  '.repeat(depth);
    if (!node) {
      lines.push({ text: `${indent}${prefix}${id} (missing)`, nodeId: id, edgeId });
      return;
    }
    if (seen.has(id) || isLiteral(node)) {
      lines.push({
        text: `${indent}${prefix}${isLiteral(node) ? literal(node) : variables.get(id)}`,
        nodeId: id,
        edgeId,
      });
      seen.add(id);
      return;
    }
    seen.add(id);
    lines.push({
      text: `${indent}${prefix}(${variables.get(id)} / ${node.concept}`,
      nodeId: id,
      edgeId,
    });
    for (const edge of graph.edges) {
      if (edges.has(edge.id) || (edge.from !== id && edge.to !== id)) continue;
      edges.add(edge.id);
      const forward = edge.from === id;
      visit(
        forward ? edge.to : edge.from,
        depth + 1,
        `${edge.role}${forward ? '' : '-of'} `,
        edge.id,
      );
    }
    lines.at(-1).text += ')';
  };
  visit(graph.top, 0);
  for (const node of graph.nodes)
    if (!seen.has(node.id)) {
      lines.push({ text: '# Disconnected component' });
      visit(node.id, 0);
    }
  return lines;
}

export function graphEditorRows(form, text) {
  const { row } = text,
    { graph, evaluation = [] } = form.graphEditor;
  const lines = graphPenmanLines(graph),
    items = form.move.flatMap((choice, index) => [
      ...(choice.group !== form.move[index - 1]?.group
        ? [...(index ? [{ label: '' }] : []), { label: choice.group, heading: true }]
        : []),
      { choice, index, label: `${index === form.index ? '●' : ' '} ${choice.label}` },
    ]);
  const selected = form.move[form.index];
  const entries = Array.from({ length: Math.max(lines.length, items.length) }, (_, index) => {
    const item = items[index],
      line = lines[index];
    return {
      cells: [item?.label ?? '', line?.text ?? ''],
      choiceIndex: item?.choice ? item.index : undefined,
      cellTones: {
        0: item?.heading ? 'muted' : item?.index === form.index ? 'selected' : 'plain',
        1:
          selected?.node?.id === line?.nodeId || selected?.edge?.id === line?.edgeId
            ? 'input'
            : 'plain',
      },
    };
  });
  return [
    {
      ...row('', 'plain', 1),
      graphTable: true,
      table: {
        headers: ['Graph items', 'AMR preview'],
        widths: [24, null],
        minWidth: 0,
        repeatColumns: 0,
        entries,
      },
    },
    ...(evaluation.length
      ? [
          row(),
          {
            ...row('', 'plain', 1),
            table: {
              headers: ['Evaluation', 'Current', 'Proposed'],
              widths: [20, null, null],
              minWidth: 54,
              repeatColumns: 0,
              entries: evaluation.map((cells) => ({ cells, cellTones: { 1: 'muted' } })),
            },
          },
        ]
      : []),
  ];
}
