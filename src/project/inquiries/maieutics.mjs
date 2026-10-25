/** Maieutics: what question, answered by an author, would complete what the
 * corpus leaves open? For each saved question left open or answered only
 * under a condition (its latest check at this revision, without a case):
 *   missing premise   a rule would answer it if its condition held; the
 *                     condition is walked back through the rules that would
 *                     bring it about, and each premise is tried as the
 *                     question's case. A premise that answers it is asked
 *                     back to the author of its rule, in the rule's words,
 *                     the deepest first: nothing in the corpus brings it
 *                     about. A premise the statements deny is said to be.
 *   unjoined          a statement holds the question's relation but does not
 *                     join it: is it meant to answer it?
 * A conditional answer already names the clause it holds under (a time, a
 * circumstance); only one held under a rule's condition has a premise to find.
 * Questions to people, never answers: what an author says becomes a
 * statement only when saved. Read-only and offline. */
import { ruleParts } from '../../engine/cloze.mjs';
import {
  clauseText,
  corpusView,
  coverage,
  coverageLines,
  latestChecks,
  recheck,
  savedCheck,
  who,
} from './corpus.mjs';
import { roleName } from './inspection.mjs';

const depth = 3;
// Frames a question asks through ("why" is cause-01), not what it asks about.
const frames = new Set([
  'cause-01',
  'possible-01',
  'obligate-01',
  'recommend-01',
  'permit-01',
  'contrast-01',
  'mean-01',
]);

