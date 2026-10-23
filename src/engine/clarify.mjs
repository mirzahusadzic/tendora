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
  const labelled = bases.map((entry) => ({
    ...entry,
    graph: withAbstractLabels(entry.graph, labels.get(entry.id)),
  }));
  return proposeCorrespondences(question.graph, labelled).map((candidate) => {
    const basis = bases.find((entry) => entry.id === candidate.basisId);
    const source = reference(basis);
    return {
      ...candidate,
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

/** The author confirms a proposed meaning; the engine owns rule generation and dependencies. */
export function acceptClarification(project, candidate) {
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
      statement: 'The author confirms this source expresses the relationship asked about.',
    },
  };
  contribution.wordings.push(part);
  validateContributions(data);
  return { data, contribution, part };
}
