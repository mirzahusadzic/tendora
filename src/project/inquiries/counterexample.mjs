/** Counterexample: does a rule or a kind hold everywhere the corpus speaks?
 * For a rule, its conclusion is asked of every statement: where the
 * statements meet its condition it applies, and a counterexample is a case
 * where it applies and the statements also answer its conclusion the other
 * way. For any other statement (a kind among them), a counterexample is the
 * statements answering it the other way. A rule whose condition nothing meets
 * never applies, which is said, not counted as holding. Read-only and
 * offline. */
import { ruleParts } from '../../engine/cloze.mjs';
import { findStatement } from './inspection.mjs';
import {
  applicationOccasion,
  cite,
  clauseText,
  corpusView,
  coverage,
  coverageLines,
  nothing,
  smallest,
} from './corpus.mjs';

export async function counterexampleReport(project, { statement, signal } = {}) {
  const view = await corpusView(project);
  const { named } = view;
  const text = findStatement(project.data, statement).text;
  const item = view.statements.find((entry) => entry.text === text);
  if (!item?.graph)
    return {
      revision: project.digest,
      statement: { text, reading: 'none' },
      findings: [],
      ...coverage(view),
    };
  const subject = { text, role: view.role(item.id), author: view.author(item.id) };
  const parts = ruleParts(item.graph);
  const cited = (bindings) =>
    bindings.flatMap((binding) => [
      ...binding.sourceIds,
      ...binding.ruleIds.map(view.ruleSource).filter(Boolean),
    ]);
  const findings = [];
  if (parts && !parts.necessary) {
    // Where it applies: its conclusion answered through it, the statements
    // meeting its condition. Against it: the same conclusion answered the
    // other way by statements, not through it.
    const truth = view.truth(parts.conclusion);
    const [through, against] =
      truth.expected === 'Yes' ? [truth.yes, truth.no] : [truth.no, truth.yes];
    const applies = through.filter((binding) =>
      binding.ruleIds.some((id) => view.ruleSource(id) === item.id),
    );
    const condition =
      clauseText(
        item,
        parts.condition.nodes.map((node) => node.id),
      ) ?? 'its condition';
    // One counterexample is one occasion: at every participant the rule links
    // from its condition to its conclusion (the reviewer is the one who
    // files), whoever it applied to and whoever the denial names (the conjunct
    // that denies it) may be the same. Different names or identifiers are two
    // occasions; no names at all is no evidence against.
    const sameOccasion = applicationOccasion(view, parts, item.id);
    for (const application of applies)
      for (const denial of against.filter(
        (binding) =>
          !binding.ruleIds.some((id) => view.ruleSource(id) === item.id) &&
          sameOccasion(application, binding),
      )) {
        signal?.throwIfAborted();
        findings.push({
          method: 'counterexample',
          kind: 'rule',
          summary: `The statements meet its condition (${condition}) and answer its conclusion the other way.`,
          statements: named([
            ...application.sourceIds.filter((id) => id !== item.id),
            ...cited([denial]),
          ]),
          question: `When ${condition}, does it hold, or do these statements say otherwise?`,
        });
      }
    return {
      revision: project.digest,
      statement: { ...subject, rule: true },
      applies: applies.length,
      ...(applies.length
        ? {}
        : { never: `Nothing the statements say meets its condition (${condition}).` }),
      findings: smallest(findings),
      ...coverage(view),
    };
  }
  const truth = view.truth(item.graph, { withhold: [item.id] });
  for (const denial of truth.expected === 'Yes' ? truth.no : truth.yes)
    findings.push({
      method: 'counterexample',
      kind: 'statement',
      summary: 'The other statements answer it the other way.',
      statements: named(cited([denial])),
      question: 'Does it hold here, or do these statements say otherwise?',
    });
  return {
    revision: project.digest,
    statement: subject,
    findings: smallest(findings),
    ...coverage(view),
  };
}

/** The report as plain text, for the CLI. */
export function formatCounterexample(report) {
  const { statement } = report;
  const lines = [
    `Counterexamples to “${statement.text}”${statement.role ? ` [${statement.role}]` : ''}`,
  ];
  if (statement.reading === 'none') return `${lines[0]}\nIt has no reading.`;
  if (statement.rule)
    lines.push(
      report.applies
        ? `It applies ${report.applies} ${report.applies === 1 ? 'time' : 'times'}${report.findings.length ? '.' : `, and ${nothing(report, 'nothing says otherwise')}.`}`
        : `It never applies: ${report.never.charAt(0).toLowerCase()}${report.never.slice(1)}`,
    );
  else if (!report.findings.length)
    lines.push(
      report.unread?.length || report.limited
        ? 'Nothing found against it among what was read.'
        : 'Nothing the other statements say opposes it.',
    );
  for (const finding of report.findings)
    lines.push('', finding.summary, ...finding.statements.map((item) => `  ${cite(item)}`));
  const notes = coverageLines(report);
  if (notes.length) lines.push('', ...notes);
  return lines.join('\n');
}
