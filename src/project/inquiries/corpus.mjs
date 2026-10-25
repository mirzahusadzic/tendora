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
import { listEngineRuns, readEngineArtifact } from '../storage/engine-runs.mjs';
import { parseTexts } from '../../models/acquisition.mjs';
import { prepareGraphs, normalizedRoleProfile } from '../../models/graph-preparation.mjs';
import { propbankAuditor } from '../../models/propbank.mjs';
import { validateGraph } from '../../amr/revision.mjs';
import { repairReading } from '../../amr/lexical-audit.mjs';
import { proofGraph, traceRelations, withheldSupport } from '../../amr/inference.mjs';
import { answerBase, evaluateAnswer } from '../../recording/answers.mjs';
import { answerRecording, checkAnswer } from '../../engine/answer.mjs';
import { truthQuestion } from '../../engine/cloze.mjs';
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
  // The types the statements give each name. A parser types a name by guess
  // (Morgan a company in one reading, a person in another), as it links one:
  // a question about a named participant is asked under each type the
  // statements give that name.
  const nameTypes = new Map();
  for (const item of statements)
    if (item.graph)
      for (const [name, concept] of namedTypes(item.graph)) {
        if (!nameTypes.has(name)) nameTypes.set(name, new Set());
        nameTypes.get(name).add(concept);
      }
  /** A reading's truth asked of the statements: its named participants
   * identified by name, under each type the statements give them, the
   * answers merged. `expected` is what the reading itself says. */
  const truth = (graph, options = {}) => {
    const { expected, graph: question } = truthQuestion(namedCore(graph));
    const nodes = new Map(question.nodes.map((node) => [node.id, node]));
    let variants = [question];
    for (const [id, name] of namedNodes(question)) {
      const types = [...new Set([nodes.get(id).concept, ...(nameTypes.get(name) ?? [])])];
      variants = variants
        .flatMap((variant) =>
          types.map((concept) => ({
            ...variant,
            nodes: variant.nodes.map((node) => (node.id === id ? { ...node, concept } : node)),
          })),
        )
        .slice(0, 8);
    }
    const seen = new Set(),
      merged = { yes: [], no: [], status: 'open' };
    for (const variant of variants) {
      const answer = yesNo(ask(variant, options));
      if (answer.status !== 'open') merged.status = answer.status;
      for (const side of ['yes', 'no'])
        for (const binding of answer[side]) {
          const key = JSON.stringify([side, binding.sourceIds, binding.ruleIds]);
          if (!seen.has(key)) {
            seen.add(key);
            merged[side].push(binding);
          }
        }
    }
    if (merged.yes.length && merged.no.length) merged.status = 'conflict';
    return { expected, ...merged };
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
    truth,
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
    return t === word || stem(t) === stem(word) || (word.length >= 3 && t.startsWith(word));
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
  // A determiner just before the words goes with them: "a major incident".
  const before = source.text.slice(0, best.start).match(/\b(?:a|an|the|every|each|no)\s+$/iu);
  return source.text.slice(before ? best.start - before[0].length : best.start, best.end);
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

/** A check's inputs with a supposition among its sources, less `withhold`. */
export const withSupposed = (result, supposed, withhold = []) => ({
  ...result,
  inputs: [
    ...result.inputs.filter((item) => item.kind !== 'question' && !withhold.includes(item.id)),
    supposed,
    ...result.inputs.filter((item) => item.kind === 'question'),
  ],
});

/** What follows from a supposition: the facts inferred with it that rest on
 * it, by the rule that infers them (the statement a rule was read from, the
 * supposition's own, or engine knowledge by its id). A fact holds without it
 * when one of its proofs does not use it; `onlyWith` counts those that do not.
 * Its own rules count only where they apply to statements: a supposed "if"
 * over what the corpus says, not its own clauses read apart. A statement of
 * the corpus is supposed in place of itself by withholding it. */
export function consequences(view, supposed, { withhold = [] } = {}) {
  const whole = withSupposed(view.result, supposed, withhold);
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

/** A reading with its named participants identified by their names alone:
 * what describes a named participant ("Morgan, the release manager") is left
 * out, and so is a guessed wiki link, while an unnamed participant keeps its
 * description, which is what identifies it. Methods ask what statements say
 * of a participant, whoever describes it how. */
export function namedCore(graph) {
  const top = graph.assertionTop ?? graph.top;
  const named = new Set(
    graph.edges.filter((edge) => edge.role === ':name').map((edge) => edge.from),
  );
  const kept = new Set([top]);
  for (const id of kept)
    for (const edge of graph.edges) {
      if (edge.role === ':wiki') continue;
      if (edge.from === id) {
        if (named.has(id) && edge.role !== ':name') continue;
        kept.add(edge.to);
      } else if (edge.to === id && !named.has(id)) kept.add(edge.from);
    }
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => kept.has(node.id)),
    edges: graph.edges.filter(
      (edge) => edge.role !== ':wiki' && kept.has(edge.from) && kept.has(edge.to),
    ),
  };
}

