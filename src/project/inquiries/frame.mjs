/** Build and finalize cooperative inquiry frames from authored project state. */
import { createHash } from 'node:crypto';
import { sourceCatalog } from '../authoring/sources.mjs';
import { projectInquiryBranch } from './scope.mjs';
import { graphRevision } from '../../recording/revisions.mjs';
import {
  checkFrameCarry,
  createInquiryFrame,
  createFrameCarry,
  frameChanges,
  frameQuestionRevision,
  frameWith,
  validateFrameCarry,
  validateInquiryFrame,
} from '../../recording/frame.mjs';

const digestText = (value) => createHash('sha256').update(String(value)).digest('hex');

const scopeDescription = (project, placementId) => {
  const branch = projectInquiryBranch(project, placementId);
  const selected = branch.find((node) => node.placementId === placementId);
  return selected?.path.join(' → ') ?? selected?.name ?? placementId;
};

export function projectFrameSources(project, placementId) {
  const scope = new Set(projectInquiryBranch(project, placementId).map((node) => node.placementId));
  return sourceCatalog(project.data)
    .filter((source) => scope.has(source.nodeId) && source.development?.asserted !== false)
    .map((source) => ({
      id: source.id,
      nodeId: source.nodeId,
      sentenceId: source.sentenceId,
      revision: source.revision,
      graphRevision: source.graph ? graphRevision(source.graph) : null,
      textDigest: source.textDigest,
      text: source.text,
    }));
}

export function buildInquiryFrame(
  project,
  {
    question,
    questionGraph = null,
    intention = null,
    scopePlacementId,
    caseSelection = null,
    sources = null,
    projectRevision = project.digest,
    questionRevision,
  } = {},
) {
  if (!scopePlacementId) throw new Error('Inquiry scope required');
  return createInquiryFrame({
    projectId: project.data.id,
    projectRevision,
    question: question ?? '',
    questionRevision:
      questionRevision === undefined
        ? questionGraph
          ? graphRevision(questionGraph)
          : null
        : questionRevision,
    intention,
    scope: {
      placementId: scopePlacementId,
      label: scopeDescription(project, scopePlacementId),
    },
    caseSelection,
    sources: sources ?? projectFrameSources(project, scopePlacementId),
  });
}

export function draftContinuationFrame(project, continuation, ask, questionGraph = null) {
  if (continuation.version !== 3 || !continuation.originFrame)
    return { ...continuation, carry: continuation.carry ?? null };
  const receiving = buildInquiryFrame(project, {
    question: ask?.question ?? continuation.question ?? '',
    questionGraph,
    intention: ask?.intention ?? null,
    scopePlacementId: ask?.scopePlacementId ?? continuation.scopePlacementId,
    caseSelection: ask?.caseSelection ?? null,
    sources: projectFrameSources(project, ask?.scopePlacementId ?? continuation.scopePlacementId),
  });
  return attachDraftCarry(continuation, receiving, ask);
}

function attachDraftCarry(continuation, receiving, ask) {
  const origin = validateInquiryFrame(continuation.originFrame);
  const parentFrame =
    origin.question.revision === null && continuation.parent.queryGraph
      ? frameQuestionRevision(origin, continuation.parent.queryGraph)
      : origin;
  const action = ask?.continuationAction ?? continuation.action ?? 'continue-opening';
  const originOpening = continuation.originOpening ?? continuation.opening;
  const carry = createFrameCarry({
    origin: parentFrame,
    receiving,
    opening: originOpening,
    action,
    rationale: ask?.continuationRationale ?? continuation.rationale,
    actor: ask?.actor ?? 'participant',
    originRecording: {
      path: continuation.parent.path,
      revision: continuation.parent.revision,
    },
    status: 'pending',
    support: 'recheck',
    reason: 'The receiving inquiry has not been checked yet.',
  });
  return {
    ...continuation,
    version: 3,
    originFrame: parentFrame,
    question: receiving.question.text,
    scopePlacementId: receiving.scope.placementId,
    frame: receiving,
    carry,
    originOpening: originOpening ? structuredClone(originOpening) : null,
    retainedOpening: continuation.retainedOpening
      ? structuredClone(continuation.retainedOpening)
      : continuation.opening
        ? structuredClone(continuation.opening)
        : null,
    history: [...(continuation.history ?? [])],
  };
}

