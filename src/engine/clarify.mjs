/** Develop reusable corpus meaning from an explicitly confirmed source connection. */
import { randomUUID, createHash } from 'node:crypto';
import { proposeCorrespondences } from '../amr/correspondence.mjs';
import { sourceCatalog } from '../project/authoring/sources.mjs';
import { validateContributions } from '../project/authoring/development.mjs';
import { graphRevision } from '../recording/revisions.mjs';
import { abstractLabels, withAbstractLabels } from '../amr/labels.mjs';

const identity = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reference = (entry) => ({
  text: entry.text,
  nodeId: entry.placementId,
  sentenceId: entry.sentenceId,
  revision: entry.revision,
  graphRevision: graphRevision(entry.graph),
});

const words = (text) =>
  [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    word: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
const minor = new Set('a an the of for to in on at by and or is are be'.split(' '));
// Abstract heads and connectives have no words of their own.
const unmarked = new Set(['amr-unknown', 'person', 'thing', 'and', 'or']);
/** Concepts read differently: the same slot filled differently (register-02
 * :ARG1 admit-02 or intake), or the same two concepts connected differently.
 * Material only one side has, and the asked participant, are not differences.
 */
function differingConcepts(a, b) {
  const view = (graph) => {
    const concept = new Map(graph.nodes.map((n) => [n.id, n.concept]));
    const edges = graph.edges.map((e) => [concept.get(e.from), e.role, concept.get(e.to)]);
    const slots = new Map();
    for (const [from, role, to] of edges) {
      for (const [key, value] of [
        [`${from} ${role}`, to],
        [`${to} ^${role}`, from],
      ]) {
        if (!slots.has(key)) slots.set(key, new Set());
        slots.get(key).add(value);
      }
    }
    return { concepts: new Set(concept.values()), edges, slots };
  };
  const left = view(a),
    right = view(b),
    marked = new Set();
  for (const [x, y] of [
    [left, right],
    [right, left],
  ])
    for (const [from, role, to] of x.edges) {
      if (from === 'amr-unknown' || to === 'amr-unknown') continue;
      if (y.slots.get(`${from} ${role}`)?.has(to)) continue;
      // Co-arguments both readings share are not differences.
      const filled = [
        ...[...(y.slots.get(`${from} ${role}`) ?? [])].filter(
          (other) => !x.slots.get(`${from} ${role}`)?.has(other),
        ),
        ...[...(y.slots.get(`${to} ^${role}`) ?? [])].filter(
          (other) => !x.slots.get(`${other} ${role}`)?.has(to),
        ),
      ].filter((concept) => concept !== 'amr-unknown');
      if (filled.length || (y.concepts.has(from) && y.concepts.has(to)))
        for (const concept of [from, to, ...filled]) marked.add(concept);
    }
  return [...marked].filter((concept) => !unmarked.has(concept));
}
/** The words a question and a source share where their readings differ:
 * “crates scheduled for freezing”. Null when the difference is not in
 * shared words.
 */
export function sharedWording(question, source) {
  const stems = differingConcepts(question.graph, source.graph)
    .map((concept) => concept.replace(/-\d+$/u, '').split('-')[0].toLowerCase())
    .filter((stem) => stem.length > 2)
    .map((stem) => stem.slice(0, Math.min(stem.length, Math.max(4, stem.length - 3))));
  const about = (token) => stems.some((stem) => token.word.startsWith(stem));
  const q = words(question.text),
    t = words(source.text);
  let best = null;
  for (let i = 0; i < t.length; i++)
    for (let j = 0; j < q.length; j++) {
      if (i && j && t[i - 1].word === q[j - 1].word) continue;
      let n = 0;
      while (t[i + n] && q[j + n] && t[i + n].word === q[j + n].word) n++;
      const run = t.slice(i, i + n);
      const marked = run.map(about);
      const first = marked.indexOf(true),
        last = marked.lastIndexOf(true);
      if (first < 0) continue;
      // The differing words, with the word they describe when it precedes them.
      const from = first > 0 && !minor.has(run[first - 1].word) ? first - 1 : first;
      const phrase = run.slice(from, last + 1);
      const count = marked.filter(Boolean).length;
      if (phrase.length < 2) continue;
      if (
        !best ||
        count > best.count ||
        (count === best.count && phrase.length < best.phrase.length)
      )
        best = { phrase, count };
    }
  return best ? source.text.slice(best.phrase[0].start, best.phrase.at(-1).end) : null;
}

/** Candidate alignments explain a gap. They neither assert the question nor alter its AMR. */
export function buildClarifications(project, input, result, answer) {
  if (answer.status !== 'open' || !answer.complete) return [];
  const question = result.inputs.find((entry) => entry.kind === 'question');
  if (!question?.graph) return [];
  const bases = result.inputs.filter(
    (entry) =>
      entry.kind === 'source' &&
      entry.graph &&
      entry.development?.asserted !== false &&
      !entry.graph.nodes.some((node) => ['amr-unknown', 'amr-empty'].includes(node.concept)),
  );
  // Proposals name abstract participants by their attested words; the retained
  // basis graph stays as acquired.
  const labels = new Map(
    bases.map((entry) => [
      entry.id,
      entry.lexicalAudit ? abstractLabels(entry.graph, entry.text, entry.lexicalAudit.checks) : {},
    ]),
  );
  // Proposals are bounded to 64 sources: rank them by the question's concepts
  // they share, rarer concepts weighing more, so the bound keeps the relevant
  // ones rather than the first by identifier. Sense numbers aside.
  const conceptsOf = (graph) =>
    new Set(
      graph.nodes
        .filter((node) => node.concept && node.literal === undefined && !unmarked.has(node.concept))
        .map((node) => node.concept.replace(/-\d+$/u, '')),
    );
  const asked = conceptsOf(question.graph);
  const held = new Map(bases.map((entry) => [entry.id, conceptsOf(entry.graph)]));
  const frequency = new Map();
  for (const concepts of held.values())
    for (const concept of concepts) frequency.set(concept, (frequency.get(concept) ?? 0) + 1);
  const relevance = (entry) =>
    [...held.get(entry.id)]
      .filter((concept) => asked.has(concept))
      .reduce((sum, concept) => sum + Math.log(1 + bases.length / frequency.get(concept)), 0);
  const labelled = bases.map((entry) => ({
    ...entry,
    relevance: relevance(entry),
    graph: withAbstractLabels(entry.graph, labels.get(entry.id)),
  }));
  return proposeCorrespondences(question.graph, labelled).map((candidate) => {
    const basis = bases.find((entry) => entry.id === candidate.basisId);
    const source = reference(basis);
    const shared = sharedWording(question, basis);
    return {
      ...candidate,
      ...(shared ? { sharedWording: shared } : {}),
      basisLabels: labels.get(basis.id),
      id: identity([source, graphRevision(question.graph), candidate.answerNodeId]),
      projectId: project.data.id,
      projectRevision: input.projectRevision,
      scopePlacementId: input.scopePlacementId,
      source,
      basisGraph: structuredClone(basis.graph),
      question: {
        text: question.text,
        graph: structuredClone(question.graph),
        acquisition: structuredClone(question.acquisition),
      },
    };
  });
}

/** A person, or a program, confirms a proposed meaning; the engine owns rule
 * generation and dependencies. The confirmation records who declared it
 * (`actor`: a label, not a verified identity; "unrecorded" when the caller
 * names none) and through what (`via`: a library call unless the caller says).
 * A confirmation saved before these were recorded names no one. */
export function acceptClarification(
  project,
  candidate,
  { actor = 'unrecorded', via = 'library' } = {},
) {
  if (
    candidate.projectId !== project.data.id ||
    candidate.projectRevision !== project.digest ||
    !project.data.placements.some((placement) => placement.id === candidate.scopePlacementId)
  )
    throw new Error(
      'The corpus changed. Ask the question again before confirming this connection.',
    );
  const source = sourceCatalog(project.data).find(
    (entry) =>
      entry.sentenceId === candidate.source.sentenceId &&
      entry.nodeId === candidate.source.nodeId &&
      entry.revision === candidate.source.revision &&
      entry.text === candidate.source.text,
  );
  if (
    !source ||
    source.development?.asserted === false ||
    graphRevision(candidate.basisGraph) !== candidate.source.graphRevision ||
    (source.graph && graphRevision(source.graph) !== candidate.source.graphRevision)
  )
    throw new Error('The supporting material changed. Ask again to review its current meaning.');
  // Rebuild from retained readings instead of accepting an executable rule from the UI.
  const proposal = proposeCorrespondences(candidate.question.graph, [
    {
      id: candidate.basisId,
      graph: withAbstractLabels(candidate.basisGraph, candidate.basisLabels),
      text: source.text,
    },
  ]).find((item) => item.answerNodeId === candidate.answerNodeId);
  if (!proposal) throw new Error('This connection is no longer available. Keep the question open.');
  const data = structuredClone(project.data);
  let contribution = data.contributions?.find(
    (entry) =>
      entry.scopePlacementId === candidate.scopePlacementId &&
      entry.question?.text === candidate.question.text &&
      graphRevision(entry.question.graph) === graphRevision(candidate.question.graph),
  );
  if (!contribution) {
    contribution = {
      version: 1,
      id: randomUUID(),
      scopePlacementId: candidate.scopePlacementId,
      question: structuredClone(candidate.question),
      responses: [],
      wordings: [],
    };
    (data.contributions ??= []).push(contribution);
  }
  const previous = contribution.wordings.find(
    (part) => !part.withdrawn && part.confirmation?.candidateId === candidate.id,
  );
  if (previous) return { data, contribution, part: previous };
  const part = {
    id: randomUUID(),
    kind: 'clarification',
    ...structuredClone(candidate.question),
    answerLabel: proposal.answerLabel,
    answerNodeId: proposal.answerNodeId,
    basisSources: [structuredClone(candidate.source)],
    basisGraph: structuredClone(candidate.basisGraph),
    rule: proposal.rule,
    alignment: proposal.alignment,
    confirmation: {
      candidateId: candidate.id,
      at: new Date().toISOString(),
      actor,
      via,
      statement: 'This source expresses the relationship asked about.',
    },
  };
  contribution.wordings.push(part);
  validateContributions(data);
  return { data, contribution, part };
}
