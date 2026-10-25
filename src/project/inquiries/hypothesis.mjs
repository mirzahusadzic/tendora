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
import { sentenceRevision } from '../authoring/sources.mjs';
import { listEngineRuns, readEngineArtifact } from '../storage/engine-runs.mjs';
import { acquiredTexts, retainAcquisitions } from '../storage/acquisitions.mjs';
import { parseTexts } from '../../models/acquisition.mjs';
import { prepareGraphs, normalizedRoleProfile } from '../../models/graph-preparation.mjs';
import { propbankAuditor } from '../../models/propbank.mjs';
import { validateGraph } from '../../amr/revision.mjs';
import { repairReading } from '../../amr/lexical-audit.mjs';
import { proofGraph, traceRelations, withheldSupport } from '../../amr/inference.mjs';
import { answerBase } from '../../recording/answers.mjs';
import { answerRecording, checkAnswer } from '../../engine/answer.mjs';
import { clozeProbes, checkProbe } from '../../engine/cloze.mjs';
import { probeAsks, releasedNote, roleName, rootCheck } from './inspection.mjs';
import { resolveInquiryPlacement } from './scope.mjs';

/** The supposition's id among the sources of a check. */
export const supposedId = 'hypothesis';

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

/** The supposition's reading: retained, or read by eGemma and retained;
 * offline, only a retained one. Audited and repaired as a check's inputs are. */
async function supposedReading(project, text, { offline, signal }) {
  let retained = (await acquiredTexts(project, [text]))?.[0];
  if (retained?.status !== 'retained') {
    if (offline) return { status: 'needs-amr', reason: 'It has no retained reading.' };
    let read;
    try {
      read = (await parseTexts([text], () => {}, signal)).results[0];
    } catch (error) {
      if (signal?.aborted) throw error;
      return { status: 'needs-amr', reason: error.message };
    }
    if (read.decode_status !== 'ok' || !read.penman)
      return { status: 'needs-amr', reason: 'eGemma could not read it.' };
    await retainAcquisitions(project, [
      {
        text,
        penman: read.penman,
        acquisition: read,
        origin: { kind: 'hypothesis-acquisition', at: new Date().toISOString() },
      },
    ]);
    retained = (await acquiredTexts(project, [text]))[0];
  }
  const prepared = (
    await prepareGraphs([{ penman: retained.penman }], { signal, profile: normalizedRoleProfile })
  ).results[0];
  if (!prepared.ok)
    return {
      status: 'invalid-amr',
      reason: prepared.diagnostics.map((item) => item.message).join('; '),
    };
  const { audit } = await propbankAuditor();
  let graph = validateGraph(prepared.graph),
    lexicalAudit = audit(text, graph);
  const repaired = repairReading(text, graph, lexicalAudit.checks);
  if (repaired.repairs.length) {
    graph = validateGraph(repaired.graph);
    lexicalAudit = audit(text, graph);
  }
  return { status: 'read', graph, lexicalAudit, penman: retained.penman };
}

/** A check's inputs with the supposition among its sources. */
const withSupposed = (result, supposed) => ({
  ...result,
  inputs: [
    ...result.inputs.filter((item) => item.kind !== 'question'),
    supposed,
    ...result.inputs.filter((item) => item.kind === 'question'),
  ],
});

