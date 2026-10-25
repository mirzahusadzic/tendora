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
import { ruleParts, truthQuestion } from '../../engine/cloze.mjs';
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
  // Whether any question asked here stopped at a bound: a method that finds
  // nothing says so then, since what is not found is not shown absent.
  const limits = { reached: false };
  // The statements without a reading: never asked, so never "nothing".
  const unread = statements.filter((item) => !item.graph).map((item) => item.id);
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
    let variants = [question],
      cut = false;
    for (const [id, name] of namedNodes(question)) {
      const types = [...new Set([nodes.get(id).concept, ...(nameTypes.get(name) ?? [])])];
      variants = variants.flatMap((variant) =>
        types.map((concept) => ({
          ...variant,
          nodes: variant.nodes.map((node) => (node.id === id ? { ...node, concept } : node)),
        })),
      );
      // Too many combinations to ask is a bound reached: said, never silent.
      if (variants.length > variantLimit) {
        variants = variants.slice(0, variantLimit);
        cut = true;
      }
    }
    const seen = new Set(),
      merged = { yes: [], no: [], qualified: [], status: 'open', limited: cut };
    for (const variant of variants) {
      const answer = yesNo(ask(variant, options));
      if (answer.limited) merged.limited = true;
      else if (answer.status !== 'open') merged.status = answer.status;
      for (const side of ['yes', 'no', 'qualified'])
        for (const binding of answer[side]) {
          const key = JSON.stringify([side, binding.answer, binding.sourceIds, binding.ruleIds]);
          if (!seen.has(key)) {
            seen.add(key);
            merged[side].push(binding);
          }
        }
    }
    if (merged.yes.length && merged.no.length) merged.status = 'conflict';
    else if (!merged.yes.length && !merged.no.length && merged.status === 'conflict')
      merged.status = 'open';
    if (merged.limited) {
      limits.reached = true;
      if (merged.status === 'open') merged.status = 'limited';
    }
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
    unread,
    names: (id) =>
      new Set(byId.get(id)?.graph ? namedNodes(byId.get(id).graph).map(([, name]) => name) : []),
    get limited() {
      return limits.reached;
    },
    overlayKnowledge,
  };
}

/** A yes/no answer read as its two sides, each binding with the statements
 * and rules it rests on. Only what holds outright is evidence: a binding that
 * holds under a clause (at night, during an incident) is kept apart as
 * qualified, and a search that stopped at its bound gives none (an undecided
 * answer's candidates count otherwise: a conflict holds both). */
export function yesNo(answer) {
  if (answer.status === 'limited')
    return { status: 'limited', limited: true, yes: [], no: [], qualified: [] };
  const all = [...(answer.answers ?? []), ...(answer.candidates ?? [])];
  const binding = (item) => ({ sourceIds: item.sourceIds ?? [], ruleIds: item.ruleIds ?? [] });
  const side = (text) => all.filter((item) => item.text === text && !item.conditional).map(binding);
  return {
    status: answer.status,
    yes: side('Yes'),
    no: side('No'),
    qualified: all
      .filter((item) => item.conditional && ['Yes', 'No'].includes(item.text))
      .map((item) => ({ answer: item.text, ...binding(item) })),
  };
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

/** How many type combinations of a question's named participants are asked. */
const variantLimit = 32;

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
  // A fact new by its identity may say what already holds (a rule said again
  // in other words): a rule whose conclusion the statements give without the
  // supposition follows also without it.
  const holdsAlready = (entry) => {
    const graph = entry.key === supposedId ? supposed.graph : view.byId.get(entry.key)?.graph;
    const parts = graph && ruleParts(graph);
    if (!parts || parts.necessary) return false;
    const truth = view.truth(parts.conclusion, { withhold });
    return (truth.expected === 'Yes' ? truth.yes : truth.no).length > 0;
  };
  for (const entry of rules.values()) if (entry.onlyWith && holdsAlready(entry)) entry.onlyWith = 0;
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

/** A reading with its named participants identified by name: what describes
 * a named participant as a role ("Morgan, the release manager") is left out,
 * and so is a guessed wiki link, while a description carrying a value ("Alex
 * with employee ID 123") stays, since it tells one Alex from another. An
 * unnamed participant keeps its description, which is what identifies it.
 * Methods ask what statements say of a participant, whoever describes it how. */
export function namedCore(graph) {
  const top = graph.assertionTop ?? graph.top;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const named = new Set(
    graph.edges.filter((edge) => edge.role === ':name').map((edge) => edge.from),
  );
  // Whether what an edge leads to, away from `from` and short of the claim
  // itself, holds a value (a number, a quoted string): an identifier, not a
  // role, and never the claim's own polarity.
  const value = (node) =>
    node?.literal !== undefined &&
    /^(?:"|-?\d)/u.test(String(node.literal)) &&
    node.literal !== '-';
  const valued = (edge, from) => {
    const start = edge.from === from ? edge.to : edge.from;
    if (start === top) return false;
    const seen = new Set([from, top, start]);
    for (const id of seen) {
      if (id === from || id === top) continue;
      if (value(nodes.get(id))) return true;
      for (const other of graph.edges) {
        if (other.role === ':wiki' || other.role === ':name') continue;
        const next = other.from === id ? other.to : other.to === id ? other.from : null;
        if (next && !seen.has(next)) seen.add(next);
      }
    }
    return false;
  };
  const kept = new Set([top]);
  for (const id of kept)
    for (const edge of graph.edges) {
      if (edge.role === ':wiki') continue;
      if (edge.from === id) {
        if (named.has(id) && edge.role !== ':name' && !valued(edge, id)) continue;
        kept.add(edge.to);
      } else if (edge.to === id && (!named.has(id) || valued(edge, id))) kept.add(edge.from);
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

/** A statement as a commitment: its words, where it stands and who wrote it.
 * The same words at two roles, or by two authors, are two commitments. */
export const commitment = (item) => `${item.statement}\u0000${item.role}\u0000${item.author}`;

/** Findings without those that add nothing: of findings of one kind (and one
 * way, `via`), one whose commitments hold all of another's is left out, so
 * the smallest set of commitments stands; the rest keep their order. */
export function smallest(findings) {
  const key = (finding) => JSON.stringify([finding.kind, finding.via ?? null]);
  const texts = (finding) => new Set(finding.statements.map(commitment));
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

/** What a method could not ask: the statements in scope without a reading
 * (`ids`, all by default), and whether a search stopped at its bound. A report
 * carries both, so it never says "nothing" over what it did not read. */
export function coverage(view, ids = null) {
  const scoped = ids ? new Set(ids) : null;
  return {
    unread: view.named(view.unread.filter((id) => !scoped || scoped.has(id))),
    limited: view.limited,
  };
}

/** The lines a report adds for what it could not ask. */
export function coverageLines(report) {
  return [
    ...(report.unread?.length
      ? [
          `Not asked: ${report.unread.length} ${report.unread.length === 1 ? 'statement has' : 'statements have'} no reading.`,
          ...report.unread.map((item) => `  “${item.statement}” [${item.role}]`),
        ]
      : []),
    ...(report.limited
      ? ['Limited: a search stopped at its bound; what is not found is not shown absent.']
      : []),
  ];
}

/** A report's "nothing found", qualified when it could not ask everything. */
export const nothing = (report, said) =>
  report.unread?.length || report.limited ? 'nothing found among what was read' : said;

/** An author as findings name them in prose: "unrecorded" is no one's name. */
export const who = (author) => (author === 'unrecorded' ? 'an unrecorded author' : author);
