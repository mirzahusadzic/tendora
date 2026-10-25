/** Hypothesis: what would follow if one more statement were said, in an
 * overlay that is never saved. The corpus is set beside itself with the
 * supposition added, so all they share is background and only what the
 * supposition changes stands out:
 *   what it says   its own variables asked back with it in place: new (only
 *                  it says so), said (another statement says the same),
 *                  otherwise (the corpus answers differently), conflict
 *                  (the corpus answers it both ways), silent, limited, unread
 *   what follows   facts inferred with it, by the rule that infers them, each
 *                  only with the supposition or also without it
 *   questions      the latest check of each saved question in whose scope it
 *                  would stand, checked again with and without it: answered,
 *                  changed, conflict, also (the same answers, now also resting
 *                  on it) or unchanged
 * A supposition from which nothing follows says so: that is a result, not a
 * failure. Its reading is retained like a question's; no statement, check or
 * case is saved. */
import { projectTree } from '../authoring/project.mjs';
import { knowledgeSnapshot } from '../authoring/knowledge.mjs';
import { readEngineArtifact } from '../storage/engine-runs.mjs';
import { checkAnswer } from '../../engine/answer.mjs';
import { clozeProbes, checkProbe } from '../../engine/cloze.mjs';
import { probeAsks, releasedNote, roleName } from './inspection.mjs';
import { resolveInquiryPlacement } from './scope.mjs';
import {
  consequences,
  corpusView,
  coverage,
  coverageLines,
  latestChecks,
  readText,
  supposedId,
  supposedSource,
  withSupposed,
} from './corpus.mjs';

export const variableOutcomes = {
  recovered: 'new',
  'also elsewhere': 'said',
  elsewhere: 'said',
  otherwise: 'otherwise',
  conflict: 'conflict',
  conditional: 'silent',
  necessary: 'silent',
  limited: 'limited',
  open: 'unread',
};
export const questionKinds = ['answered', 'changed', 'conflict', 'also', 'unchanged'];

