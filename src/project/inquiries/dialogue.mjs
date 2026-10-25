/** Dialogue: where do two authors' commitments meet or clash? Every
 * statement is asked of the others (a rule under its own condition); where
 * the answer rests on another author's statements, the two authors
 *   clash      when they answer it the other way, and
 *   agree      when they answer it the same way (a commitment both share).
 * Authors are as recorded or declared (provenance.json); "unrecorded" is
 * named as such, not as a person. Read-only and offline. */
import { ruleParts } from '../../engine/cloze.mjs';
import { corpusView, smallest } from './corpus.mjs';

export async function dialogueReport(project, { signal } = {}) {
  const view = await corpusView(project);
  const authors = [...new Set(view.statements.map((item) => view.author(item.id)))];
  const findings = [];
  const seen = new Set();
  for (const item of view.statements.filter((entry) => entry.graph)) {
    signal?.throwIfAborted();
    const author = view.author(item.id);
    const parts = ruleParts(item.graph);
    const truth = view.truth(parts ? parts.conclusion : item.graph, {
      cases: parts && !parts.necessary ? [parts.condition] : [],
      withhold: [item.id],
    });
    const [same, other] = truth.expected === 'Yes' ? [truth.yes, truth.no] : [truth.no, truth.yes];
    for (const [kind, bindings] of [
      ['clash', other],
      ['agreement', same],
    ])
      for (const binding of bindings) {
        const cited = [
          ...binding.sourceIds,
          ...binding.ruleIds.map(view.ruleSource).filter(Boolean),
        ].filter((id) => view.byId.has(id));
        const theirs = [...new Set(cited.map(view.author))].filter((name) => name !== author);
        for (const with_ of theirs) {
          const statements = view.named([item.id, ...cited]);
          const key = JSON.stringify([
            kind,
            [author, with_].sort(),
            statements.map((entry) => entry.statement).sort(),
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
                ? `${author} and ${with_} answer it the other way: “${item.text}”.`
                : `${author} and ${with_} both commit to it: “${item.text}”.`,
            statements,
            ...(kind === 'clash'
              ? { question: `${author} and ${with_} disagree here: which is meant?` }
              : {}),
          });
        }
      }
  }
  return {
    revision: project.digest,
    authors,
    findings: smallest(findings).map(({ via: _via, ...finding }) => finding),
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
      ...finding.statements.map((item) => `  “${item.statement}” [${item.role}] (${item.author})`),
    );
  return lines.join('\n');
}