export function finalizedContinuationFrame(
  project,
  continuation,
  { reasoning, ask, engineProjectDigest = project.digest, scopePlacementId, caseSelection = null },
) {
  if (continuation.version !== 3 || !continuation.originFrame) return continuation;
  const question = reasoning.inputs.find((entry) => entry.kind === 'question');
  const sources = reasoning.inputs
    .filter((entry) => entry.kind === 'source')
    .map((entry) => ({
      id: entry.id,
      nodeId: entry.placementId,
      sentenceId: entry.sentenceId,
      revision: entry.revision,
      graphRevision: entry.graph ? graphRevision(entry.graph) : null,
      textDigest: entry.text ? digestText(entry.text) : null,
    }));
  const receiving = buildInquiryFrame(project, {
    question: question?.text ?? continuation.question,
    questionGraph: question?.graph ?? null,
    intention: ask?.intention ?? null,
    scopePlacementId,
    caseSelection,
    sources,
    projectRevision: engineProjectDigest,
  });
  const origin = validateInquiryFrame(continuation.originFrame);
  const parentFrame =
    origin.question.revision === null && continuation.parent.queryGraph
      ? frameQuestionRevision(origin, continuation.parent.queryGraph)
      : origin;
  const action = ask?.continuationAction ?? continuation.action ?? 'continue-opening';
  const originGraph =
    continuation.opening?.kind === 'query'
      ? (continuation.interpretedGraphs?.query ?? continuation.parent.queryGraph)
      : (continuation.interpretedGraphs?.source ?? continuation.parent.sourceGraph);
  const carry = checkFrameCarry({
    origin: parentFrame,
    receiving,
    opening: continuation.originOpening ?? continuation.opening,
    action,
    rationale: ask?.continuationRationale ?? continuation.rationale,
    actor: ask?.actor ?? 'participant',
    originRecording: {
      path: continuation.parent.path,
      revision: continuation.parent.revision,
    },
    originGraph,
    originGraphRole: continuation.opening?.kind === 'query' ? 'question' : 'source',
    receivingGraph: question?.graph ?? null,
    receivingGraphRole: 'question',
  });
  const originOpening = continuation.originOpening
    ? structuredClone(continuation.originOpening)
    : structuredClone(continuation.opening);
  const retainedOpening = continuation.retainedOpening
    ? structuredClone(continuation.retainedOpening)
    : structuredClone(continuation.opening);
  validateFrameCarry(carry);
  return {
    ...continuation,
    version: 3,
    originFrame: parentFrame,
    question: question?.text ?? continuation.question,
    scopePlacementId,
    frame: receiving,
    carry,
    originOpening,
    retainedOpening,
    history: [
      ...(continuation.history ?? []).slice(0, -1),
      {
        ...(continuation.history?.at(-1) ?? {}),
        question: continuation.parent.question,
        purpose: parentFrame.intention?.text ?? '',
        frameRevision: parentFrame.id,
      },
    ],
    originOpening,
  };
}

export function refreshAskFrame(project, ask, { questionGraph = null } = {}) {
  const intention = ask.intention ?? null;
  const frame = buildInquiryFrame(project, {
    question: ask.question ?? '',
    questionGraph,
    intention,
    scopePlacementId: ask.scopePlacementId,
    caseSelection: ask.caseSelection ?? null,
    sources: projectFrameSources(project, ask.scopePlacementId),
  });
  return frame;
}

