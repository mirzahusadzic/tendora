/** The corpus as the Socratic methods see it (docs of the methods: suppose,
 * elenchus, aporia, …): the statements of the latest check at the root role,
 * with their readings, roles and authors, and one primitive the methods share,
 * a reading asked as a yes/no question. The question is matched as any check
 * matches it, so statements meet through their readings, not through their
 * node names; it can leave statements out (withholding), set statements beside
 * them (an overlay) and give cases (one check's circumstances). Nothing is
 * saved and nothing is acquired here.
 *
 * A method returns findings in one shape, so the development loop, a person
 * and a model through the adapter read them alike:
 *   { method, kind, summary, statements: [{ statement, role, author }],
 *     question?, proposal? }
 * A question is asked back to a person, a proposal waits for a person; neither
 * is an answer. A method that finds nothing returns no findings, and says so.
 */
import { projectTree } from '../authoring/project.mjs';
import { knowledgeSnapshot } from '../authoring/knowledge.mjs';
import { readProvenance, recordedAuthors } from '../authoring/provenance.mjs';
import { sentenceRevision } from '../authoring/sources.mjs';
import { acquiredTexts, retainAcquisitions } from '../storage/acquisitions.mjs';
import { listEngineRuns } from '../storage/engine-runs.mjs';
import { parseTexts } from '../../models/acquisition.mjs';
import { prepareGraphs, normalizedRoleProfile } from '../../models/graph-preparation.mjs';
import { propbankAuditor } from '../../models/propbank.mjs';
import { validateGraph } from '../../amr/revision.mjs';
import { repairReading } from '../../amr/lexical-audit.mjs';
import { proofGraph, traceRelations, withheldSupport } from '../../amr/inference.mjs';
import { answerBase, evaluateAnswer } from '../../recording/answers.mjs';
import { answerRecording } from '../../engine/answer.mjs';
import { roleName, rootCheck } from './inspection.mjs';

/** A text's reading: retained, or read by eGemma and retained (`origin` names
 * why); offline, only a retained one. Audited and repaired as a check's inputs
 * are. */
export async function readText(project, text, { offline, signal, origin }) {
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
        origin: { kind: origin, at: new Date().toISOString() },
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

/** The corpus at the project's revision, from the latest check at the root
 * role (one must exist, as for probes and corpus fidelity). */
export async function corpusView(project) {
  const { input, result } = await rootCheck(project);
  const knowledge = knowledgeSnapshot(project.data);
  const statements = result.inputs.filter((item) => !['question', 'case'].includes(item.kind));
  const byId = new Map(statements.map((item) => [item.id, item]));
  const rows = projectTree(project.data);
  const placements = new Map(rows.map((row) => [row.placement.id, row]));
  const recorded = recordedAuthors(project.data);
  const declared = await readProvenance(project);
  const author = (id) =>
    recorded.get(id)?.author ?? declared.get(byId.get(id)?.text)?.author ?? 'unrecorded';
  const role = (id) => roleName(project.data, byId.get(id)?.placementId);
  // The top-level role a statement is under (the root's own statements: the root).
  const topRole = (id) => {
    let at = placements.get(byId.get(id)?.placementId);
    while (at && placements.get(at.placement.parentId)?.placement.parentId)
      at = placements.get(at.placement.parentId);
    return at?.concept.name ?? null;
  };
  /** Statements by id, as findings name them; ids of no statement (a case,
   * the supposition) are left out. */
  const named = (ids) =>
    [...new Set(ids)]
      .filter((id) => byId.has(id))
      .map((id) => ({ statement: byId.get(id).text, role: role(id), author: author(id) }));
  /** The statement a rule was read from. */
  const ruleSource = (ruleId) => {
    const id = ruleId.split('/clause/')[0];
    return byId.has(id) ? id : null;
  };

  // A material without cases is the same for every question asked of it:
  // its inference is made once and shared, as probes share theirs.
  const bases = new Map();
  /** A statement set beside the others, at a placement, in the overlay of
   * one question only: a source entry, and the catalog entry that lets the
   * engine read it. */
  const overlayKnowledge = (extra) =>
    extra.length
      ? {
          ...knowledge,
          sourceCatalog: [
            ...(knowledge.sourceCatalog ?? []),
            ...extra.map((item) => ({
              text: item.text,
              revision: item.revision,
              conceptId: item.conceptId,
              sentenceId: item.sentenceId,
              nodeId: item.placementId,
              authoring: [],
            })),
          ],
        }
      : knowledge;
  /** A reading asked as a question: `graph` holds an amr-unknown (a yes/no
   * question asks its polarity). Returns the engine's answer; `yesNo` reads it. */
  const ask = (graph, { cases = [], withhold = [], extra = [] } = {}) => {
    const revision = sentenceRevision(JSON.stringify(graph));
    const caseEntries = cases.map((caseGraph, index) => ({
      id: `case-method/s${index + 1}`,
      kind: 'case',
      placementId: 'case-method',
      text: `The case of the method, part ${index + 1}`,
      graph: caseGraph,
    }));
    const inputs = [
      ...statements.filter((item) => !withhold.includes(item.id)),
      ...extra,
      ...caseEntries,
      { id: `question:${revision}`, kind: 'question', text: '', revision, graph },
    ];
    const recording = answerRecording(
      project,
      {
        ...input,
        question: { text: '', revision },
        ...(caseEntries.length
          ? {
              caseSelection: {
                projectId: project.data.id,
                placementId: 'case-method',
                sources: caseEntries.map((item) => ({ text: item.text })),
              },
            }
          : {}),
      },
      { ...result, inputs },
    );
    const used = overlayKnowledge(extra);
    if (caseEntries.length) return evaluateAnswer(recording, used);
    const key = JSON.stringify([[...withhold].sort(), extra.map((item) => item.id)]);
    if (!bases.has(key)) bases.set(key, answerBase(recording, used));
    return evaluateAnswer(recording, used, { base: { ...bases.get(key), recording } });
  };
  return {
    project,
    input,
    result,
    knowledge,
    statements,
    byId,
    author,
    role,
    topRole,
    named,
    ruleSource,
    ask,
    overlayKnowledge,
  };
}

/** A yes/no answer read as its two sides, each binding with the statements
 * and rules it rests on (undecided answers count as given: a conflict holds
 * both). */
export function yesNo(answer) {
  const all = [...(answer.answers ?? []), ...(answer.candidates ?? [])];
  const side = (text) =>
    all
      .filter((binding) => binding.text === text)
      .map((binding) => ({
        sourceIds: binding.sourceIds ?? [],
        ruleIds: binding.ruleIds ?? [],
        ...(binding.conditional ? { conditional: true } : {}),
      }));
  return { status: answer.status, yes: side('Yes'), no: side('No') };
}

/** The words of a statement that say some of its reading's nodes: the
 * shortest stretch of its sentence holding a word of each, found through the
 * reading's labels, as a probe's blank is found. Null when no word is found. */
export function clauseText(source, nodeIds) {
  const wanted = new Set(nodeIds);
  const labels = source.development?.labels ?? {};
  const words = [
    ...new Set(
      source.graph.nodes
        .filter((node) => wanted.has(node.id))
        .map((node) =>
          String(
            labels[node.id] ??
              node.surfaceLabel ??
              node.literal ??
              (node.concept?.startsWith('amr-') ? '' : node.concept?.replace(/-\d+$/u, '')) ??
              '',
          )
            .replace(/^"|"$/gu, '')
            .toLowerCase(),
        )
        .filter((word) => word.length > 1 && !['and', 'or', 'person', 'thing'].includes(word)),
    ),
  ];
  const stem = (word) => word.replace(/(?:ing|ed|es|s)$/u, '');
  const matches = (token, word) => {
    const t = token.toLowerCase();
    return t === word || stem(t) === stem(word) || (word.length > 3 && t.startsWith(word));
  };
  const tokens = [...source.text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)];
  const hits = tokens
    .map((token) => ({ token, word: words.findIndex((word) => matches(token[0], word)) }))
    .filter((hit) => hit.word >= 0);
  const found = new Set(hits.map((hit) => hit.word));
  if (!found.size) return null;
  let best = null;
  for (let i = 0; i < hits.length; i++) {
    const seen = new Set();
    for (let j = i; j < hits.length; j++) {
      seen.add(hits[j].word);
      if (seen.size < found.size) continue;
      const start = hits[i].token.index,
        end = hits[j].token.index + hits[j].token[0].length;
      if (!best || end - start < best.end - best.start) best = { start, end };
      break;
    }
  }
  return source.text.slice(best.start, best.end);
}