/** The named nodes of a reading, by their name's words. */
function namedNodes(graph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges
    .filter((edge) => edge.role === ':name')
    .map((edge) => [
      edge.from,
      graph.edges
        .filter((op) => op.from === edge.to && /^:op\d+$/u.test(op.role))
        .sort((a, b) => a.role.localeCompare(b.role, 'en', { numeric: true }))
        .map((op) =>
          String(nodes.get(op.to)?.literal ?? nodes.get(op.to)?.concept).replace(/^"|"$/gu, ''),
        )
        .join(' '),
    ]);
}

/** The type a reading gives each name: [name, concept]. */
function namedTypes(graph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return namedNodes(graph).map(([id, name]) => [name, nodes.get(id).concept]);
}

/** Findings without those that add nothing: of findings of one kind (and one
 * way, `via`), one whose statements hold all of another's is left out, so
 * the smallest set of commitments stands; the rest keep their order. */
export function smallest(findings) {
  const key = (finding) => JSON.stringify([finding.kind, finding.via ?? null]);
  const texts = (finding) => new Set(finding.statements.map((item) => item.statement));
  return findings.filter(
    (finding, i) =>
      !findings.some((other, j) => {
        if (j === i || key(other) !== key(finding)) return false;
        const [mine, theirs] = [texts(finding), texts(other)];
        const within = [...theirs].every((text) => mine.has(text));
        return within && (theirs.size < mine.size || j < i);
      }),
  );
}

/** A saved check's input and result, or null when compaction released them. */
export async function savedCheck(project, run) {
  if (!run.inputRef || !run.resultRef) return null;
  const [input, result] = await Promise.all([
    readEngineArtifact(project, run.inputRef),
    readEngineArtifact(project, run.resultRef),
  ]);
  return { input, result };
}

/** A saved check checked again in memory, with cases given (a check that had
 * none) and statements set beside its own. */
export function recheck(project, check, { cases = [], extra = [], knowledge }) {
  const caseEntries = cases.map((graph, index) => ({
    id: `case-method/s${index + 1}`,
    kind: 'case',
    placementId: 'case-method',
    text: `The case of the method, part ${index + 1}`,
    graph,
  }));
  const inputs = check.result.inputs;
  return checkAnswer(
    project,
    caseEntries.length
      ? {
          ...check.input,
          caseSelection: {
            projectId: project.data.id,
            placementId: 'case-method',
            sources: caseEntries.map((item) => ({ text: item.text })),
          },
        }
      : check.input,
    {
      ...check.result,
      inputs: [
        ...inputs.filter((item) => item.kind !== 'question'),
        ...extra,
        ...caseEntries,
        ...inputs.filter((item) => item.kind === 'question'),
      ],
    },
    { knowledge },
  );
}
