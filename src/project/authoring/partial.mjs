/** Replay retained acquisitions against the current corpus and own their identities. */
import { sourceCatalog } from './sources.mjs';
import { knowledgeSnapshot } from './knowledge.mjs';
import { evaluateAnswer } from '../../recording/answers.mjs';
import { partialIdentity, partialQueryRevision } from '../../amr/partial-coverage.mjs';
import {
  mergePartialContribution,
  partialContributionProfile,
} from '../../amr/partial-contribution.mjs';

export { mergePartialContribution } from '../../amr/partial-contribution.mjs';

/** Replay retained acquisitions with today's corpus, scope, rules and bindings.
 * No acquisition, I/O, cached inference, or historical proof enters the facts.
 */
export function currentPartialContribution(data, contribution, options = {}) {
  const previous = contribution.partial ?? {};
  const retired = contribution.question?.semanticReading || previous.assessment?.semanticReading;
  if (retired || !previous.readings || !contribution.question?.graph) {
    return mergePartialContribution(contribution, { parts: [], openings: [], complete: false });
  }
  if (
    previous.profile === partialContributionProfile &&
    previous.questionRevision !== partialQueryRevision(contribution.question.graph)
  ) {
    const result = mergePartialContribution(contribution, {
      parts: [],
      openings: [],
      complete: false,
    });
    result.replay = { status: 'question-changed', missingReadings: [] };
    result.questionRevision = previous.questionRevision;
    result.observedQuestionRevision = partialQueryRevision(contribution.question.graph);
    return result;
  }
  const selected = new Set([contribution.scopePlacementId]);
  for (const id of selected)
    for (const placement of data.placements)
      if (placement.parentId === id) selected.add(placement.id);
  const catalog = sourceCatalog(data).filter((source) => selected.has(source.nodeId));
  const entries = catalog.map((source) => {
    const retained = previous.readings.find(
      (reading) =>
        reading.placementId === source.nodeId &&
        reading.sentenceId === source.sentenceId &&
        reading.revision === source.revision &&
        !reading.semanticReading &&
        !reading.semanticReadingId &&
        !reading.semanticVocabularyId &&
        !reading.semanticDecompositionsId,
    );
    return {
      ...source,
      id: `partial-source:${partialIdentity([source.nodeId, source.sentenceId])}`,
      graph: source.graph ?? retained?.graph,
      penman: retained?.penman,
    };
  });
  // Case-bound proof cannot be replayed as an unconditional corpus observation.
  // A fresh check with the selected case must supply that context again.
  if (previous.caseSelection) {
    const result = mergePartialContribution(contribution, {
      parts: [],
      openings: [],
      complete: false,
    });
    result.replay = { status: 'case-recheck-required', missingReadings: [] };
    return result;
  }
  const graphId = `partial-query:${contribution.id}`;
  const assessment = evaluateAnswer(
    {
      inquiry: { text: contribution.question.text, graphId },
      graphs: [
        { ...contribution.question.graph, id: graphId },
        ...entries
          .filter((entry) => entry.graph)
          .map((entry) => ({ ...entry.graph, id: `${entry.id}/graph` })),
      ],
      sources: entries.map(({ graph, penman, ...entry }) => ({
        ...entry,
        graphId: graph ? `${entry.id}/graph` : null,
      })),
      amrs: entries
        .filter((entry) => entry.graph)
        .map((entry) => ({ graphId: `${entry.id}/graph`, response: { penman: entry.penman } })),
      project: { id: data.id, placementId: contribution.scopePlacementId },
    },
    { ...knowledgeSnapshot(data), contributions: [] },
    {
      ...options,
      retainPartialCoverage: true,
      partialCoverage: { ...options.partialCoverage, targets: previous.parts },
    },
  );
  const result = mergePartialContribution(
    contribution,
    assessment.partial
      ? {
          ...assessment.partial,
          complete: assessment.partial.complete && entries.every((entry) => entry.graph),
          parts: assessment.partial.parts.map((part) => ({
            ...part,
            sources: part.dependencies.map(({ text, nodeId, sentenceId, revision }) => ({
              text,
              nodeId,
              sentenceId,
              revision,
            })),
          })),
        }
      : { parts: [], openings: [], complete: false },
  );
  result.replay = {
    status: assessment.status,
    missingReadings: entries
      .filter((entry) => !entry.graph)
      .map(({ nodeId, sentenceId, revision }) => ({ nodeId, sentenceId, revision })),
  };
  return result;
}

export function currentPartialParts(data, contribution, options) {
  return currentPartialContribution(data, contribution, options).parts;
}