/** A supposition's id among the sources of a check. */
export const supposedId = 'hypothesis';

/** A text read as a statement said at a placement, for an overlay. */
export function supposedSource(project, { text, reading, placementId }) {
  const placement = project.data.placements.find((item) => item.id === placementId);
  return {
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
}

/** A check's inputs with a supposition among its sources. */
export const withSupposed = (result, supposed) => ({
  ...result,
  inputs: [
    ...result.inputs.filter((item) => item.kind !== 'question'),
    supposed,
    ...result.inputs.filter((item) => item.kind === 'question'),
  ],
});

/** What follows from a supposition: the facts inferred with it that rest on
 * it, by the rule that infers them (the statement a rule was read from, the
 * supposition's own, or engine knowledge by its id). A fact holds without it
 * when one of its proofs does not use it; `onlyWith` counts those that do not.
 * Its own rules count only where they apply to statements: a supposed "if"
 * over what the corpus says, not its own clauses read apart. */
export function consequences(view, supposed) {
  const whole = withSupposed(view.result, supposed);
  const recording = answerRecording(view.project, view.input, whole);
  const { inference } = answerBase(recording, view.overlayKnowledge([supposed]));
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
      const key = view.byId.has(from) || from === supposedId ? from : ruleId;
      const entry = rules.get(key) ?? {
        key,
        ruleIds: new Set(),
        facts: 0,
        onlyWith: 0,
        rests: new Set(),
      };
      entry.ruleIds.add(ruleId);
      entry.facts++;
      if (!holds[i]) entry.onlyWith++;
      for (const id of trace.sourceIds) if (id !== supposedId && id !== from) entry.rests.add(id);
      rules.set(key, entry);
    }
  });
  return [...rules.values()]
    .filter((entry) => entry.key !== supposedId || entry.rests.size)
    .map((entry) => ({
      ...(entry.key === supposedId
        ? { own: true }
        : view.byId.has(entry.key)
          ? { statementId: entry.key }
          : { knowledge: entry.key }),
      ruleIds: [...entry.ruleIds],
      facts: entry.facts,
      onlyWith: entry.onlyWith,
      rests: [...entry.rests],
    }));
}

/** The latest saved check of each question, its scope and its case at the
 * project's revision; the questions whose checks compaction released are
 * counted apart. */
export async function latestChecks(project) {
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
  return { runs: [...latest.values()], released: released.size };
}
