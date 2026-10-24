/** Reading aids over exact recorded text. These never alter graph comparisons. */
import { interpretationEdge } from '../../amr/interpretation.mjs';
import { reviseGraph } from '../../amr/revision.mjs';

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** Name the blocked operation and its exact dependencies in Findings and previews. */
/** A selected case in a few words: its label, else its text or its sources'
 * texts. A check saved before selections were kept names its case as text. */
export function caseName(selection) {
  if (!selection || typeof selection !== 'object') return selection ? String(selection) : '';
  const texts = (selection.sources ?? []).map((source) => source.text).filter(Boolean);
  return selection.label ?? selection.text ?? (texts.length ? texts.join(' ') : 'Selected case');
}

export function unavailableReadings(items) {
  return items.flatMap((item) =>
    item.kind === 'missing source'
      ? [
          ['Unavailable interpretation', item.ruleName ?? item.ruleId],
          ...(item.missingSources ?? []).flatMap((source) => [
            [
              `${source.reasons.includes('not recorded') ? 'Missing source' : 'Unavailable source'}${source.location ? ` (${source.location})` : ''}`,
              source.text,
            ],
            ...(!source.reasons.includes('not recorded')
              ? [['Reason', source.reasons.join('; ')]]
              : []),
          ]),
        ]
      : item.sourceText
        ? [
            ['Source', item.sourceText],
            ['Parse', item.kind],
          ]
        : [['Unavailable', item.kind]],
  );
}

function unique(text, phrase) {
  if (!phrase) return null;
  const matches = [
    ...text.matchAll(
      new RegExp(
        `(?<![\\p{L}\\p{N}_])${escape(phrase).replaceAll(' ', '\\s+')}(?![\\p{L}\\p{N}_])`,
        'giu',
      ),
    ),
  ];
  return matches.length === 1
    ? { start: matches[0].index, end: matches[0].index + matches[0][0].length }
    : null;
}
export function nodeReading(graph, id, text = '', seen = new Set()) {
  const node = graph.nodes.find((item) => item.id === id);
  if (!node) return { label: id, parse: id, span: null };
  const parse = `${node.concept} [${id}]`;
  if (seen.has(id)) return { label: node.concept, parse, span: null };
  const next = new Set([...seen, id]);
  const stem = node.concept.replace(/-\d+$/u, '').replaceAll('-', ' ').replace(/^"|"$/gu, '');
  const duplicate = graph.nodes.filter((item) => item.concept === node.concept).length !== 1;
  let span = null;
  if (!duplicate) {
    span = unique(text, stem);
    // A question marker can highlight its unique question word, never supply a binding.
    if (node.concept === 'amr-unknown') {
      const words = [...text.matchAll(/\b(which|what|who|whom|whose|where|when|why|how)\b/giu)];
      if (words.length === 1)
        span = { start: words[0].index, end: words[0].index + words[0][0].length };
    }
    if (span)
      for (const edge of graph.edges.filter((item) => item.from === id && item.role === ':mod')) {
        const modifier = nodeReading(graph, edge.to, text, next).span;
        if (
          modifier &&
          modifier.end < span.start &&
          /^\s+$/u.test(text.slice(modifier.end, span.start))
        )
          span = { start: modifier.start, end: span.end };
      }
  }
  return {
    label: span ? `“${text.slice(span.start, span.end)}”` : `${stem}${duplicate ? ` [${id}]` : ''}`,
    parse,
    span,
  };
}
export function relationReading(graph, edge, text = '') {
  const from = nodeReading(graph, edge.from, text),
    to = nodeReading(graph, edge.to, text);
  const unknown = graph.nodes.find(
    (node) => [edge.from, edge.to].includes(node.id) && node.concept === 'amr-unknown',
  );
  return {
    label: unknown
      ? `Answer: ${unknown.id === edge.from ? to.label : from.label}`
      : `${from.label} → ${to.label}`,
    parse: interpretationEdge(graph, edge),
    spans: [from.span, to.span].filter(Boolean),
  };
}
export function nodeChoices(graph, text, contextLabel, filter = () => true) {
  return graph.nodes.filter(filter).map((node) => {
    const reading = nodeReading(graph, node.id, text);
    return {
      label: reading.label,
      node,
      highlights: reading.span ? [{ label: contextLabel, ...reading.span }] : [],
      details: [
        ['Parse', [reading.parse]],
        [
          'Relations',
          graph.edges
            .filter((edge) => edge.from === node.id || edge.to === node.id)
            .map((edge) => relationReading(graph, edge, text).parse),
        ],
      ].filter(([, lines]) => lines.length),
    };
  });
}

