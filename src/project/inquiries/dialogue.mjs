/** Dialogue: where do two authors' commitments meet or clash? Every
 * statement is asked of the others (a rule under its own condition); where
 * the answer rests on another author's statements, the two authors
 *   clash      when they answer it the other way, and
 *   agree      when they answer it the same way (a commitment both share).
 * Authors are as recorded or declared (provenance.json); "unrecorded" is
 * named as such, not as a person. Read-only and offline. */
import { ruleParts } from '../../engine/cloze.mjs';
import {
  cite,
  commitment,
  corpusView,
  coverage,
  coverageLines,
  smallest,
  underCondition,
  who,
} from './corpus.mjs';
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export async function dialogueReport(project, { signal } = {}) {
  const view = await corpusView(project);
  const authors = [...new Set(view.statements.map((item) => view.author(item.id)))];
  const findings = [];
  const seen = new Set();
  for (const item of view.statements.filter((entry) => entry.graph)) {
    signal?.throwIfAborted();
    const author = view.author(item.id);
    const parts = ruleParts(item.graph);
    // "Only if C, Q" commits to Q requiring C, not to Q: whoever says Q, or
    // denies it, neither shares nor opposes it. Elenchus tests such a claim.
    if (parts?.necessary) continue;
    const truth = view.truth(parts ? parts.conclusion : item.graph, {
      cases: parts && !parts.necessary ? [parts.condition] : [],
      withhold: [item.id],
    });
    const [same, other] = truth.expected === 'Yes' ? [truth.yes, truth.no] : [truth.no, truth.yes];
    // A rule's answer counts only about whoever met its condition: that Lee
    // files no note neither opposes nor shares "if someone reviews logs, they
    // file a note" unless Lee reviews logs (those statements are cited too).
    const occasion = parts ? underCondition(view, parts, { withhold: [item.id] }) : () => [];
    for (const [kind, bindings] of [
      ['clash', other],
      ['agreement', same],
    ])
      for (const binding of bindings) {
        const met = occasion(binding);
        if (!met) continue;
        const cited = [
          ...binding.sourceIds,
          ...binding.ruleIds.map(view.ruleSource).filter(Boolean),
        ].filter((id) => view.byId.has(id));
        const theirs = [...new Set(cited.map(view.author))].filter((name) => name !== author);
        for (const with_ of theirs) {
          const statements = view.named([item.id, ...met, ...cited]);
          const key = JSON.stringify([
            kind,
            [author, with_].sort(),
            statements.map(commitment).sort(),
          ]);
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            method: 'dialogue',
            kind,
            authors: [author, with_],
            via: `${item.id} ${with_}`,
            summary:
              kind === 'clash'
                ? `${who(author)} and ${who(with_)} answer it the other way: “${item.text}”`
                : `${who(author)} and ${who(with_)} both commit to it: “${item.text}”`,
            statements,
            ...(kind === 'clash'
              ? {
                  question: capital(
                    `${who(author)} and ${who(with_)} disagree here: which is meant?`,
                  ),
                }
              : {}),
          });
        }
      }
  }
  return {
    revision: project.digest,
    authors,
    findings: smallest(findings).map(({ via: _via, ...finding }) => finding),
    ...coverage(view),
  };
}

/** The report as plain text, for the CLI. */
export function formatDialogue(report) {
  const clashes = report.findings.filter((finding) => finding.kind === 'clash').length;
  const lines = [
    `Dialogue between ${report.authors.length} authors (${report.authors.join(', ')}): ${clashes} ${clashes === 1 ? 'clash' : 'clashes'}, ${report.findings.length - clashes} shared ${report.findings.length - clashes === 1 ? 'commitment' : 'commitments'}.`,
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