export function frameFromRecording(
  project,
  recording,
  { intention = null, scopePlacementId = null, caseSelection = null } = {},
) {
  const question = recording.graphs.find((graph) => graph.id === recording.inquiry.graphId);
  return createInquiryFrame({
    projectId: project.data.id,
    projectRevision: recording.project?.digest ?? project.digest,
    question: recording.inquiry.text,
    questionRevision: question ? graphRevision(question) : null,
    intention,
    scope: {
      placementId: scopePlacementId ?? recording.project?.placementId,
      label: scopeDescription(project, scopePlacementId ?? recording.project?.placementId),
    },
    caseSelection: caseSelection ?? recording.caseState?.selection ?? null,
    sources: recording.sources.map((source) => {
      const graph = recording.graphs.find((item) => item.id === source.graphId);
      return {
        id: source.id,
        nodeId: source.nodeId,
        sentenceId: source.sentenceId,
        revision: source.revision,
        graphRevision: graph ? graphRevision(graph) : null,
        textDigest: source.textDigest,
        text: source.text,
      };
    }),
  });
}

export function currentFrameContext(project, ask, { questionGraph = null } = {}) {
  const intention = ask.intention ?? null;
  const checked = ask.checkedFrame ?? null;
  const revision =
    checked && checked.question.text === ask.question ? checked.question.revision : null;
  return buildInquiryFrame(project, {
    question: ask.question ?? '',
    questionGraph,
    intention,
    scopePlacementId: ask.scopePlacementId,
    caseSelection: ask.caseSelection ?? null,
    sources: projectFrameSources(project, ask.scopePlacementId),
    questionRevision: questionGraph ? graphRevision(questionGraph) : revision,
  });
}

export function finalizeAskFrame(project, ask, recording, checkCarry = checkFrameCarry) {
  const intention = ask.intention ?? recording.ask?.intention ?? null;
  if (recording.continuation?.frame) {
    const frame = recording.continuation.frame;
    const carry = recording.continuation.carry ?? null;
    if (!carry || carry.receiving?.frameRevision !== frame.id)
      throw new Error('Continuation frame and receiving carry disagree');
    return { frame, carry };
  }
  const frame = frameFromRecording(project, recording, {
    intention,
    scopePlacementId: ask.scopePlacementId,
    caseSelection: ask.caseSelection ?? null,
  });
  const origin = ask.originFrame ?? ask.checkedFrame ?? null;
  if (!origin) return { frame, carry: ask.carry ?? null };
  const changes = frameChanges(origin, frame);
  if (!changes.length) return { frame, carry: ask.carry ?? null };
  const opening = ask.carry?.origin?.opening ?? ask.continuation?.opening ?? null;
  const carry = checkCarry({
    origin,
    receiving: frame,
    opening,
    action:
      ask.continuationAction ??
      (changes.includes('question') ? 'revise-question' : 'continue-opening'),
    rationale: ask.continuationRationale ?? ask.carry?.rationale,
    actor: ask.actor ?? 'participant',
    originRecording: ask.origin ?? null,
    originGraph: null,
    receivingGraph: recording.graphs.find((graph) => graph.id === recording.inquiry.graphId),
  });
  return { frame, carry };
}

export function purposeOnlyCarry(
  ask,
  previousFrame,
  nextIntention,
  rationale,
  currentFrame = null,
) {
  const origin = previousFrame ?? ask.frame;
  if (!origin) return null;
  const receiving = frameWith(currentFrame ?? origin, { intention: nextIntention });
  const carry = checkFrameCarry({
    origin,
    receiving,
    opening: ask.continuation?.opening ?? null,
    action: 'revise-purpose',
    rationale,
    actor: 'participant',
    originRecording: ask.origin?.path
      ? { path: ask.origin.path, revision: ask.origin.recordingRevision }
      : null,
    originGraph: null,
    receivingGraph: null,
  });
  return { frame: receiving, carry };
}