export function parseChanges(original, edits) {
  let graph = original;
  return edits.map((edit) => {
    const before = graph;
    try {
      graph = reviseGraph(graph, [edit], false);
    } catch {
      return `${edit.kind}: ${edit.id ?? edit.role ?? ''}`;
    }
    const oldNode = before.nodes.find((node) => node.id === edit.id),
      nextNode = graph.nodes.find((node) => node.id === edit.id);
    const oldEdge = before.edges.find((edge) => edge.id === edit.id),
      nextEdge = graph.edges.find((edge) => edge.id === edit.id);
    if (edit.kind === 'top')
      return `Root: ${before.nodes.find((node) => node.id === before.top)?.concept} → ${graph.nodes.find((node) => node.id === graph.top)?.concept}`;
    if (edit.kind === 'node') return `${oldNode.concept} → ${nextNode.concept}`;
    if (edit.kind === 'edge') {
      const reading = (g, edge) => `${interpretationEdge(g, edge)} [${edge.from} → ${edge.to}]`;
      return `${reading(before, oldEdge)} → ${reading(graph, nextEdge)}`;
    }
    const value = edit.kind.endsWith('node')
      ? (nextNode?.concept ?? oldNode?.concept)
      : nextEdge
        ? interpretationEdge(graph, nextEdge)
        : interpretationEdge(before, oldEdge);
    return `${edit.kind.startsWith('remove') ? '−' : '+'} ${value}${edit.kind.endsWith('node') ? ` [${edit.id}]` : ''}`;
  });
}

/** Show the effect of each saved edit, keeping repeated concepts distinguishable. */
export function parseChangeRows(original, edits) {
  let graph = original;
  const node = (g, id) => {
    const concept = g?.nodes.find((item) => item.id === id)?.concept;
    return concept ? `${concept} [${id}]` : (id ?? 'Unavailable');
  };
  const edge = (g, value) =>
    value ? `${node(g, value.from)} ${value.role} → ${node(g, value.to)}` : 'Unavailable';
  return edits.map((edit) => {
    const before = graph;
    try {
      graph = before ? reviseGraph(before, [edit], false) : null;
    } catch {
      graph = null;
    }
    if (edit.kind === 'top')
      return ['Change root', node(before, before?.top), node(graph, edit.id)];
    if (edit.kind.endsWith('node') || edit.kind === 'node') {
      const added = edit.kind === 'add-node',
        removed = edit.kind === 'remove-node';
      return [
        added ? 'Add concept' : removed ? 'Remove concept' : 'Change concept',
        added ? '—' : node(before, edit.id),
        removed ? '—' : graph ? node(graph, edit.id) : `${edit.concept} [${edit.id}]`,
      ];
    }
    const added = edit.kind === 'add-edge',
      removed = edit.kind === 'remove-edge';
    return [
      added ? 'Add relation' : removed ? 'Remove relation' : 'Change relation',
      added
        ? '—'
        : edge(
            before,
            before?.edges.find((item) => item.id === edit.id),
          ),
      removed ? '—' : edge(graph, graph?.edges.find((item) => item.id === edit.id) ?? edit),
    ];
  });
}

export function mappingReading(item, { query, source, queryText, sourceText }) {
  const left = nodeReading(query, item.queryNodeId, queryText).label;
  const right = nodeReading(source, item.sourceNodeId, sourceText).label;
  return left === right
    ? `${left} [${item.queryConcept}] ↔ ${right} [${item.sourceConcept}]`
    : `${left} ↔ ${right}`;
}

export function proposalReading(proposal, { query, source, queryText, sourceText, caseLabel }) {
  const q = (id) => nodeReading(query, id, queryText).label;
  const s = (id) => nodeReading(source, id, sourceText).label;
  if (proposal.kind !== 'local-interpretation-v2')
    return `${proposal.correspondence.queryConcept} ↔ ${proposal.correspondence.sourceConcept}`;
  return [
    ...proposal.mappings.map((item) =>
      mappingReading(item, { query, source, queryText, sourceText }),
    ),
    ...(proposal.binding
      ? [`Answer: ${q(proposal.binding.queryNodeId)} → ${s(proposal.binding.sourceNodeId)}`]
      : []),
    ...(proposal.caseBinding
      ? [`Case: ${q(proposal.caseBinding.queryNodeId)} → ${caseLabel}`]
      : []),
    ...(proposal.queryEdits.length + proposal.sourceEdits.length
      ? [`Parse Δ: ${proposal.queryEdits.length + proposal.sourceEdits.length}`]
      : []),
  ].join('\n');
}
