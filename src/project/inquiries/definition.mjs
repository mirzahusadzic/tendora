/** Definition: what is X, by what the corpus says? From the kind statements
 * ("a deployment is a change"): the kinds X is said to be (its genus), the
 * kinds said to be X, and its siblings (other kinds of the same genus). From
 * every other statement: what is said of an X, as relations (renewed by,
 * frozen by). The differentia: what is said of X and of no sibling. What is
 * missing becomes a question for a person: what X is, when nothing says it,
 * and what tells X from a sibling, when nothing does. Read-only and offline. */
import { kindReading } from '../../amr/kinds.mjs';
import { propbankAuditor } from '../../models/propbank.mjs';
import { corpusView, coverage, coverageLines } from './corpus.mjs';

// Plural or singular, a word is one term: the word itself, and the singulars
// a plural ending gives (aliases alias, changes change, policies policy), are
// compared, not one guessed stem, so alias and aliases, gas and gases, ox and
// ox meet. A word that ends in s as a singular does (alias, gas, class,
// status, analysis) is no plural: alias is not the plural of an alia.
const forms = (word) => {
  const w = String(word).toLowerCase().replace(/-\d+$/u, '');
  const out = new Set([w]);
  if (/[^aeiou]ies$/u.test(w)) out.add(w.slice(0, -3) + 'y');
  if (/(?:s|x|z|ch|sh)es$/u.test(w)) out.add(w.slice(0, -2));
  if (/[^s]s$/u.test(w) && !/(?:us|is|as)$/u.test(w)) out.add(w.slice(0, -1));
  return out;
};
const alike = (a, b) => {
  const theirs = forms(b);
  return [...forms(a)].some((form) => theirs.has(form));
};

/** A kind statement's subject and predicate heads: what is said to be what. */
function kindHeads(reading) {
  const instance = (facts, name) =>
    facts.find((fact) => fact[0] === name && fact[1] === ':instance')?.[2];
  const subject = instance(reading.when, reading.subject);
  const predicate = instance(reading.then, reading.subject) ?? subject;
  return subject ? { subject, predicate } : null;
}

