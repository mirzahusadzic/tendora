/** Check normalized source relations against the complete question, without acquisition. */
import { evaluateAnswer } from '../recording/answers.mjs';
import { knowledgeSnapshot } from '../project/authoring/knowledge.mjs';
import { buildClarifications } from './clarify.mjs';
import { abstractLabels } from '../amr/labels.mjs';

export function checkAnswer(project, input, result, options) {
  const entries = result.inputs;
  const question = entries.find((item) => item.kind === 'question');
  const graphId = (item) => `${item.id}/graph`;
  const readingLabels = (item) =>
    item.graph && item.lexicalAudit
      ? abstractLabels(item.graph, item.text, item.lexicalAudit.checks)
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
  return settleSharedWording(recording, knowledge, options, input, answer) ?? answer;
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
