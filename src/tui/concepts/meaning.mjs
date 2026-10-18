/** Read-only relationships and context marks from retained HRG material. */
import { meaningConcepts } from '../../engine/concepts.mjs';
import { connectQuestion } from '../../amr/development.mjs';
import { canonicalRelation } from '../../amr/roles.mjs';
import { graphPenmanLines } from '../recordings/graph-preview.mjs';

const cache = new WeakMap();
const relationKey = (from, role, to) => JSON.stringify(canonicalRelation([from, role, to]));

// A context join is a structural attachment, not an assessment of the question.
export function contributionContext(contribution, part) {
  if (!contribution.question) return { label: null, marks: new Map() };
  let parts = cache.get(contribution);
  if (!parts) cache.set(contribution, (parts = new Map()));
  if (parts.has(part.id)) return parts.get(part.id);
  const question = contribution.question.graph;
  const marks = new Map();
  const responses =
    part.id === 'question' ? contribution.responses.filter((r) => !r.withdrawn) : [part];
  let joined = 0;
  for (const response of responses) {
    const alignment = connectQuestion(question, response.graph, { partial: true });
    if (!alignment.complete || alignment.matches.length !== 1) continue;
    joined++;
    const bindings = alignment.matches[0].values;
    const mapped = (id) =>
      bindings[alignment.variables.get(id)] ?? (response.composition?.slot === id ? id : null);
    const sourceEdges = new Map(
      response.graph.edges.map((e) => [relationKey(e.from, e.role, e.to), e]),
    );
    for (const edge of question.edges) {
      const from = mapped(edge.from),
        to = mapped(edge.to);
      if (!from || !to) continue;
      const source = sourceEdges.get(relationKey(from, edge.role, to));
      if (!source) continue;
      marks.set(part.id === 'question' ? edge.id : source.id, {
        label: 'Joined context',
        tone: 'located',
      });
    }
  }
  const result = {
    label: !responses.length
      ? 'No contribution'
      : responses.length > 1
        ? `${joined}/${responses.length} joined`
        : joined
          ? 'Joined'
          : 'Open',
    tone: joined ? 'plain' : 'warning',
    marks,
  };
  parts.set(part.id, result);
  return result;
}

// Only exact terminal witnesses from a saved answer derivation receive proof marks.
export function assessmentMarks(source, answer) {
  const facts = new Set();
  const visit = (tree) => {
    if (!tree) return;
    for (const terminal of tree.terminals ?? []) {
      if (!terminal.production) continue;
      try {
        const triple = JSON.parse(terminal.fact);
        if (Array.isArray(triple) && triple.length === 3) facts.add(relationKey(...triple));
      } catch {
        // Older records can retain opaque witness IDs; never guess their relation.
      }
    }
    for (const child of tree.children ?? []) visit(child);
  };
  for (const a of answer?.answers ?? []) visit(a.derivation?.tree);
  return new Map(
    (source.graph?.edges ?? []).flatMap((edge) =>
      facts.has(relationKey(`${source.id}#${edge.from}`, edge.role, `${source.id}#${edge.to}`))
        ? [[edge.id, { label: 'Answer proof', tone: 'located' }]]
        : [],
    ),
  );
}

export function relationMeaning(
  graph,
  {
    text = '',
    sourceId = 'meaning',
    marks = new Map(),
    selectedNodeId = null,
    question = false,
  } = {},
) {
  const material = meaningConcepts(graph, { sourceId, text });
  const entries = new Map(material.entries.map((item) => [item.id, item]));
  const unknowns = new Set(graph.nodes.filter((n) => n.concept === 'amr-unknown').map((n) => n.id));
  const rows = material.entries.flatMap((item) => {
    const parent = entries.get(item.parentId);
    if (!parent || !item.relationProof) return [];
    const edge = graph.edges.find(
      (e) =>
        e.role === item.role &&
        ((e.from === parent.nodeId && e.to === item.nodeId) ||
          (e.to === parent.nodeId && e.from === item.nodeId)),
    );
    if (!edge) return [];
    const mark = marks.get(edge.id);
    const open = unknowns.has(edge.from) || unknowns.has(edge.to);
    return [
      {
        cells: [
          parent.name,
          item.relation,
          item.name + (item.referenceTo ? ' ↩' : ''),
          open ? 'Answer sought' : (mark?.label ?? (question ? 'Question' : 'Authored')),
        ],
        cellTones: { 3: open ? 'warning' : (mark?.tone ?? 'muted') },
        edgeId: edge.id,
        relationProof: item.relationProof,
      },
    ];
  });
  const relations = new Map(rows.map((entry) => [entry.edgeId, entry]));
  const lines = graphPenmanLines(graph).map((line) => {
    const mark = marks.get(line.edgeId);
    const edge = graph.edges.find((e) => e.id === line.edgeId);
    const open = edge && (unknowns.has(edge.from) || unknowns.has(edge.to));
    const selected =
      selectedNodeId &&
      (line.nodeId === selectedNodeId ||
        edge?.from === selectedNodeId ||
        edge?.to === selectedNodeId);
    const relation = relations.get(line.edgeId);
    const state = open ? 'Answer sought' : mark?.label;
    const note = [relation ? `${relation.cells[1]} → ${relation.cells[2]}` : null, state]
      .filter(Boolean)
      .join('; ');
    const spans = [];
    if (note) {
      const role = line.text.match(/:\S+/u);
      if (role && (open || mark || selected))
        spans.push({
          start: role.index,
          end: role.index + role[0].length,
          tone: open ? 'warning' : 'located',
        });
      const start = line.text.length + 3;
      line.text += ` # ${note}`;
      spans.push({
        start,
        end: line.text.length,
        tone: open ? 'warning' : mark || selected ? 'located' : 'muted',
      });
    }
    return { ...line, spans };
  });
  return {
    heading: 'Retained meaning',
    relations: rows,
    graphLines: lines,
  };
}