export async function definitionReport(project, { term }) {
  if (typeof term !== 'string' || !term.trim()) throw new Error('Name a term to define.');
  const view = await corpusView(project);
  // A term of several words is searched by its last, and said so: the report
  // names the word it read, never a phrase it did not match.
  const words = term.trim().split(/\s+/u);
  const asked = term.trim();
  term = words.at(-1);

  // A term names a concept by its own word, or by a word PropBank gives its
  // frame ("deployment" is deploy-01).
  const { frames } = await propbankAuditor();
  const matches = (concept) =>
    alike(concept ?? '', term) ||
    [...(frames[concept]?.[1] ?? []), ...(frames[concept]?.[2] ?? [])].some((word) =>
      alike(word, term),
    );
  const kinds = view.statements
    .filter((item) => item.graph)
    .map((item) => ({ item, heads: kindReading(item.graph, item.text) }))
    .map(({ item, heads }) => ({ item, heads: heads && kindHeads(heads) }))
    .filter(({ heads }) => heads);
  const genus = kinds.filter(({ heads }) => matches(heads.subject) && !matches(heads.predicate));
  const species = kinds.filter(({ heads }) => matches(heads.predicate) && !matches(heads.subject));
  const genera = genus.map(({ heads }) => heads.predicate);
  const siblings = kinds.filter(
    ({ heads }) =>
      genera.some((genusConcept) => alike(genusConcept, heads.predicate)) &&
      !matches(heads.subject),
  );
  const kindIds = new Set(kinds.map(({ item }) => item.id));
  // What is said of an instance of a concept: the relations its nodes are in.
  const said = (accepts) => {
    const relations = new Map();
    for (const item of view.statements)
      if (item.graph && !kindIds.has(item.id))
        for (const node of item.graph.nodes.filter((entry) => accepts(entry.concept))) {
          const concepts = new Map(item.graph.nodes.map((entry) => [entry.id, entry.concept]));
          for (const edge of item.graph.edges) {
            const relation =
              edge.to === node.id && /-\d+$/u.test(concepts.get(edge.from) ?? '')
                ? `${concepts.get(edge.from)} ${edge.role}`
                : edge.from === node.id && /-\d+$/u.test(concepts.get(edge.to) ?? '')
                  ? `${concepts.get(edge.to)} ${edge.role}-of`
                  : null;
            if (!relation) continue;
            if (!relations.has(relation)) relations.set(relation, new Set());
            relations.get(relation).add(item.id);
          }
        }
    return relations;
  };
  const own = said(matches);
  const siblingSaid = new Map(
    [...new Set(siblings.map(({ heads }) => heads.subject.replace(/-\d+$/u, '')))].map(
      (sibling) => [sibling, said((concept) => alike(concept ?? '', sibling))],
    ),
  );
  const shared = new Set([...siblingSaid.values()].flatMap((relations) => [...relations.keys()]));
  const differentia = [...own].filter(([relation]) => !shared.has(relation));
  const findings = [];
  if (!genus.length)
    findings.push({
      method: 'definition',
      kind: 'no genus',
      summary: `Nothing says what kind of thing a ${term} is.`,
      statements: [],
      question: `What is a ${term}?`,
    });
  for (const [sibling, relations] of siblingSaid)
    if (!differentia.length)
      findings.push({
        method: 'definition',
        kind: 'no differentia',
        summary: `Nothing said of a ${term} tells it from a ${sibling}.`,
        statements: view.named([...relations.values()].flatMap((ids) => [...ids])),
        question: `What tells a ${term} from a ${sibling}?`,
      });
  return {
    revision: project.digest,
    term,
    ...(words.length > 1 ? { asked } : {}),
    genus: genus.map(({ item, heads }) => ({ kind: heads.predicate, ...view.named([item.id])[0] })),
    species: species.map(({ item, heads }) => ({
      kind: heads.subject,
      ...view.named([item.id])[0],
    })),
    siblings: siblings.map(({ item, heads }) => ({
      kind: heads.subject,
      ...view.named([item.id])[0],
    })),
    said: [...own].map(([relation, ids]) => ({ relation, statements: view.named([...ids]) })),
    differentia: differentia.map(([relation, ids]) => ({
      relation,
      statements: view.named([...ids]),
    })),
    findings,
    ...coverage(view),
  };
}

/** The report as plain text, for the CLI: what the statements say, the
 * genus even when nothing gives it (that is the question), the rest when
 * there is some. */
export function formatDefinition(report) {
  const lines = [
    `Definition of “${report.term}”${report.asked ? ` (the last word of “${report.asked}”)` : ''}, by what the statements say`,
  ];
  const kind = (row) => `${row.kind}: “${row.statement}” [${row.role}] (${row.author})`;
  const section = (title, rows, line, always = false) => {
    if (!rows.length && !always) return;
    lines.push('', `${title}`);
    for (const row of rows) lines.push(`  ${line(row)}`);
    if (!rows.length) lines.push('  nothing');
  };
  section('Genus: what it is said to be', report.genus, kind, true);
  section('Species: what is said to be one', report.species, kind);
  section('Siblings: other kinds of its genus', report.siblings, kind);
  section(
    'Said of it',
    report.said,
    (row) =>
      `${row.relation}: ${row.statements.map((item) => `“${item.statement}” (${item.author})`).join(', ')}`,
  );
  if (report.siblings.length)
    section(
      'Differentia: said of it and of no sibling',
      report.differentia,
      (row) => row.relation,
      true,
    );
  for (const finding of report.findings) lines.push('', `${finding.summary} ${finding.question}`);
  const notes = coverageLines(report);
  if (notes.length) lines.push('', ...notes);
  return lines.join('\n');
}
