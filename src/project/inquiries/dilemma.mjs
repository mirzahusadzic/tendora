/** Dilemma: does it follow either way? A statement that says one of several
 * alternatives ("either a certificate expires or a payment key leaks", "Maya
 * or Morgan declares it") is split into its alternatives, and each is given
 * as a case. A rule's conclusion that follows under every alternative, and
 * not without one, follows either way; one that follows under some only
 * depends on which alternative holds, which is a question for its author.
 * Read-only and offline. */
import { ruleParts } from '../../engine/cloze.mjs';
import {
  cite,
  clauseText,
  commitment,
  corpusView,
  coverage,
  coverageLines,
  nothing,
} from './corpus.mjs';

/** What an edge leads to, cut from the rest: [node ids]. */
function part(graph, edge) {
  const kept = new Set([edge.to]);
  for (const id of kept)
    for (const other of graph.edges) {
      if (other === edge) continue;
      const next = other.from === id ? other.to : other.to === id ? other.from : null;
      if (next && next !== edge.from && !kept.has(next)) kept.add(next);
    }
  return kept;
}

/** A reading's alternatives, each a reading of its own: the clauses of an
 * "or" that is the claim, or the reading with an "or" participant replaced
 * by each of its members. Null without one. */
export function alternatives(graph) {
  const top = graph.assertionTop ?? graph.top;
  const or = graph.nodes.find((node) => node.concept === 'or');
  if (!or) return null;
  const ops = graph.edges.filter((edge) => edge.from === or.id && /^:op\d+$/u.test(edge.role));
  if (ops.length < 2) return null;
  const parts = ops.map((edge) => part(graph, edge));
  return ops.map((edge, index) => {
    if (or.id === top) {
      const kept = parts[index];
      return {
        top: edge.to,
        nodes: graph.nodes.filter((node) => kept.has(node.id)),
        edges: graph.edges.filter((other) => kept.has(other.from) && kept.has(other.to)),
      };
    }
    // The member stands where the "or" stood; the other members, and what
    // only the "or" carries ("either"), are left out.
    const gone = new Set([
      or.id,
      ...parts.filter((_, other) => other !== index).flatMap((kept) => [...kept]),
      ...graph.edges
        .filter((other) => other.from === or.id && !/^:op\d+$/u.test(other.role))
        .flatMap((other) => [...part(graph, other)]),
    ]);
    return {
      ...graph,
      nodes: graph.nodes.filter((node) => !gone.has(node.id)),
      edges: graph.edges
        .filter((other) => other.from !== or.id)
        .map((other) => (other.to === or.id ? { ...other, to: edge.to } : other))
        .filter((other) => !gone.has(other.from) && !gone.has(other.to)),
    };
  });
}

export async function dilemmaReport(project, { signal } = {}) {
  const view = await corpusView(project);
  const rules = view.statements
    .filter((item) => item.graph)
    .map((item) => ({ item, parts: ruleParts(item.graph) }))
    .filter(({ parts }) => parts && !parts.necessary);
  const ors = view.statements
    .filter((item) => item.graph && !ruleParts(item.graph))
    .map((item) => ({ item, alternatives: alternatives(item.graph) }))
    .filter(({ alternatives: found }) => found);
  const findings = [];
  for (const { item, alternatives: found } of ors) {
    const words = found.map(
      (graph, index) =>
        clauseText(
          item,
          graph.nodes.map((node) => node.id),
        ) ?? `alternative ${index + 1}`,
    );
    for (const rule of rules) {
      signal?.throwIfAborted();
      // Without an alternative it must not follow already.
      const before = view.truth(rule.parts.conclusion, { withhold: [item.id] });
      if ((before.expected === 'Yes' ? before.yes : before.no).length) continue;
      const under = found.map((graph) => {
        const truth = view.truth(rule.parts.conclusion, { cases: [graph], withhold: [item.id] });
        return (truth.expected === 'Yes' ? truth.yes : truth.no).filter((binding) =>
          binding.sourceIds.includes('case-method/s1'),
        );
      });
      const holds = under.map((bindings) => bindings.length > 0);
      if (!holds.some(Boolean)) continue;
      const conclusion =
        clauseText(
          rule.item,
          rule.parts.conclusion.nodes.map((node) => node.id),
        ) ?? rule.item.text;
      const rests = under.flatMap((bindings) =>
        bindings.flatMap((binding) => [
          ...binding.sourceIds,
          ...binding.ruleIds.map(view.ruleSource).filter(Boolean),
        ]),
      );
      const either = holds.every(Boolean);
      findings.push({
        method: 'dilemma',
        kind: either ? 'either way' : 'one way only',
        summary: either
          ? `Whichever holds (${words.join('; ')}), ${conclusion}.`
          : `${conclusion} follows if ${words.filter((_, i) => holds[i]).join('; ')}, not if ${words.filter((_, i) => !holds[i]).join('; ')}.`,
        alternatives: words,
        conclusion,
        statements: view.named([item.id, ...rests]),
        ...(either
          ? {}
          : {
              question: `Which is it: ${words.join(', or ')}? Whether ${conclusion} depends on it.`,
            }),
      });
    }
  }
  // Two rules concluding the same, from the same statements, are one finding.
  const seen = new Set();
  return {
    revision: project.digest,
    alternatives: ors.length,
    findings: findings.filter((finding) => {
      const key = JSON.stringify([finding.kind, finding.statements.map(commitment).sort()]);
      return !seen.has(key) && seen.add(key);
    }),
    ...coverage(view),
  };
}

/** The report as plain text, for the CLI. */
export function formatDilemma(report) {
  const lines = [
    `Dilemma over ${report.alternatives} ${report.alternatives === 1 ? 'statement' : 'statements'} with alternatives: ${
      report.findings.length
        ? `${report.findings.length} ${report.findings.length === 1 ? 'conclusion' : 'conclusions'}.`
        : `${nothing(report, 'nothing follows from any alternative')}.`
    }`,
  ];
  for (const finding of report.findings)
    lines.push(
      '',
      `${finding.kind}: ${finding.summary}`,
      ...(finding.question ? [`  ${finding.question}`] : []),
      ...finding.statements.map((item) => `  ${cite(item)}`),
    );
  const notes = coverageLines(report);
  if (notes.length) lines.push('', ...notes);
  return lines.join('\n');
}
