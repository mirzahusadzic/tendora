/** Retain and replay dependency-bound partial contributions without asserting them. */
import { randomUUID } from 'node:crypto';
import { checkAnswer } from './answer.mjs';
import { validateContributions } from '../project/authoring/development.mjs';
import { mergePartialContribution } from '../amr/partial-contribution.mjs';
import { currentPartialContribution } from '../project/authoring/partial.mjs';
import { partialIdentity, partialQueryRevision } from '../amr/partial-coverage.mjs';

export function retainPartialContribution(project, input, result, { retainOpenings = false } = {}) {
  return retain(project, input, result, undefined, { retainOpenings });
}

/** Persist a new assessment, including complete withdrawal or bounded failure.
 * With no input, replay only acquisitions already retained in the contribution.
 */
export function recheckPartialContribution(project, contributionId, input, result) {
  const contribution = project.data.contributions?.find((entry) => entry.id === contributionId);
  if (!contribution?.partial) throw new Error('Partial contribution is no longer available.');
  if (input) return retain(project, input, result, contributionId);
  const data = structuredClone(project.data);
  const next = data.contributions.find((entry) => entry.id === contributionId);
  next.partial = currentPartialContribution(data, next);
  validateContributions(data);
  return { data, contribution: next };
}

function retain(project, input, result, contributionId, { retainOpenings = false } = {}) {
  if (input.projectId !== project.data.id || input.projectRevision !== project.digest)
    throw new Error('The corpus changed. Check this question again before retaining its support.');
  if (
    result.semantic ||
    result.inputs.some(
      (entry) =>
        entry.semanticReading ||
        entry.semanticReadingId ||
        entry.semanticVocabularyId ||
        entry.semanticDecompositionsId,
    )
  )
    throw new Error(
      'This assessment used a retired interpretation pipeline. Ask again before retaining support.',
    );
  const reading = result.inputs.find((entry) => entry.kind === 'question');
  if (!reading?.graph) throw new Error('This question has no retained reading.');
  const data = structuredClone(project.data);
  let contribution = data.contributions?.find((entry) =>
    contributionId
      ? entry.id === contributionId
      : entry.scopePlacementId === input.scopePlacementId &&
        entry.question?.text === reading.text &&
        partialIdentity(entry.partial?.caseSelection ?? null) ===
          partialIdentity(input.caseSelection ?? null),
  );
  if (
    contribution &&
    (contribution.scopePlacementId !== input.scopePlacementId ||
      partialIdentity(contribution.partial?.caseSelection ?? null) !==
        partialIdentity(input.caseSelection ?? null) ||
      partialQueryRevision(contribution.question.graph) !== partialQueryRevision(reading.graph))
  )
    throw new Error('The question reading or scope changed. Retain a separate contribution.');
  const answer = checkAnswer(project, input, result, {
    retainPartialCoverage: Boolean(contribution),
    partialCoverage: { targets: contribution?.partial?.parts ?? [] },
  });
  if (
    !contributionId &&
    !answer.partial?.parts?.length &&
    !(retainOpenings && answer.partial?.openings?.some((opening) => opening.anchor))
  )
    throw new Error('This inquiry has no supported parts to retain.');
  if (!contribution) {
    contribution = {
      version: 1,
      id: randomUUID(),
      scopePlacementId: input.scopePlacementId,
      question: {
        text: reading.text,
        graph: structuredClone(reading.graph),
        acquisition: structuredClone(reading.acquisition),
      },
      responses: [],
      wordings: [],
    };
    (data.contributions ??= []).push(contribution);
  }
  // These are acquired source readings, not derived facts or saved answers.
  // Retaining them makes cold replay independent of disposable engine caches.
  contribution.partial = {
    ...contribution.partial,
    caseSelection: structuredClone(input.caseSelection),
    readings: result.inputs
      .filter((entry) => entry.kind !== 'question' && entry.graph)
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        text: entry.text,
        placementId: entry.placementId,
        sentenceId: entry.sentenceId,
        revision: entry.revision,
        graph: structuredClone(entry.graph),
        penman: entry.penman,
        acquisition: structuredClone(entry.acquisition),
      })),
  };
  contribution.partial = mergePartialContribution(contribution, {
    ...answer.partial,
    complete: answer.partial?.complete ?? false,
    parts: (answer.partial?.parts ?? []).map((part) => ({
      ...structuredClone(part),
      sources: result.inputs
        .filter((entry) => part.sourceIds.includes(entry.id))
        .map((entry) => ({
          text: entry.text,
          nodeId: entry.placementId,
          sentenceId: entry.sentenceId,
          revision: entry.revision,
        })),
    })),
    openings: answer.partial?.openings ?? [],
  });
  validateContributions(data);
  return { data, contribution };
}
