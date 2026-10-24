/** Check normalized source relations against the complete question, without acquisition. */
import { evaluateAnswer } from '../recording/answers.mjs';
import { knowledgeSnapshot } from '../project/authoring/knowledge.mjs';
import { buildClarifications } from './clarify.mjs';
import { answerLabels } from '../amr/labels.mjs';

export function checkAnswer(project, input, result, options) {
  const entries = result.inputs;
  const question = entries.find((item) => item.kind === 'question');
  const graphId = (item) => `${item.id}/graph`;
  const readingLabels = (item) =>
    item.graph && item.lexicalAudit
      ? answerLabels(item.graph, item.text, item.lexicalAudit.checks)
      : {};
  const sources = entries
    .filter((item) => item.kind !== 'question')
    .map((item) => ({
      id: item.id,
      nodeId: item.placementId,
      conceptId: item.conceptId,
      sentenceId: item.sentenceId,
      revision: item.revision,
      text: item.text,
      sourceRefs: item.sourceRefs,
      ...(item.development ? { development: item.development } : {}),
      ...(Object.keys(readingLabels(item)).length ? { readingLabels: readingLabels(item) } : {}),
      graphId: item.graph ? graphId(item) : null,
    }));
  const concepts = new Map(project.data.concepts.map((concept) => [concept.id, concept]));
  const byRole = new Map();
  for (const source of sources) {
    if (!byRole.has(source.nodeId)) byRole.set(source.nodeId, []);
    byRole.get(source.nodeId).push(source.id);
  }
  const recording = {
    inquiry: { text: question.text, graphId: graphId(question) },
    graphs: entries
      .filter((item) => item.graph)
      .map((item) => ({ ...item.graph, id: graphId(item) })),
    amrs: entries
      .filter((item) => item.graph)
      .map((item) => ({
        graphId: graphId(item),
        response: {
          penman: item.penman,
        },
      })),
    sources,
    nodes: project.data.placements.map((placement) => ({
      id: placement.id,
      label: concepts.get(placement.conceptId).name,
      sourceIds: byRole.get(placement.id) ?? [],
    })),
    project: {
      id: project.data.id,
      path: project.path,
      digest: input.projectRevision,
      placementId: input.scopePlacementId,
    },
    ...(input.caseSelection
      ? {
          caseState: {
            rootNodeId: input.caseSelection.placementId,
            selection: input.caseSelection,
            policy: 'selected-context-v2',
            ...(input.caseSelection.binding?.questionDigest === input.question.revision
              ? { binding: input.caseSelection.binding }
              : {}),
          },
        }
      : {}),
  };
  const knowledge = options?.knowledge ?? knowledgeSnapshot(project.data);
  const answer = evaluateAnswer(recording, knowledge, options);
  answer.clarifications = buildClarifications(project, input, result, answer);
  const checked =
    settleSharedWording(recording, knowledge, options, input, answer) ??
    settleReference(recording, knowledge, options, answer) ??
    answer;
  return checked.answers.length ? checked : { ...checked, related: closestStatements(recording) };
}

/** When nothing answers, the statements that share the most of the question's
 * content concepts, rarer concepts weighing more. They point where to look; they
 * are not evidence and answer nothing. */
const generic = new Set(
  'amr-unknown - + and or multi-sentence person thing it they i you we he she this that name imperative possible-01 obligate-01 recommend-01 cause-01 contrast-01 mean-01 have-degree-91 date-entity'.split(
    ' ',
  ),
);
const contentConcepts = (graph) =>
  new Set(
    graph.nodes
      .filter((node) => node.literal === undefined && !generic.has(node.concept))
      .filter((node) => !/-9\d$/u.test(node.concept))
      .map((node) => node.concept),
  );
export function closestStatements(recording, limit = 5) {
  const question = recording.graphs.find((graph) => graph.id === recording.inquiry.graphId);
  if (!question) return [];
  const wanted = contentConcepts(question);
  const statements = recording.sources
    .filter((source) => source.graphId && !source.development)
    .map((source) => {
      const graph = recording.graphs.find((item) => item.id === source.graphId);
      return graph && { source, graph, concepts: contentConcepts(graph) };
    })
    .filter(Boolean);
  const frequency = new Map();
  for (const { concepts } of statements)
    for (const concept of concepts) frequency.set(concept, (frequency.get(concept) ?? 0) + 1);
  const weight = (concept) => Math.log(1 + statements.length / frequency.get(concept));
  return statements
    .map(({ source, graph, concepts }) => {
      const shared = [...concepts].filter((concept) => wanted.has(concept)).sort();
      return {
        source,
        graph,
        shared,
        size: concepts.size,
        score: shared.reduce((sum, concept) => sum + weight(concept), 0),
      };
    })
    .filter((item) => item.shared.length)
    .sort((a, b) => b.score - a.score || a.size - b.size || a.source.id.localeCompare(b.source.id))
    .slice(0, limit)
    .map(({ source, graph, shared, score }) => ({
      sourceId: source.id,
      nodeId: source.nodeId,
      text: source.text,
      shares: shared.map((concept) => {
        const node = graph.nodes.find((item) => item.concept === concept);
        return (
          source.readingLabels?.[node.id] ??
          node.surfaceLabel ??
          concept.replace(/-\d+$/u, '').replaceAll('-', ' ')
        );
      }),
      score: Math.round(score * 1000) / 1000,
    }));
}

