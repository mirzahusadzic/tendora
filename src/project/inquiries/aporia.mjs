/** Aporia: where can the corpus not hold together? Over every statement (or
 * those at and under a role), three searches, each answered by the engine:
 *   contradiction   a statement whose truth the others answer the other way;
 *   in its case     a rule whose conclusion, under its own condition, the
 *                   others answer the other way;
 *   joint case      two rules with opposed conclusions whose conditions, met
 *                   at once, make both apply.
 * Each finding names both sides and the case that brings them together, in
 * the statements' own words, with a question for the people who wrote them;
 * deciding which holds is theirs. A corpus that holds together returns no
 * findings, and says so. Read-only and offline. */
import { projectTree } from '../authoring/project.mjs';
import { ruleParts } from '../../engine/cloze.mjs';
import { resolveInquiryPlacement } from './scope.mjs';
import { clauseText, corpusView, smallest } from './corpus.mjs';

export async function aporiaReport(project, { role = null, signal } = {}) {
  const view = await corpusView(project);
  const { named } = view;
  const rows = new Map(projectTree(project.data).map((row) => [row.placement.id, row]));
  const scope = role ? resolveInquiryPlacement(project, role) : null;
  const within = (placementId) => {
    for (let at = placementId; at; at = rows.get(at)?.placement.parentId)
      if (at === scope) return true;
    return !scope;
  };
  const chosen = view.statements.filter((item) => item.graph && within(item.placementId));
  const rules = chosen
    .map((item) => ({ item, parts: ruleParts(item.graph) }))
    .filter(({ parts }) => parts && !parts.necessary);
  const plain = chosen.filter((item) => !ruleParts(item.graph));
  const sides = (truth) => (truth.expected === 'Yes' ? truth.no : truth.yes);
  const cited = (bindings) =>
    bindings.flatMap((binding) => [
      ...binding.sourceIds,
      ...binding.ruleIds.map(view.ruleSource).filter(Boolean),
    ]);
  const condition = ({ item, parts }) =>
    clauseText(
      item,
      parts.condition.nodes.map((node) => node.id),
    ) ?? 'its condition';
  const findings = [];

  for (const item of plain) {
    signal?.throwIfAborted();
    const denied = sides(view.truth(item.graph, { withhold: [item.id] }));
    for (const binding of denied)
      findings.push({
        method: 'aporia',
        kind: 'contradiction',
        summary: 'A statement the others answer the other way.',
        statements: named([item.id, ...cited([binding])]),
        question: 'Both cannot hold: which is meant?',
      });
  }
  for (const rule of rules) {
    signal?.throwIfAborted();
    const denied = sides(
      view.truth(rule.parts.conclusion, {
        cases: [rule.parts.condition],
        withhold: [rule.item.id],
      }),
    ).filter((binding) => binding.sourceIds.some((id) => view.byId.has(id)));
    const when = condition(rule);
    for (const binding of denied)
      findings.push({
        method: 'aporia',
        kind: 'in its case',
        summary: 'Under its own condition, the others answer its conclusion the other way.',
        statements: named([rule.item.id, ...cited([binding])]),
        case: [when],
        question: `When ${when}, both cannot hold: which is meant?`,
      });
  }
  // Rules whose conclusions oppose (one relation, opposite truth), their
  // conditions given together.
  const top = ({ parts }) =>
    parts.conclusion.nodes.find((node) => node.id === parts.conclusion.top)?.concept;
  const negated = ({ parts }) =>
    parts.conclusion.edges.some(
      (edge) =>
        edge.from === parts.conclusion.top &&
        edge.role === ':polarity' &&
        parts.conclusion.nodes.find((node) => node.id === edge.to)?.concept === '-',
    );
  for (let i = 0; i < rules.length; i++)
    for (let j = i + 1; j < rules.length; j++) {
      const [a, b] = [rules[i], rules[j]];
      if (top(a) !== top(b) || negated(a) === negated(b)) continue;
      signal?.throwIfAborted();
      const truth = view.truth(a.parts.conclusion, {
        cases: [a.parts.condition, b.parts.condition],
      });
      const fromB = sides(truth).filter((binding) =>
        binding.ruleIds.some((id) => view.ruleSource(id) === b.item.id),
      );
      if (!fromB.length) continue;
      const when = [condition(a), condition(b)];
      findings.push({
        method: 'aporia',
        kind: 'joint case',
        summary: 'Two rules with opposed conclusions both apply when their conditions are met.',
        statements: named([a.item.id, b.item.id]),
        case: [...new Set(when)],
        question: `When ${[...new Set(when)].join(' and ')}, both rules apply and oppose: which is meant?`,
      });
    }
  // One pair is one aporia, however it was found.
  const seen = new Set();
  const unique = smallest(findings).filter((finding) => {
    const key = finding.statements
      .map((item) => item.statement)
      .sort()
      .join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    revision: project.digest,
    ...(scope ? { role: view.role(chosen[0]?.id) ?? role } : {}),
    statements: chosen.length,
    rules: rules.length,
    findings: unique,
  };
}

/** The report as plain text, for the CLI. */
export function formatAporia(report) {
  const lines = [
    `Aporia over ${report.statements} statements (${report.rules} rules): ${
      report.findings.length
        ? `${report.findings.length} ${report.findings.length === 1 ? 'place' : 'places'} where they cannot hold together.`
        : 'they hold together; nothing opposes.'
    }`,
  ];
  for (const finding of report.findings)
    lines.push(
      '',
      `${finding.kind}: ${finding.question}`,
      ...finding.statements.map((item) => `  “${item.statement}” [${item.role}] (${item.author})`),
    );
  return lines.join('\n');
}
