/** Equivocation: is one word doing two jobs? Every reading's predicates are
 * gathered by lemma; a lemma read in two or more PropBank senses across the
 * statements is named with each sense's gloss and its statements. A saved
 * question that reads a lemma in a sense no statement has, while statements
 * have another, is named too: the question and the statements may mean the
 * same and be read apart, or mean two things. Either is a question for a
 * person: reword, or confirm two meanings. Read-only and offline. */
import { propbankAuditor } from '../../models/propbank.mjs';
import { clauseText, corpusView, latestChecks, savedCheck } from './corpus.mjs';

const sense = /^(.+)-(\d+)$/u;
/** A reading's predicates: [lemma, concept, node]; roles (-91) left out. */
const predicates = (graph) =>
  graph.nodes
    .filter((node) => sense.test(node.concept ?? '') && !/-91$/u.test(node.concept))
    .map((node) => [node.concept.match(sense)[1], node.concept, node]);

export async function equivocationReport(project, { signal } = {}) {
  const view = await corpusView(project);
  const { frames } = await propbankAuditor();
  const gloss = (concept) => frames[concept]?.[0] ?? null;
  // lemma → concept → statements, with the words that say it.
  const lemmas = new Map();
  for (const item of view.statements.filter((entry) => entry.graph))
    for (const [lemma, concept, node] of predicates(item.graph)) {
      if (!lemmas.has(lemma)) lemmas.set(lemma, new Map());
      const senses = lemmas.get(lemma);
      if (!senses.has(concept)) senses.set(concept, new Map());
      senses.get(concept).set(item.id, clauseText(item, [node.id]));
    }
  const findings = [];
  for (const [lemma, senses] of lemmas) {
    if (senses.size < 2) continue;
    findings.push({
      method: 'equivocation',
      kind: 'senses',
      summary: `“${lemma}” is read in ${senses.size} senses.`,
      lemma,
      senses: [...senses].map(([concept, items]) => ({
        concept,
        gloss: gloss(concept),
        words: [...new Set([...items.values()].filter(Boolean))],
        statements: view.named([...items.keys()]),
      })),
      statements: view.named([...senses.values()].flatMap((items) => [...items.keys()])),
      question: `Is “${lemma}” one meaning here, or ${senses.size}? If one, reword so they read alike.`,
    });
  }
  // Questions read in a sense no statement has.
  const latest = await latestChecks(project);
  for (const run of latest.runs) {
    signal?.throwIfAborted();
    const check = await savedCheck(project, run);
    const question = check?.result.inputs.find((item) => item.kind === 'question');
    if (!question?.graph) continue;
    for (const [lemma, concept] of predicates(question.graph)) {
      const senses = lemmas.get(lemma);
      if (!senses || senses.has(concept)) continue;
      findings.push({
        method: 'equivocation',
        kind: 'question sense',
        summary: `“${run.questions[0].text}” reads “${lemma}” as ${concept}${gloss(concept) ? ` (${gloss(concept)})` : ''}; the statements read it otherwise.`,
        lemma,
        asked: {
          question: run.questions[0].text,
          status: run.status,
          concept,
          gloss: gloss(concept),
        },
        senses: [...senses].map(([other, items]) => ({
          concept: other,
          gloss: gloss(other),
          statements: view.named([...items.keys()]),
        })),
        statements: view.named([...senses.values()].flatMap((items) => [...items.keys()])),
        question: `Does the question mean what the statements say with “${lemma}”? If so, reword one of them.`,
      });
    }
  }
  return {
    revision: project.digest,
    lemmas: lemmas.size,
    released: latest.released,
    findings,
  };
}

/** The report as plain text, for the CLI. */
export function formatEquivocation(report) {
  const lines = [
    `Equivocation over ${report.lemmas} predicate lemmas: ${
      report.findings.length
        ? `${report.findings.length} ${report.findings.length === 1 ? 'word' : 'words'} doing more than one job.`
        : 'each word is read in one sense.'
    }`,
  ];
  for (const finding of report.findings) {
    lines.push('', finding.summary);
    if (finding.asked)
      lines.push(
        `  asked: ${finding.asked.concept} in “${finding.asked.question}” (${finding.asked.status})`,
      );
    for (const item of finding.senses)
      lines.push(
        `  ${item.concept}${item.gloss ? ` (${item.gloss})` : ''}:`,
        ...item.statements.map((entry) => `    “${entry.statement}” [${entry.role}]`),
      );
    lines.push(`  ${finding.question}`);
  }
  return lines.join('\n');
}