export async function hypothesisReport(project, { text, role = null, offline = false, signal }) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Name what to suppose.');
  text = text.trim();
  const root = project.data.placements.find((placement) => placement.parentId === null).id;
  const placementId = role ? resolveInquiryPlacement(project, role) : root;
  const placement = project.data.placements.find((item) => item.id === placementId);
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
  const reading = await supposedReading(project, text, { offline, signal });
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
  const supposed = {
    id: supposedId,
    kind: 'source',
    placementId,
    conceptId: placement.conceptId,
    sentenceId: supposedId,
    revision: sentenceRevision(text),
    text,
    sourceRefs: [],
    graph: reading.graph,
    penman: reading.penman,
    lexicalAudit: reading.lexicalAudit,
  };
  const knowledge = knowledgeSnapshot(project.data);
  // The engine reads only the project's statements; in the overlay the
  // supposition is one of them.
  const overlay = {
    ...knowledge,
    sourceCatalog: [
      ...(knowledge.sourceCatalog ?? []),
      {
        text,
        revision: supposed.revision,
        conceptId: placement.conceptId,
        sentenceId: supposedId,
        nodeId: placementId,
        authoring: [],
      },
    ],
  };
  const { input, result } = await rootCheck(project);
  const statements = result.inputs.filter((item) => !['question', 'case'].includes(item.kind));
  const textOf = new Map(statements.map((item) => [item.id, item]));
  const named = (ids) =>
    [...new Set(ids)]
      .filter((id) => textOf.has(id))
      .map((id) => ({
        statement: textOf.get(id).text,
        role: roleName(project.data, textOf.get(id).placementId),
      }));

  // What it says: its own variables, asked back against the corpus with it.
  const whole = withSupposed(result, supposed);
  let grammarCache;
  const variables = [];
  for (const probe of clozeProbes(supposed)) {
    signal?.throwIfAborted();
    const checked = checkProbe(project, input, whole, probe, {
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

  // What follows: facts inferred with it that rest on it, by the rule that
  // infers them; a fact holds without it when one of its proofs does not use it.
  const recording = answerRecording(project, input, whole);
  const { inference } = answerBase(recording, overlay);
  const facts = inference.facts;
  const holds = withheldSupport(proofGraph(facts), [supposedId]);
  const rules = new Map();
  facts.forEach((fact, i) => {
    const proofs = [fact, ...(fact.alternatives ?? [])].filter((proof) => proof.ruleId);
    if (!proofs.length) return;
    const trace = traceRelations(facts, [fact.id]);
    if (!trace.sourceIds.includes(supposedId)) return;
    for (const ruleId of new Set(proofs.map((proof) => proof.ruleId))) {
      const from = ruleId.split('/clause/')[0];
      const key = textOf.has(from) || from === supposedId ? from : ruleId;
      const entry = rules.get(key) ?? { key, facts: 0, onlyWith: 0, rests: new Set() };
      entry.facts++;
      if (!holds[i]) entry.onlyWith++;
      for (const id of trace.sourceIds) if (id !== supposedId && id !== from) entry.rests.add(id);
      rules.set(key, entry);
    }
  });
  // Its own rules count only where they apply to statements: a supposed
  // "if" over what the corpus says, not its own clauses read apart.
  const follows = [...rules.values()]
    .filter((entry) => entry.key !== supposedId || entry.rests.size)
    .map((entry) => ({
      ...(entry.key === supposedId
        ? { rule: text, role: supposition.role, ofSupposition: true }
        : textOf.has(entry.key)
          ? {
              rule: textOf.get(entry.key).text,
              role: roleName(project.data, textOf.get(entry.key).placementId),
            }
          : { rule: entry.key, knowledge: true }),
      facts: entry.facts,
      onlyWith: entry.onlyWith,
      restsOn: named([...entry.rests]),
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
  const saved = (await listEngineRuns(project))
    .filter((run) => run.projectDigest === project.digest && run.questions?.[0]?.text)
    .filter((run) => !run.purpose || ['inquiry', 'question-refresh'].includes(run.purpose))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const key = (run) =>
    JSON.stringify([run.questions[0].text, run.scopePlacementId, run.case || null]);
  const latest = new Map(),
    released = new Set();
  for (const run of saved) if (run.answer && !latest.has(key(run))) latest.set(key(run), run);
  for (const run of saved)
    if (!run.answer && run.cache === 'recheck' && !latest.has(key(run))) released.add(key(run));
  const inScope = [...latest.values()].filter((run) => within(run.scopePlacementId));
  const texts = (answer) => [...new Set(answer.answers.map((item) => item.text))].sort();
  const questions = [];
  for (const run of inScope) {
    signal?.throwIfAborted();
    if (!run.inputRef || !run.resultRef) {
      released.add(key(run));
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
      released: released.size,
      ...Object.fromEntries(questionKinds.map((kind) => [kind, count(kind)])),
      items: changed,
    },
    nothingFollows:
      !follows.some((rule) => rule.onlyWith) && !changed.some((q) => q.kind !== 'also'),
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
      'Nothing follows from it: no rule applies only with it, and no saved question changes.',
    );
  return lines.join('\n');
}
