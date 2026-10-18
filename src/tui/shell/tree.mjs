/** Shared detail tables and tree rendering. */
export const branch = (label, value, children = [], tone = 'plain') => ({
  label,
  value,
  children,
  tone,
});

export const hasSharedPlacements = (data, placementId) => {
  const conceptId = data?.placements.find((placement) => placement.id === placementId)?.conceptId;
  return Boolean(
    conceptId &&
    data.placements.filter((placement) => placement.conceptId === conceptId).length > 1,
  );
};

export function detailTable(nodes) {
  const entries = [];
  const visit = (items, depth = 0) =>
    items.forEach((node) => {
      if (node.label === 'Action' && entries.length) entries.push({ cells: ['', ''] });
      entries.push({
        cells: [`${' '.repeat(depth)}${node.label}`, node.value ?? ''],
        cellTones: { 0: 'muted' },
        tone: node.tone,
      });
      if (node.children?.length) visit(node.children, depth + 1);
    });
  visit(nodes);
  return {
    headers: ['Field', 'Value'],
    widths: [20, null],
    minWidth: 0,
    repeatColumns: 0,
    entries,
  };
}

export function detailSections(nodes) {
  return nodes.map((node) => {
    const fields = node.children.filter((child) => !child.table),
      tables = node.children.flatMap((child) => (child.table ? [child.table] : []));
    return {
      label: node.label,
      ...(fields.length === 1 && !fields[0].children?.length
        ? { rows: [[fields[0].label, fields[0].value, fields[0].tone]] }
        : fields.length
          ? { table: detailTable(fields) }
          : {}),
      ...(tables.length ? { tables } : {}),
    };
  });
}

export function detailRows(nodes, text, { indent = 1, choiceIndex } = {}) {
  const table = (value) => ({
    ...text.row('', 'plain', indent),
    ...(choiceIndex !== undefined ? { choiceIndex } : {}),
    table: value,
  });
  const content = (nodes) => {
    const fields = nodes.filter((node) => !node.table);
    return [
      ...(fields.length ? [table(detailTable(fields))] : []),
      ...nodes.flatMap((node) => (node.table ? [text.row(), table(node.table)] : [])),
    ];
  };
  if (!nodes.some((node) => node.section)) return content(nodes);
  return nodes.flatMap((node, index) =>
    node.section
      ? [
          ...(index ? [text.row()] : []),
          text.row(node.label, 'section'),
          text.row(),
          ...content(node.children),
        ]
      : content([node]),
  );
}

export function treeRows(nodes, text, { indent = 1, choiceIndex } = {}) {
  const result = [];
  function visit(items, prefix = '') {
    items.forEach((node, index) => {
      const last = index === items.length - 1,
        connector = last ? '└─ ' : '├─ ';
      const item = node.label
        ? text.labeledRow([[node.label, node.value ?? '', node.tone]])
        : text.row(node.value, node.tone);
      const before = prefix + connector;
      result.push({
        ...item,
        indent,
        text: before + item.text,
        hangingIndent: before.length + (item.hangingIndent ?? 0),
        spans: [
          { start: 0, end: before.length, tone: 'muted' },
          ...(item.spans ?? []).map((span) => ({
            ...span,
            start: span.start + before.length,
            end: span.end + before.length,
          })),
        ],
        ...(choiceIndex !== undefined ? { choiceIndex } : {}),
      });
      if (node.children?.length) visit(node.children, prefix + (last ? '   ' : '│  '));
    });
  }
  visit(nodes);
  return result;
}