export async function hypothesisReport(project, { text, role = null, offline = false, signal }) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Name what to suppose.');
  text = text.trim();
  const root = project.data.placements.find((placement) => placement.parentId === null).id;
  const placementId = role ? resolveInquiryPlacement(project, role) : root;
  const supposition = { text, role: roleName(project.data, placementId) };
  // Said again, a statement would only stand beside itself, its participants
  // twice over: it is already said, and nothing follows from supposing it.
  const already = (knowledgeSnapshot(project.data).sourceCatalog ?? []).find(
    (item) => item.text === text,
  );
  if (already)
    return {
      revision: project.digest,
      supposed: { ...supposition, alreadyStated: roleName(project.data, already.nodeId) },
      saved: false,
      variables: [],
      follows: [],
      questions: {
        checked: 0,
        released: 0,
        ...Object.fromEntries(questionKinds.map((kind) => [kind, 0])),
        items: [],
      },
      nothingFollows: true,
    };
  const reading = await readText(project, text, {
    offline,
    signal,
    origin: 'hypothesis-acquisition',
  });
  if (reading.status !== 'read')
    return {
      revision: project.digest,
      supposed: {
        ...supposition,
        reading: reading.status,
        ...(reading.reason ? { reason: reading.reason } : {}),
      },
      saved: false,
    };
  const supposed = supposedSource(project, { text, reading, placementId });
  const view = await corpusView(project);
  const { knowledge, named } = view;
  // The engine reads only the project's statements; in the overlay the
  // supposition is one of them.
  const overlay = view.overlayKnowledge([supposed]);

  // What it says: its own variables, asked back against the corpus with it.
  const whole = withSupposed(view.result, supposed);
  let grammarCache;
  const variables = [];
  for (const probe of clozeProbes(supposed)) {
    signal?.throwIfAborted();
    const checked = checkProbe(project, view.input, whole, probe, {
      knowledge: overlay,
      grammarCache,
    });
    grammarCache = checked.grammarCache;
    // The statements besides it that give its answers (never its own condition).
    const others = named(
      checked.answers.flatMap((answer) => answer.sourceIds.filter((id) => id !== supposedId)),
    );
    variables.push({
      asks: probeAsks(probe),
      outcome: variableOutcomes[checked.outcome] ?? 'unread',
      answers: [...new Set(checked.answers.map((answer) => answer.text))],
      ...(others.length ? { statements: others } : {}),
    });
  }

  // What follows: the rules that apply with it.
  const follows = consequences(view, supposed)
    .map((entry) => ({
      ...(entry.own
        ? { rule: text, role: supposition.role, ofSupposition: true }
        : entry.statementId
          ? { rule: view.byId.get(entry.statementId).text, role: view.role(entry.statementId) }
          : { rule: entry.knowledge, knowledge: true }),
      facts: entry.facts,
      onlyWith: entry.onlyWith,
      restsOn: named(entry.rests),
    }))
    .sort((a, b) => b.onlyWith - a.onlyWith || a.rule.localeCompare(b.rule));

  // Questions: the latest check of each question, scope and case at this
  // revision whose scope holds the role, checked again with and without it.
  const byId = new Map(projectTree(project.data).map((row) => [row.placement.id, row]));
  const within = (scope) => {
    for (let at = placementId; at; at = byId.get(at)?.placement.parentId)
      if (at === scope) return true;
    return false;
  };
  const latest = await latestChecks(project);
  let released = latest.released;
  const inScope = latest.runs.filter((run) => within(run.scopePlacementId));
  const texts = (answer) => [...new Set(answer.answers.map((item) => item.text))].sort();
  const questions = [];
  for (const run of inScope) {
    signal?.throwIfAborted();
    if (!run.inputRef || !run.resultRef) {
      released++;
      continue;
    }
    const [checkInput, checkResult] = await Promise.all([
      readEngineArtifact(project, run.inputRef),
      readEngineArtifact(project, run.resultRef),
    ]);
    const before = checkAnswer(project, checkInput, checkResult, { knowledge });
    const after = checkAnswer(project, checkInput, withSupposed(checkResult, supposed), {
      knowledge: overlay,
    });
    // Undecided answers keep their candidates, and say whether each rests on
    // the supposition or the case.
    const caseIds = new Set(
      checkResult.inputs.filter((item) => item.kind === 'case').map((item) => item.id),
    );
    const side = (answer) => ({
      status: answer.status,
      answers: texts(answer),
      ...(answer.candidates?.length
        ? {
            candidates: answer.candidates.map((candidate) => ({
              text: candidate.text,
              ...(candidate.sourceIds.includes(supposedId) ? { supposition: true } : {}),
              ...(candidate.sourceIds.some((id) => caseIds.has(id)) ? { case: true } : {}),
            })),
          }
        : {}),
    });
    const [was, now] = [texts(before), texts(after)];
    const restsOnIt = after.answers.some((answer) => answer.sourceIds.includes(supposedId));
    const kind =
      after.status === 'conflict' && before.status !== 'conflict'
        ? 'conflict'
        : !was.length && now.length
          ? 'answered'
          : before.status !== after.status || JSON.stringify(was) !== JSON.stringify(now)
            ? 'changed'
            : restsOnIt
              ? 'also'
              : 'unchanged';
    questions.push({
      question: run.questions[0].text,
      ...(run.case ? { case: run.case } : {}),
      scope: roleName(project.data, run.scopePlacementId),
      kind,
      before: side(before),
      after: {
        ...side(after),
        restsOn: named(after.answers.flatMap((answer) => answer.sourceIds)),
        ...(restsOnIt ? { restsOnSupposition: true } : {}),
      },
    });
  }
  const count = (kind) => questions.filter((question) => question.kind === kind).length;
  const changed = questions.filter((question) => question.kind !== 'unchanged');
  return {
    revision: project.digest,
    supposed: { ...supposition, reading: 'read' },
    saved: false,
    variables,
    follows,
    questions: {
      checked: questions.length,
      released,
      ...Object.fromEntries(questionKinds.map((kind) => [kind, count(kind)])),
      items: changed,
    },
    nothingFollows:
      !follows.some((rule) => rule.onlyWith) && !changed.some((q) => q.kind !== 'also'),
    ...coverage(view),
  };
}

