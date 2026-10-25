/** Analogy: does what holds here hold there? Statements of one relational
 * shape (the same predicate with the same core roles) that differ in who or
 * what fills them are analogous. A rule that applies with one and not with
 * the other is a proposed transfer, asked as a question: never an answer,
 * since the rule says only what it says. Read-only and offline. */
import { ruleParts } from '../../engine/cloze.mjs';
import {
  cite,
  consequences,
  corpusView,
  coverage,
  coverageLines,
  nothing,
  supposedSource,
} from './corpus.mjs';

const core = /^:ARG\d$/u;
// Modal frames hold a claim (may, must, should): its truth is the framed one's.
const modal = new Set(['possible-01', 'obligate-01', 'recommend-01', 'permit-01']);

/** A plain statement's shape and fillers: its claim's predicate, core roles
 * and truth (negated under a modal frame too), and what fills each role (a
 * name, or a concept). */
export function shape(graph) {
  const top = graph.assertionTop ?? graph.top;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const head = nodes.get(top)?.concept;
  if (!head || !/-\d+$/u.test(head)) return null;
  const roles = graph.edges.filter((edge) => edge.from === top && core.test(edge.role));
  if (!roles.length) return null;
  // Negated anywhere down the modal frames ("must not promise") is negated.
  const negatedAt = (id) =>
    graph.edges.some(
      (edge) =>
        edge.from === id && edge.role === ':polarity' && nodes.get(edge.to)?.concept === '-',
    );
  let negated = negatedAt(top);
  for (let at = top; modal.has(nodes.get(at)?.concept);) {
    at = graph.edges.find((edge) => edge.from === at && edge.role === ':ARG1')?.to;
    if (!at) break;
    negated ||= negatedAt(at);
  }
  const filler = (id) => {
    const name = graph.edges.find((edge) => edge.from === id && edge.role === ':name');
    const words = name
      ? graph.edges
          .filter((op) => op.from === name.to && /^:op\d+$/u.test(op.role))
          .map((op) => String(nodes.get(op.to)?.literal ?? '').replace(/^"|"$/gu, ''))
          .join(' ')
      : null;
    return words || nodes.get(id)?.concept;
  };
  return {
    key: JSON.stringify([head, roles.map((edge) => edge.role).sort(), negated]),
    fillers: Object.fromEntries(roles.map((edge) => [edge.role, filler(edge.to)])),
  };
}

export async function analogyReport(project, { signal } = {}) {
  const view = await corpusView(project);
  const shapes = new Map();
  for (const item of view.statements)
    if (item.graph && !ruleParts(item.graph)) {
      const found = shape(item.graph);
      if (!found) continue;
      if (!shapes.has(found.key)) shapes.set(found.key, []);
      shapes.get(found.key).push({ item, fillers: found.fillers });
    }
  // The rules that apply with a statement: what follows from it, supposed in
  // place of itself.
  const applied = new Map();
  const rulesWith = (item) => {
    if (!applied.has(item.id))
      applied.set(
        item.id,
        new Set(
          consequences(
            view,
            supposedSource(project, {
              text: item.text,
              reading: item,
              placementId: item.placementId,
            }),
            { withhold: [item.id] },
          )
            .filter((entry) => entry.statementId)
            .map((entry) => entry.statementId),
        ),
      );
    return applied.get(item.id);
  };
  const findings = [];
  let pairs = 0;
  for (const group of shapes.values())
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]];
        const differs = Object.keys(a.fillers).filter(
          (role) => a.fillers[role] !== b.fillers[role],
        );
        if (!differs.length) continue;
        pairs++;
        signal?.throwIfAborted();
        const [withA, withB] = [rulesWith(a.item), rulesWith(b.item)];
        for (const [from, to, rules, others] of [
          [a, b, withA, withB],
          [b, a, withB, withA],
        ])
          for (const ruleId of rules)
            if (!others.has(ruleId)) {
              const rule = view.byId.get(ruleId);
              const what = differs.map((role) => `${to.fillers[role]} for ${from.fillers[role]}`);
              findings.push({
                method: 'analogy',
                kind: 'transfer',
                summary: `“${rule.text}” applies with “${from.item.text}”, not with “${to.item.text}”, which says the same of ${what.join(', ')}.`,
                statements: view.named([from.item.id, to.item.id, ruleId]),
                question: `Does “${rule.text}” hold for ${differs.map((role) => to.fillers[role]).join(', ')} as for ${differs.map((role) => from.fillers[role]).join(', ')}?`,
              });
            }
      }
  return { revision: project.digest, pairs, findings, ...coverage(view) };
}

/** The report as plain text, for the CLI. */
export function formatAnalogy(report) {
  const lines = [
    `Analogy over ${report.pairs} ${report.pairs === 1 ? 'pair' : 'pairs'} of statements of one shape: ${
      report.findings.length
        ? `${report.findings.length} proposed ${report.findings.length === 1 ? 'transfer' : 'transfers'}.`
        : `${nothing(report, 'no rule applies to one and not the other')}.`
    }`,
  ];
  for (const finding of report.findings)
    lines.push('', finding.question, ...finding.statements.map((item) => `  ${cite(item)}`));
  const notes = coverageLines(report);
  if (notes.length) lines.push('', ...notes);
  return lines.join('\n');
}