/** A pronoun the reading left unresolved refers to something the question
 * names: “Does questioning a boundary weaken it?” reads “it” as the boundary.
 * Only when the question names exactly one entity that is not a co-argument of
 * the pronoun's predicate (“Does the team handle it?” never reads “it” as the
 * team). Null when no such reading exists.
 */
const pronouns = new Set(['it', 'they']);
const structural = new Set(['amr-unknown', '-', 'and', 'or']);
export function referenceReading(graph) {
  const found = graph.nodes.filter((node) => pronouns.has(node.concept));
  if (found.length !== 1) return null;
  const [pronoun] = found;
  const heads = graph.edges.filter((edge) => edge.to === pronoun.id).map((edge) => edge.from);
  if (!heads.length || graph.edges.some((edge) => edge.from === pronoun.id)) return null;
  const coArguments = new Set(
    graph.edges.filter((edge) => heads.includes(edge.from)).map((edge) => edge.to),
  );
  const candidates = graph.nodes.filter(
    (node) =>
      node.id !== pronoun.id &&
      node.literal === undefined &&
      !structural.has(node.concept) &&
      !pronouns.has(node.concept) &&
      !/-\d+$/u.test(node.concept) &&
      !coArguments.has(node.id),
  );
  if (candidates.length !== 1) return null;
  const [antecedent] = candidates;
  return {
    pronoun: pronoun.concept,
    antecedent: antecedent.surfaceLabel ?? antecedent.concept,
    graph: {
      ...graph,
      nodes: graph.nodes.filter((node) => node.id !== pronoun.id),
      edges: graph.edges.map((edge) =>
        edge.to === pronoun.id ? { ...edge, to: antecedent.id } : edge,
      ),
    },
  };
}

/** An open answer may hold under the question's own reference: tried once,
 * and cited with every answer it settles. */
export function settleReference(recording, knowledge, options, answer) {
  if (answer.status !== 'open') return null;
  const query = recording.graphs.find((graph) => graph.id === recording.inquiry.graphId);
  const reading = query && referenceReading(query);
  if (!reading) return null;
  const settled = evaluateAnswer(
    {
      ...recording,
      graphs: recording.graphs.map((graph) =>
        graph.id === query.id ? { ...reading.graph, id: query.id } : graph,
      ),
    },
    knowledge,
    options,
  );
  if (!['supported', 'conditional'].includes(settled.status) || !settled.answers.length)
    return null;
  const reference = { pronoun: reading.pronoun, antecedent: reading.antecedent };
  return {
    ...settled,
    answers: settled.answers.map((item) => ({ ...item, readAs: 'reference', reference })),
    clarifications: [],
  };
}

/** A proposal whose source uses the question's own words, read differently,
 * needs no person: the engine reads the question's words as in that source.
 * The connection holds for this check only and is cited with the answer.
 */
// Words that frame a question but carry no content of their own. Negation and
// modal words are not here: they must match.
const framing = new Set(
  'a an the of for to in on at by from with as and or but is are was were be been being do does did have has had who whom whose what which where when why how that this these those it its'.split(
    ' ',
  ),
);
const contentWords = (text) =>
  (
    String(text)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((w) => !framing.has(w));
const sameWord = (a, b) => {
  let n = 0;
  while (n < a.length && a[n] === b[n]) n++;
  return a === b || n >= Math.max(4, Math.min(a.length, b.length) - 3);
};
/** The question says nothing the source does not: every content word of the
 * question occurs in the source, so only the reading of those words differs. */
const withinSource = (question, source) => {
  const available = contentWords(source);
  return contentWords(question).every((word) => available.some((other) => sameWord(word, other)));
};

export function settleSharedWording(recording, knowledge, options, input, answer) {
  const same = (answer.clarifications ?? []).filter(
    (candidate) =>
      candidate.sharedWording && withinSource(recording.inquiry.text, candidate.source.text),
  );
  if (answer.status !== 'open' || !same.length) return null;
  const rules = same.map((candidate) => ({
    ...candidate.rule,
    baseOnly: true,
    id: `shared-wording:${candidate.id}`,
    scopePlacementId: input.scopePlacementId,
    applicationSourceReferences: [candidate.source],
    attribution: `The question and the source both say “${candidate.sharedWording}”; read as in the source.`,
    sources: [
      {
        text: candidate.source.text,
        nodeId: candidate.source.nodeId,
        revision: candidate.source.revision,
      },
    ],
    origin: { kind: 'engine-shared-wording', candidateId: candidate.id },
  }));
  const settled = evaluateAnswer(
    recording,
    { ...knowledge, rules: [...(knowledge.rules ?? []), ...rules] },
    options,
  );
  if (!['supported', 'conditional'].includes(settled.status) || !settled.answers.length)
    return null;
  const wording = new Map(rules.map((rule, i) => [rule.id, same[i].sharedWording]));
  // Several proposals from one source can settle the same answer; report it once.
  const answers = new Map();
  for (const item of settled.answers) {
    const key = JSON.stringify([item.text, item.conditional, [...item.sourceIds].sort()]);
    const used = item.ruleIds.filter((id) => wording.has(id)).map((id) => wording.get(id));
    const marked = used.length
      ? { ...item, readAs: 'shared-wording', sharedWording: [...new Set(used)] }
      : item;
    if (!answers.has(key)) answers.set(key, marked);
  }
  return { ...settled, answers: [...answers.values()], clarifications: [] };
}