/** The report as plain text, for the CLI. */
export function formatHypothesis(report) {
  const { supposed } = report;
  const head = `Supposing “${supposed.text}” at ${supposed.role}; nothing is saved.`;
  if (supposed.alreadyStated)
    return `${head}\nIt is already a statement at ${supposed.alreadyStated}: nothing follows from supposing it.`;
  if (supposed.reading === 'needs-amr')
    return /^It has no retained reading/u.test(supposed.reason)
      ? `${head}\nIt has no retained reading. Without --offline it is read through eGemma.`
      : `${head}\nIt was not read: ${supposed.reason}`;
  if (supposed.reading === 'invalid-amr')
    return `${head}\nIts reading could not be normalized: ${supposed.reason}`;
  const quoted = (items) => items.map((item) => `“${item.statement}” [${item.role}]`).join(', ');
  const lines = [head];
  if (supposed.alreadyStated)
    return `${head}\nIt is already a statement at ${supposed.alreadyStated}: nothing follows from supposing it.`;
  lines.push('', `What it says (${report.variables.length})`);
  for (const variable of report.variables)
    lines.push(
      `  ${variable.asks}: ${variable.outcome}` +
        (variable.outcome !== 'new' && variable.answers.length
          ? `: ${variable.answers.join('; ')}`
          : '') +
        (variable.statements ? `, from ${quoted(variable.statements)}` : ''),
    );
  if (!report.variables.length) lines.push('  nothing to ask back');
  lines.push(
    '',
    `What follows (${report.follows.length} ${report.follows.length === 1 ? 'rule' : 'rules'})`,
  );
  for (const rule of report.follows)
    lines.push(
      `  ${rule.onlyWith ? 'only with it' : 'also without it'}: ` +
        (rule.knowledge ? `engine knowledge ${rule.rule}` : `“${rule.rule}” [${rule.role}]`) +
        (rule.ofSupposition ? ' (its own rule, applied)' : '') +
        (rule.restsOn.length ? `, with ${quoted(rule.restsOn)}` : ''),
    );
  if (!report.follows.length) lines.push('  no rule applies with it');
  const { questions } = report;
  lines.push('', `Questions (${questions.checked} in its scope, checked with and without it)`);
  const answers = (side) =>
    side.answers.length
      ? side.answers.join('; ')
      : side.candidates
        ? `${side.status}: ${side.candidates
            .map(
              (candidate) =>
                candidate.text +
                (candidate.supposition
                  ? ' (with the supposition)'
                  : candidate.case
                    ? ' (with the case)'
                    : ''),
            )
            .join(', ')}`
        : side.status;
  for (const item of questions.items)
    lines.push(
      `  ${item.kind}: ${item.question}${item.case ? ` (case: ${item.case})` : ''}  ` +
        `${answers(item.before)} → ${answers(item.after)}` +
        (item.after.restsOnSupposition
          ? `; rests on the supposition${item.after.restsOn.length ? ` and ${item.after.restsOn.length} ${item.after.restsOn.length === 1 ? 'statement' : 'statements'}` : ''}`
          : ''),
    );
  lines.push(`  ${questions.unchanged} unchanged`);
  if (releasedNote(questions.released)) lines.push(releasedNote(questions.released));
  if (report.nothingFollows)
    lines.push(
      '',
      report.unread?.length || report.limited
        ? 'Nothing follows from it among what was read: no rule applies only with it, and no saved question changes.'
        : 'Nothing follows from it: no rule applies only with it, and no saved question changes.',
    );
  const notes = coverageLines(report);
  if (notes.length) lines.push('', ...notes);

  return lines.join('\n');
}
