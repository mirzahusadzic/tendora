/** Elenchus: does the corpus refute a thesis? The thesis is a text (never
 * saved) or one of the statements, asked of the others. It is refuted
 *   directly           when the statements answer its truth the other way
 *                      (a conditional thesis is asked under its condition);
 *   through a rule     when, supposed, it makes a rule apply whose conclusion
 *                      the statements deny: the rule's conclusion is answered
 *                      Yes with the thesis and No without it, or both ways
 *                      with it (it leads to both).
 * Each refutation names the commitments that make it, by role and author,
 * the smallest first. A thesis the statements answer its own way is
 * supported; one nothing refutes or supports stays open, and that is a
 * result. Nothing is saved; a text's reading is retained like a question's. */
import { findStatement } from './inspection.mjs';
import { ruleParts } from '../../engine/cloze.mjs';
import {
  consequences,
  corpusView,
  readText,
  smallest,
  supposedId,
  supposedSource,
} from './corpus.mjs';

/** A thesis asked: its truth, or a conditional thesis's conclusion under its
 * condition. */
function thesisParts(graph) {
  const parts = ruleParts(graph);
  return { asked: parts ? parts.conclusion : graph, cases: parts ? [parts.condition] : [] };
}

export async function elenchusReport(project, { text = null, statement = null, offline, signal }) {
  if (Boolean(text) === Boolean(statement))
    throw new Error('Name one thesis: a text or a statement.');
  const root = project.data.placements.find((placement) => placement.parentId === null).id;
  const view = await corpusView(project);
  const { named } = view;
  // A statement is asked of the others; a text that is a statement too.
  const own =
    statement !== null
      ? view.statements.find((item) => item.text === findStatement(project.data, statement).text)
      : view.statements.find((item) => item.text === text.trim());
  const thesis = { text: own?.text ?? text.trim(), ...(own ? { role: view.role(own.id) } : {}) };
  let graph = own?.graph;
  if (!own) {
    const reading = await readText(project, thesis.text, {
      offline,
      signal,
      origin: 'elenchus-acquisition',
    });
    if (reading.status !== 'read')
      return {
        revision: project.digest,
        thesis: { ...thesis, reading: reading.status, reason: reading.reason },
        findings: [],
      };
    graph = reading.graph;
  }
  if (!graph)
    return { revision: project.digest, thesis: { ...thesis, reading: 'none' }, findings: [] };
  const withhold = own ? [own.id] : [];
  const supposed = supposedSource(project, {
    text: thesis.text,
    reading: { graph, penman: own?.penman, lexicalAudit: own?.lexicalAudit },
    placementId: own?.placementId ?? root,
  });
  const commitments = (bindings) =>
    named(
      bindings.flatMap((binding) => [
        ...binding.sourceIds,
        ...binding.ruleIds.map(view.ruleSource).filter(Boolean),
      ]),
    );
  const findings = [];

  // Directly: the thesis's truth asked of the other statements.
  const { asked, cases } = thesisParts(graph);
  const direct = view.truth(asked, { cases, withhold });
  const [agree, deny] =
    direct.expected === 'Yes' ? [direct.yes, direct.no] : [direct.no, direct.yes];
  for (const binding of deny)
    findings.push({
      method: 'elenchus',
      kind: 'refutes',
      summary: cases.length
        ? 'Under its own condition, the statements answer it the other way.'
        : 'The statements answer it the other way.',
      statements: commitments([binding]),
      via: 'directly',
    });
  for (const binding of agree)
    findings.push({
      method: 'elenchus',
      kind: 'supports',
      summary: 'The statements answer it its own way.',
      statements: commitments([binding]),
      via: 'directly',
    });

  // Through a rule: each rule that applies only with the thesis, its
  // conclusion asked with the thesis beside the statements.
  for (const entry of consequences(view, supposed, { withhold })) {
    signal?.throwIfAborted();
    if (!entry.statementId || !entry.onlyWith) continue;
    const rule = view.byId.get(entry.statementId);
    const parts = rule.graph && ruleParts(rule.graph);
    if (!parts) continue;
    const both = view.truth(parts.conclusion, { extra: [supposed], withhold });
    if (!both.yes.length || !both.no.length) continue;
    const rests = (binding) => binding.sourceIds.includes(supposedId);
    const thesisSide = both.expected === 'Yes' ? both.yes : both.no;
    const otherSide = both.expected === 'Yes' ? both.no : both.yes;
    const against = otherSide.filter((binding) => !rests(binding));
    const leadsToBoth = !against.length && otherSide.some(rests);
    if (!thesisSide.some(rests) || (!against.length && !leadsToBoth)) continue;
    findings.push({
      method: 'elenchus',
      kind: 'refutes',
      summary: leadsToBoth
        ? 'Supposed, it makes a rule apply and leads to both its conclusion and the opposite.'
        : 'Supposed, it makes a rule apply whose conclusion the statements deny.',
      statements: named([
        entry.statementId,
        ...entry.rests,
        ...(leadsToBoth ? otherSide : against).flatMap((binding) => [
          ...binding.sourceIds,
          ...binding.ruleIds.map(view.ruleSource).filter(Boolean),
        ]),
      ]),
      via: { rule: rule.text, role: view.role(rule.id) },
    });
  }

  findings.splice(0, findings.length, ...smallest(findings));
  findings.sort(
    (a, b) =>
      (a.kind === 'refutes' ? 0 : 1) - (b.kind === 'refutes' ? 0 : 1) ||
      a.statements.length - b.statements.length,
  );
  const refuted = findings.some((finding) => finding.kind === 'refutes');
  const supported = findings.some((finding) => finding.kind === 'supports');
  return {
    revision: project.digest,
    thesis: { ...thesis, reading: 'read' },
    saved: false,
    verdict:
      refuted && supported ? 'contested' : refuted ? 'refuted' : supported ? 'supported' : 'open',
    findings,
  };
}

const verdicts = {
  refuted: 'refuted',
  contested: 'contested: the statements support it and refute it',
  supported: 'supported, and nothing refutes it',
  open: 'open: nothing in the statements refutes or supports it',
};

/** The report as plain text, for the CLI. */
export function formatElenchus(report) {
  const { thesis } = report;
  const head = `Elenchus of “${thesis.text}”${thesis.role ? ` [${thesis.role}]` : ''}`;
  if (thesis.reading === 'needs-amr')
    return /^It has no retained reading/u.test(thesis.reason ?? '')
      ? `${head}\nIt has no retained reading. Without --offline it is read through eGemma.`
      : `${head}\nIt was not read: ${thesis.reason}`;
  if (thesis.reading !== 'read') return `${head}\nIt has no usable reading.`;
  const lines = [`${head}: ${verdicts[report.verdict]}.`];
  for (const finding of report.findings) {
    const by = `${finding.statements.length} ${finding.statements.length === 1 ? 'statement' : 'statements'}`;
    lines.push(
      '',
      finding.kind === 'refutes'
        ? finding.via === 'directly'
          ? `Refuted directly, by ${by}:`
          : `Refuted through “${finding.via.rule}” [${finding.via.role}], by ${by}:`
        : `Supported by ${by}:`,
      ...finding.statements.map((item) => `  “${item.statement}” [${item.role}] (${item.author})`),
    );
  }
  return lines.join('\n');
}
