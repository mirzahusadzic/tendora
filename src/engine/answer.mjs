/** Check normalized source relations against the complete question, without acquisition. */
import { evaluateAnswer } from '../recording/answers.mjs';
import { knowledgeSnapshot } from '../project/authoring/knowledge.mjs';
import { buildClarifications } from './clarify.mjs';

export function checkAnswer(project, input, result, options) {
  const entries = result.inputs;
  const question = entries.find((item) => item.kind === 'question');
  const graphId = (item) => `${item.id}/graph`;
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
  const answer = evaluateAnswer(
    recording,
    options?.knowledge ?? knowledgeSnapshot(project.data),
    options,
  );
  answer.clarifications = buildClarifications(project, input, result, answer);
  return answer;
}