export async function maieuticsReport(project, { question = null, signal } = {}) {
  const view = await corpusView(project);
  const { named } = view;
  const byText = new Map(view.statements.map((item) => [item.text, item]));
  const rules = view.statements
    .filter((item) => item.graph)
    .map((item) => ({ item, parts: ruleParts(item.graph) }))
    .filter(({ parts }) => parts && !parts.necessary);
  const ruleOf = new Map(rules.map((rule) => [rule.item.id, rule]));
  const topConcept = (graph) => graph.nodes.find((node) => node.id === graph.top)?.concept;
  const words = (rule) =>
    clauseText(
      rule.item,
      rule.parts.condition.nodes.map((node) => node.id),
    ) ?? rule.item.text;

  const latest = await latestChecks(project);
  // A question never asked is not one with nothing to complete.
  if (question && !latest.runs.some((run) => run.questions[0].text === question))
    throw new Error(`No such saved question: ${question}`);
  const asked = latest.runs.filter(
    (run) =>
      !run.caseSelection &&
      ['open', 'conditional', 'limited'].includes(run.status) &&
      (!question || run.questions[0].text === question),
  );
  const findings = [];
  let released = latest.released;
  for (const run of asked) {
    signal?.throwIfAborted();
    const check = await savedCheck(project, run);
    if (!check) {
      released++;
      continue;
    }
    const answer = run.answer;
    // The statements the check reached: what a conditional answer holds under,
    // and what an open check's openings name.
    const reached = [
      ...(answer.answers ?? []).flatMap((binding) => [
        ...(binding.sourceIds ?? []),
        ...(binding.qualifications ?? []).map((text) => byText.get(text)?.id),
      ]),
      ...(answer.openings ?? []).flatMap((opening) => [
        ...(opening.sourceIds ?? []),
        ...(opening.candidateConnections ?? []).flatMap((connection) => connection.sourceIds ?? []),
      ]),
    ].filter((id) => view.byId.has(id));
    // The same question asked at two roles is two questions.
    const subject = {
      question: run.questions[0].text,
      scope: roleName(project.data, run.scopePlacementId),
      status: run.status,
    };
    // Premises: each reached rule's condition, then the conditions of the
    // rules whose conclusion is that condition's relation, up to three rules deep.
    const premises = [],
      tried = new Set();
    const walk = (rule, chain) => {
      if (chain.length > depth || chain.includes(rule.item.id)) return;
      const path = [rule.item.id, ...chain];
      premises.push({ rule, path });
      for (const before of rules)
        if (topConcept(before.parts.conclusion) === topConcept(rule.parts.condition))
          walk(before, path);
    };
    for (const id of new Set(reached)) if (ruleOf.has(id)) walk(ruleOf.get(id), []);
    const sufficient = [];
    for (const premise of premises) {
      const key = premise.path.join('\u0000');
      if (tried.has(key)) continue;
      tried.add(key);
      const answered = recheck(project, check, {
        cases: [premise.rule.parts.condition],
        knowledge: view.knowledge,
      });
      if (!answered.answers.length || !['supported', 'conditional'].includes(answered.status))
        continue;
      const truth = view.truth(premise.rule.parts.condition);
      sufficient.push({
        ...premise,
        answers: [...new Set(answered.answers.map((binding) => binding.text))],
        denied: (truth.expected === 'Yes' ? truth.no : truth.yes).flatMap(
          (binding) => binding.sourceIds,
        ),
      });
    }
    // The deepest first: a premise no other rule brings about.
    sufficient.sort((a, b) => b.path.length - a.path.length);
    for (const premise of sufficient) {
      const said = words(premise.rule);
      findings.push({
        method: 'maieutics',
        kind: 'missing premise',
        summary: `If ${said}, the statements would answer “${subject.question}”: ${premise.answers.join('; ')}.`,
        ...subject,
        premise: said,
        answers: premise.answers,
        statements: named(premise.path),
        ...(premise.denied.length ? { deniedBy: named(premise.denied) } : {}),
        author: view.author(premise.rule.item.id),
        ask: premise.denied.length
          ? `The statements deny that ${said}; is it so, after all?`
          : `Is it so that ${said}?`,
      });
    }
    // Statements that hold the question's own relation (its predicate) without
    // joining it, and are no rule a premise was found for.
    const covered = new Set(sufficient.flatMap((premise) => premise.path));
    const relations = new Set(
      (answer.openings ?? [])
        .filter(
          (opening) =>
            opening.kind === 'relation' &&
            /-\d+$/u.test(opening.from ?? '') &&
            !/-91$/u.test(opening.from) &&
            !frames.has(opening.from),
        )
        .map((opening) => opening.from),
    );
    // Among them, those the check found closest to the question (its own
    // closest statements, when it kept them).
    const closest = new Set((answer.related ?? []).map((item) => item.sourceId));
    const holds = (id) =>
      (!closest.size || closest.has(id)) &&
      view.byId.get(id).graph?.nodes.some((node) => relations.has(node.concept));
    for (const id of new Set(reached))
      if (!covered.has(id) && !ruleOf.has(id) && run.status === 'open' && holds(id))
        findings.push({
          method: 'maieutics',
          kind: 'unjoined',
          summary: `“${view.byId.get(id).text}” holds the relation “${subject.question}” asks about, without answering it.`,
          ...subject,
          statements: named([id]),
          author: view.author(id),
          ask: `Is it meant to answer “${subject.question}”? If so, how?`,
        });
  }
  return {
    revision: project.digest,
    questions: asked.length,
    released,
    findings,
    ...coverage(view),
  };
}

/** The report as plain text, for the CLI: by saved question. */
export function formatMaieutics(report) {
  const lines = [
    `Maieutics over ${report.questions} open or conditional ${report.questions === 1 ? 'question' : 'questions'}: ${
      report.findings.length
        ? `${report.findings.length} ${report.findings.length === 1 ? 'question' : 'questions'} for authors.`
        : 'no premise or connection found to ask about.'
    }`,
  ];
  let at = null;
  for (const finding of report.findings) {
    const heading = `“${finding.question}” at ${finding.scope} (${finding.status})`;
    if (heading !== at) lines.push('', heading);
    at = heading;
    lines.push(
      finding.kind === 'missing premise'
        ? `  missing premise: ${finding.premise} (then: ${finding.answers.join('; ')})`
        : `  unjoined: “${finding.statements[0].statement}” [${finding.statements[0].role}]`,
      `    ask ${who(finding.author)}: ${finding.ask}`,
      ...(finding.kind === 'missing premise'
        ? finding.statements.map((item) => `    through “${item.statement}” [${item.role}]`)
        : []),
      ...(finding.deniedBy ?? []).map((item) => `    denied by “${item.statement}” [${item.role}]`),
    );
  }
  if (report.released)
    lines.push('', `${report.released} more released by compaction and not read.`);
  const notes = coverageLines(report);
  if (notes.length) lines.push('', ...notes);
  return lines.join('\n');
}
