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
import {
  cite,
  clauseText,
  commitment,
  corpusView,
  coverage,
  coverageLines,
  nothing,
  smallest,
  underCondition,
} from './corpus.mjs';

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
  // Within a role, only its statements are asked: what lies outside it is
  // withheld from every question.
  const outside = view.statements
    .filter((item) => !within(item.placementId))
    .map((item) => item.id);
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
    const denied = sides(view.truth(item.graph, { withhold: [...outside, item.id] }));
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
    const withhold = [...outside, rule.item.id];
    const denied = sides(
      view.truth(rule.parts.conclusion, { cases: [rule.parts.condition], withhold }),
    ).filter((binding) => binding.sourceIds.some((id) => view.byId.has(id)));
    // Only about whoever met its condition: someone else's answer is no case
    // of it (the statements saying they met it are cited).
    const occasion = underCondition(view, rule.parts, { withhold });
    const when = condition(rule);
    for (const binding of denied) {
      const met = occasion(binding);
      if (met)
        findings.push({
          method: 'aporia',
          kind: 'in its case',
          summary: 'Under its own condition, the others answer its conclusion the other way.',
          statements: named([rule.item.id, ...met, ...cited([binding])]),
          case: [when],
          question: `When ${when}, both cannot hold: which is meant?`,
        });
    }
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
      // Asked both ways: a conclusion that describes more (the release Morgan
      // manages) may not meet the other's, while the other's meets it.
      const cases = [a.parts.condition, b.parts.condition];
      const opposed = [
        [a, b],
        [b, a],
      ].some(([asked, other]) =>
        sides(view.truth(asked.parts.conclusion, { cases, withhold: outside })).some((binding) =>
          binding.ruleIds.some((id) => view.ruleSource(id) === other.item.id),
        ),
      );
      if (!opposed) continue;
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
  // One pair is one aporia, however it was found: the finding that names its
  // case (when the condition holds) over a plain contradiction of the same
  // statements, in the order they were found (fourth review, #5).
  const kept = new Map();
  const key = (finding) => finding.statements.map(commitment).sort().join('\u0001');
  const narrowed = smallest(findings);
  for (const finding of narrowed)
    if (!kept.has(key(finding)) || (finding.case && !kept.get(key(finding)).case))
      kept.set(key(finding), finding);
  const unique = narrowed.filter((finding) => kept.get(key(finding)) === finding);
  return {
    revision: project.digest,
    ...(scope ? { role: view.role(chosen[0]?.id) ?? role } : {}),
    statements: chosen.length,
    rules: rules.length,
    findings: unique,
    ...coverage(
      view,
      view.statements.filter((item) => within(item.placementId)).map((item) => item.id),
    ),
  };
}

/** The report as plain text, for the CLI. */
export function formatAporia(report) {
  const lines = [
    `Aporia over ${report.statements} statements (${report.rules} rules): ${
      report.findings.length
        ? `${report.findings.length} ${report.findings.length === 1 ? 'place' : 'places'} where they cannot hold together.`
        : `${nothing(report, 'they hold together; nothing opposes')}.`
    }`,
  ];
  for (const finding of report.findings)
    lines.push(
      '',
      `${finding.kind}: ${finding.question}`,
      ...finding.statements.map((item) => `  ${cite(item)}`),
    );
  const notes = coverageLines(report);
  if (notes.length) lines.push('', ...notes);
  return lines.join('\n');
}
