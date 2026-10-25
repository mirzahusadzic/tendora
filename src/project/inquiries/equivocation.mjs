/** Equivocation: is one word doing two jobs? Every reading's predicates are
 * gathered by lemma; a lemma read in two or more PropBank senses across the
 * statements is named with each sense's gloss and its statements; so are the
 * same two concepts related two ways ("payment key" as key :mod pay-01 and as
 * key :instrument-of pay-01), the same words read as two structures. A saved
 * question that reads a lemma in a sense no statement has, while statements
 * have another, is named too: the question and the statements may mean the
 * same and be read apart, or mean two things. Either is a question for a
 * person: reword, or confirm two meanings. Read-only and offline. */
import { propbankAuditor } from '../../models/propbank.mjs';
import { clauseText, corpusView, latestChecks, savedCheck } from './corpus.mjs';

const sense = /^(.+)-(\d+)$/u;
// What relates to everything, structure no reading can be told by.
const unrelated = /^(?:name|person|thing|and|or|amr-unknown|-|\+|date-entity)$|-91$|-quantity$/u;
// Frames say how a claim is held (possible, in contrast), not what it relates.
const framing = new Set([
  'possible-01',
  'obligate-01',
  'recommend-01',
  'permit-01',
  'contrast-01',
  'cause-01',
  'mean-01',
]);
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
  // The same two concepts related two ways ("payment key": key :mod pay-01 in
  // one reading, key :instrument-of pay-01 in another). Frames, names and
  // values relate everything and are left out.
  const pairs = new Map();
  for (const item of view.statements.filter((entry) => entry.graph)) {
    const nodes = new Map(item.graph.nodes.map((node) => [node.id, node]));
    for (const edge of item.graph.edges) {
      if (/^:(?:op\d+|name|wiki|polarity|quant|mode)$/u.test(edge.role)) continue;
      const [a, b] = [nodes.get(edge.from), nodes.get(edge.to)];
      if (!a?.concept || !b?.concept || b.literal !== undefined) continue;
      if ([a, b].some((node) => unrelated.test(node.concept) || framing.has(node.concept)))
        continue;
      const [first, second, relation] =
        a.concept < b.concept ? [a, b, edge.role] : [b, a, `${edge.role}-of`];
      const key = `${first.concept}\u0000${second.concept}`;
      if (!pairs.has(key)) pairs.set(key, new Map());
      const relations = pairs.get(key);
      if (!relations.has(relation)) relations.set(relation, new Map());
      relations.get(relation).set(item.id, clauseText(item, [first.id, second.id]));
    }
  }
  for (const [key, relations] of pairs) {
    if (relations.size < 2) continue;
    const [first, second] = key.split('\u0000');
    const words = [...relations.values()].flatMap((items) => [...items.values()]).find(Boolean);
    findings.push({
      method: 'equivocation',
      kind: 'structure',
      summary: `${words ? `“${words}”` : `${first} and ${second}`} is read with ${relations.size} structures.`,
      words,
      structures: [...relations].map(([relation, items]) => ({
        reading: `${first} ${relation} ${second}`,
        statements: view.named([...items.keys()]),
      })),
      statements: view.named([...relations.values()].flatMap((items) => [...items.keys()])),
      question:
        'Do they say the same? If so, reword so they read alike; a question read one way does not meet a statement read the other.',
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
        ? `${report.findings.length} ${report.findings.length === 1 ? 'place' : 'places'} where words do more than one job.`
        : 'each word is read in one sense and one structure.'
    }`,
  ];
  for (const finding of report.findings) {
    lines.push('', finding.summary);
    if (finding.asked)
      lines.push(
        `  asked: ${finding.asked.concept} in “${finding.asked.question}” (${finding.asked.status})`,
      );
    for (const item of finding.senses ?? [])
      lines.push(
        `  ${item.concept}${item.gloss ? ` (${item.gloss})` : ''}:`,
        ...item.statements.map((entry) => `    “${entry.statement}” [${entry.role}]`),
      );
    for (const item of finding.structures ?? [])
      lines.push(
        `  ${item.reading}:`,
        ...item.statements.map((entry) => `    “${entry.statement}” [${entry.role}]`),
      );
    lines.push(`  ${finding.question}`);
  }
  return lines.join('\n');
}
