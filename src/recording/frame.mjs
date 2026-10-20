/** Versioned inquiry frames and explicitly attributed carry lineage. */
import { createHash } from 'node:crypto';
import { compileWording, wordingAlignment } from '../amr/development.mjs';
import { inquiryPattern } from '../amr/patterns.mjs';
import { graphRevision } from './revisions.mjs';

export const inquiryFrameProfile = 'cooperative-inquiry-frame-v1';
export const frameCarryProfile = 'cooperative-frame-carry-v1';
const FRAME_SCHEMA = 'tendora.inquiry-frame';
const FRAME_VERSION = 1;
const CARRY_SCHEMA = 'tendora.frame-carry';
const CARRY_VERSION = 1;
export const frameCarryActions = new Set([
  'continue-opening',
  'revise-question',
  'revise-purpose',
  'revise-scope',
  'revise-case',
]);

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textDigest = (text) => createHash('sha256').update(String(text)).digest('hex');
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
};

const sourceReference = (source) => ({
  ...(source.id ? { id: source.id } : {}),
  nodeId: source.nodeId ?? source.placementId,
  sentenceId: source.sentenceId ?? source.id ?? null,
  revision:
    source.revision ?? source.sentenceRevision ?? source.textDigest ?? textDigest(source.text),
  ...(source.graphRevision ? { graphRevision: source.graphRevision } : {}),
  textDigest: source.textDigest ?? textDigest(source.text),
});

const sourceReferences = (sources = []) =>
  sources
    .map(sourceReference)
    .sort((left, right) =>
      JSON.stringify([left.nodeId, left.sentenceId, left.revision]).localeCompare(
        JSON.stringify([right.nodeId, right.sentenceId, right.revision]),
      ),
    );

const caseReference = (selected) =>
  selected
    ? {
        id: selected.id ?? null,
        kind: selected.kind ?? 'selected',
        placementId: selected.placementId,
        conceptId: selected.conceptId ?? null,
        revision: selected.revision ?? textDigest(selected.label ?? ''),
        label: selected.label ?? 'Selected case',
        ...(selected.binding ? { binding: structuredClone(selected.binding) } : {}),
        sources: sourceReferences(selected.sources ?? []),
      }
    : null;

const frameBody = ({
  projectId,
  projectRevision,
  question,
  questionRevision = null,
  intention = null,
  scope,
  caseSelection = null,
  sources = [],
}) => ({
  profile: inquiryFrameProfile,
  project: { id: projectId, revision: projectRevision },
  question: { text: question ?? '', revision: questionRevision ?? null },
  intention: intention
    ? {
        id: intention.id,
        text: intention.text,
        ...(intention.previous ? { previous: intention.previous } : {}),
        ...(intention.actor ? { actor: intention.actor } : {}),
        ...(intention.at ? { at: intention.at } : {}),
      }
    : null,
  scope: {
    placementId: scope.placementId,
    label: scope.label ?? scope.placementId,
  },
  case: caseReference(caseSelection),
  sources: sourceReferences(sources),
});

export function createInquiryFrame(options) {
  if (!options?.projectId) throw new Error('Frame project required');
  if (!options?.scope?.placementId) throw new Error('Frame scope required');
  const body = {
    schema: FRAME_SCHEMA,
    version: FRAME_VERSION,
    ...frameBody(options),
  };
  return { id: digest(stable(body)), ...body };
}

export function frameWith(frame, changes = {}) {
  validateInquiryFrame(frame);
  return createInquiryFrame({
    projectId: changes.projectId ?? frame.project.id,
    projectRevision: changes.projectRevision ?? frame.project.revision,
    question: changes.question ?? frame.question.text,
    questionRevision:
      changes.questionRevision === undefined ? frame.question.revision : changes.questionRevision,
    intention: changes.intention === undefined ? frame.intention : changes.intention,
    scope: changes.scope ?? frame.scope,
    caseSelection: changes.caseSelection === undefined ? frame.case : changes.caseSelection,
    sources: changes.sources ?? frame.sources,
  });
}

export function frameQuestionRevision(frame, graph) {
  validateInquiryFrame(frame);
  return createInquiryFrame({
    projectId: frame.project.id,
    projectRevision: frame.project.revision,
    question: frame.question.text,
    questionRevision: graph ? graphRevision(graph) : null,
    intention: frame.intention,
    scope: frame.scope,
    caseSelection: frame.case,
    sources: frame.sources,
  });
}

export function validateInquiryFrame(frame) {
  const text = (value) => typeof value === 'string' && value.length > 0;
  if (
    !frame ||
    frame.schema !== FRAME_SCHEMA ||
    frame.version !== FRAME_VERSION ||
    !text(frame.id) ||
    frame.profile !== inquiryFrameProfile ||
    !text(frame.project?.id) ||
    !text(frame.project?.revision) ||
    typeof frame.question?.text !== 'string' ||
    (frame.question.revision !== null && !text(frame.question.revision)) ||
    (frame.intention !== null &&
      (!text(frame.intention?.id) || typeof frame.intention.text !== 'string')) ||
    !text(frame.scope?.placementId) ||
    typeof frame.scope?.label !== 'string' ||
    !Array.isArray(frame.sources) ||
    frame.sources.some(
      (source) =>
        !text(source?.nodeId) ||
        !text(source?.sentenceId) ||
        !text(source?.revision) ||
        !text(source?.textDigest),
    ) ||
    (frame.case !== null &&
      (!text(frame.case?.placementId) ||
        !text(frame.case?.revision) ||
        typeof frame.case?.label !== 'string' ||
        !Array.isArray(frame.case.sources)))
  )
    throw new Error('Invalid inquiry frame');
  const { id, ...body } = frame;
  if (id !== digest(stable(body))) throw new Error('Inquiry frame changed');
  return frame;
}

const sourceIdentity = (sources = []) =>
  sources
    .map((source) => ({
      nodeId: source.nodeId,
      sentenceId: source.sentenceId,
      revision: source.revision,
      textDigest: source.textDigest,
    }))
    .sort((left, right) =>
      JSON.stringify([left.nodeId, left.sentenceId, left.revision]).localeCompare(
        JSON.stringify([right.nodeId, right.sentenceId, right.revision]),
      ),
    );
const sameSources = (left, right) =>
  JSON.stringify(sourceIdentity(left)) === JSON.stringify(sourceIdentity(right));
const caseIdentity = (selected) =>
  selected
    ? {
        placementId: selected.placementId,
        conceptId: selected.conceptId ?? null,
        revision: selected.revision,
        binding: selected.binding ?? null,
        sources: sourceIdentity(selected.sources ?? []),
      }
    : null;
const sameCase = (left, right) =>
  JSON.stringify(caseIdentity(left)) === JSON.stringify(caseIdentity(right));

export function frameChanges(origin, receiving) {
  validateInquiryFrame(origin);
  validateInquiryFrame(receiving);
  const changes = [];
  if (
    origin.project.id !== receiving.project.id ||
    origin.project.revision !== receiving.project.revision
  )
    changes.push('corpus');
  if (
    origin.question.text !== receiving.question.text ||
    origin.question.revision !== receiving.question.revision
  )
    changes.push('question');
  if (
    origin.intention?.id !== receiving.intention?.id ||
    origin.intention?.text !== receiving.intention?.text
  )
    changes.push('purpose');
  if (origin.scope.placementId !== receiving.scope.placementId) changes.push('scope');
  if (!sameCase(origin.case, receiving.case)) changes.push('case');
  if (!sameSources(origin.sources, receiving.sources)) changes.push('sources');
  return changes;
}

const frameSummary = (frame) => ({
  frameRevision: frame.id,
  question: frame.question.text,
  questionRevision: frame.question.revision,
  intentionId: frame.intention?.id ?? null,
  purpose: frame.intention?.text ?? '',
  scopePlacementId: frame.scope.placementId,
  scopeLabel: frame.scope.label,
  case: frame.case ? structuredClone(frame.case) : null,
  sources: frame.sources,
});

export function createFrameCarry({
  origin,
  receiving,
  opening,
  action,
  rationale,
  actor = 'participant',
  originRecording = null,
  status = 'pending',
  correspondence = null,
  support = 'recheck',
  reason = '',
}) {
  validateInquiryFrame(origin);
  validateInquiryFrame(receiving);
  if (!frameCarryActions.has(action)) throw new Error('Invalid frame carry action');
  if (typeof actor !== 'string' || !actor.trim()) throw new Error('Frame carry actor required');
  if (!['pending', 'candidate', 'checked'].includes(status))
    throw new Error('Invalid frame carry status');
  const changes = frameChanges(origin, receiving);
  const body = {
    profile: frameCarryProfile,
    actor,
    action,
    rationale:
      typeof rationale === 'string' && rationale.trim()
        ? rationale.trim()
        : 'Continued the retained inquiry frame.',
    origin: {
      ...frameSummary(origin),
      ...(originRecording
        ? {
            recordingPath: originRecording.path ?? null,
            recordingRevision: originRecording.revision ?? null,
          }
        : {}),
      opening: opening
        ? {
            id: opening.id,
            kind: opening.kind ?? null,
            label: opening.label ?? '',
            ...(opening.anchor ? { anchor: structuredClone(opening.anchor) } : {}),
            ...(opening.edge ? { edge: structuredClone(opening.edge) } : {}),
          }
        : null,
    },
    receiving: frameSummary(receiving),
    changes,
    status,
    support,
    correspondence: correspondence ? structuredClone(correspondence) : null,
    reason: reason || '',
  };
  const complete = { schema: CARRY_SCHEMA, version: CARRY_VERSION, ...body };
  return { id: digest(stable(complete)), ...complete };
}

export function validateFrameCarry(carry) {
  const text = (value) => typeof value === 'string' && value.length > 0;
  if (
    !carry ||
    carry.schema !== CARRY_SCHEMA ||
    carry.version !== CARRY_VERSION ||
    !text(carry.id) ||
    carry.profile !== frameCarryProfile ||
    !text(carry.actor) ||
    !frameCarryActions.has(carry.action) ||
    !text(carry.rationale) ||
    !text(carry.origin?.frameRevision) ||
    !text(carry.receiving?.frameRevision) ||
    !Array.isArray(carry.changes) ||
    !Array.isArray(carry.origin?.sources) ||
    !['pending', 'candidate', 'checked'].includes(carry.status) ||
    !['recheck', 'unchanged', 'invalidated'].includes(carry.support) ||
    typeof carry.reason !== 'string' ||
    (carry.status === 'checked' && !carry.correspondence)
  )
    throw new Error('Invalid frame carry');
  const { id, ...body } = carry;
  if (id !== digest(stable(body))) throw new Error('Frame carry changed');
  return carry;
}

function sameOpeningEdge(opening, graph) {
  if (!opening?.edge || !graph) return null;
  return graph.edges.find((edge) => JSON.stringify(edge) === JSON.stringify(opening.edge)) ?? null;
}

function checkedWithoutQuestionChange({ origin, receiving, opening, action, changes }) {
  if (changes.some((change) => change !== 'purpose')) return null;
  if (origin.question.revision === null || origin.question.revision !== receiving.question.revision)
    return null;
  return {
    status: 'checked',
    support: 'unchanged',
    reason:
      changes.includes('purpose') && action === 'revise-purpose'
        ? 'Purpose changed; logical support is unchanged.'
        : 'The receiving question retains the originating reading.',
    correspondence: {
      kind: changes.length ? 'purpose-only' : 'same-question',
      originFrameRevision: origin.id,
      receivingFrameRevision: receiving.id,
      openingId: opening?.id ?? null,
    },
  };
}

function mappedOpening(originGraph, receivingGraph, opening) {
  if (!originGraph || !receivingGraph || !opening?.edge) return null;
  if (opening.kind !== 'query' && opening.kind !== 'source-edge') return null;
  let aligned;
  try {
    aligned = wordingAlignment(originGraph, receivingGraph);
  } catch (error) {
    return {
      status: 'pending',
      support: 'recheck',
      reason: `A receiving correspondence was not established: ${error.message}`,
      correspondence: null,
    };
  }
  const receivingPattern = inquiryPattern(receivingGraph);
  const sourceIds = new Map(
    [...inquiryPattern(originGraph).variables].map(([id, variable]) => [variable, id]),
  );
  const edgeSide = (variable) => sourceIds.get(variable);
  const candidates = receivingGraph.edges.filter(
    (edge) =>
      edge.role === opening.edge.role &&
      edgeSide(aligned.mapping.get(receivingPattern.variables.get(edge.from))) ===
        opening.edge.from &&
      edgeSide(aligned.mapping.get(receivingPattern.variables.get(edge.to))) === opening.edge.to,
  );
  if (candidates.length > 1)
    return {
      status: 'candidate',
      support: 'recheck',
      reason: 'More than one receiving relation could carry the opening; keep it open for review.',
      correspondence: {
        kind: 'ambiguous-hrg-edge',
        openingId: opening.id,
        receivingEdgeIds: candidates.map((edge) => edge.id),
      },
    };
  if (!candidates.length)
    return {
      status: aligned.mapping.size > 1 ? 'candidate' : 'pending',
      support: 'recheck',
      reason:
        aligned.mapping.size > 1
          ? 'The readings align, but no unique receiving relation carries this opening.'
          : 'No receiving relation carries this opening yet.',
      correspondence: {
        kind: 'partial-alignment',
        openingId: opening.id,
        mappedNodes: aligned.mapping.size,
      },
    };
  try {
    compileWording(originGraph, receivingGraph);
  } catch (error) {
    return {
      status: 'candidate',
      support: 'recheck',
      reason: `The relation maps, but qualifications or answer slots changed: ${error.message}`,
      correspondence: {
        kind: 'candidate-hrg-edge',
        openingId: opening.id,
        receivingEdge: structuredClone(candidates[0]),
      },
    };
  }
  const exact = graphRevision(originGraph) === graphRevision(receivingGraph);
  const assertion = (graph) => ({
    top: graph.top,
    assertionTop: graph.assertionTop ?? graph.top,
    polarity: graph.edges
      .filter((edge) => edge.role === ':polarity')
      .map((edge) => graph.nodes.find((node) => node.id === edge.to)?.concept ?? edge.to)
      .sort(),
    qualifications: graph.edges
      .filter((edge) => [':condition', ':concession', ':mode', ':quant'].includes(edge.role))
      .map((edge) => JSON.stringify([edge.role, edge.to]))
      .sort(),
  });
  const preserved =
    JSON.stringify(assertion(originGraph)) === JSON.stringify(assertion(receivingGraph));
  return {
    status: exact && preserved ? 'checked' : 'candidate',
    support: exact && preserved ? 'unchanged' : 'recheck',
    reason:
      exact && preserved
        ? 'The receiving question retains the identical checked reading.'
        : exact
          ? 'The retained graph is identical, but its assertion or qualification metadata is not.'
          : preserved
            ? 'A unique proposed correspondence exists, but graph mapping or authorship compilation does not establish semantic preservation.'
            : 'The proposed correspondence changes the assertion anchor, polarity or qualification scope.',
    correspondence: {
      kind: exact ? 'identical-reading' : 'candidate-hrg-edge',
      openingId: opening.id,
      originEdge: structuredClone(opening.edge),
      receivingEdge: structuredClone(candidates[0]),
      derivation: structuredClone(aligned.derivation),
    },
  };
}

export function checkFrameCarry({
  origin,
  receiving,
  opening,
  action,
  rationale,
  actor,
  originRecording,
  originGraph,
  receivingGraph,
  originGraphRole = 'question',
  receivingGraphRole = 'question',
}) {
  validateInquiryFrame(origin);
  validateInquiryFrame(receiving);
  if (
    originGraphRole === 'question' &&
    originGraph &&
    origin.question.revision !== graphRevision(originGraph)
  )
    throw new Error('Origin graph does not match its retained question revision');
  if (
    receivingGraphRole === 'question' &&
    receivingGraph &&
    receiving.question.revision !== null &&
    receiving.question.revision !== graphRevision(receivingGraph)
  )
    throw new Error('Receiving graph does not match its question revision');
  const changes = frameChanges(origin, receiving);
  if (origin.project.id !== receiving.project.id) {
    return createFrameCarry({
      origin,
      receiving,
      opening,
      action,
      rationale,
      actor,
      originRecording,
      status: 'pending',
      support: 'invalidated',
      reason:
        'The receiving question belongs to another project. The earlier relation is retained as lineage, but its support must be established explicitly in the receiving corpus.',
      correspondence: null,
    });
  }
  const unchanged = checkedWithoutQuestionChange({ origin, receiving, opening, action, changes });
  if (origin.question.revision === null || receiving.question.revision === null) {
    const pending = createFrameCarry({
      origin,
      receiving,
      opening,
      action,
      rationale,
      actor,
      originRecording,
      status: 'pending',
      support: 'recheck',
      reason: 'At least one side of the carry has no acquired question reading.',
      correspondence: null,
    });
    return pending;
  }
  const mapped = changes.includes('question')
    ? mappedOpening(originGraph, receivingGraph, opening)
    : null;
  let assessment = unchanged ?? mapped;
  const contextChanged = changes.some((change) =>
    ['corpus', 'scope', 'sources', 'case'].includes(change),
  );
  if (assessment && contextChanged) {
    assessment = {
      ...assessment,
      support: 'invalidated',
      reason: `${assessment.reason} The corpus, scope, sources or case also changed, so earlier support must be reassessed in the receiving context.`,
    };
  }
  if (!assessment) {
    if (changes.length) {
      assessment = {
        status: 'candidate',
        support: contextChanged ? 'invalidated' : 'recheck',
        reason: 'The frame changed; support must be checked again in the receiving context.',
        correspondence: {
          kind: 'frame-change',
          changes,
          openingId: opening?.id ?? null,
        },
      };
    } else {
      const sameEdge = sameOpeningEdge(opening, receivingGraph ?? originGraph);
      assessment = {
        status: sameEdge ? 'checked' : 'pending',
        support: sameEdge ? 'unchanged' : 'recheck',
        reason: sameEdge
          ? 'The receiving question retains the exact opening relation.'
          : 'The opening has no retained receiving relation.',
        correspondence: sameEdge
          ? {
              kind: 'same-opening-edge',
              openingId: opening?.id ?? null,
              receivingEdge: structuredClone(sameEdge),
            }
          : null,
      };
    }
  }
  return createFrameCarry({
    origin,
    receiving,
    opening,
    action,
    rationale,
    actor,
    originRecording,
    ...assessment,
  });
}

export function carryStatusLabel(carry) {
  if (!carry) return 'No carry recorded';
  const status = {
    checked: 'Correspondence checked',
    candidate: 'Candidate carry; review remains',
    pending: 'Carry pending',
  }[carry.status];
  const support = {
    unchanged: 'support unchanged',
    invalidated: 'earlier support invalidated',
    recheck: 'earlier support requires reassessment',
  }[carry.support];
  return `${status}; ${support}`;
}

export function frameChangeLabel(changes = []) {
  if (!changes.length) return 'No frame change';
  const labels = {
    question: 'question',
    purpose: 'purpose',
    scope: 'scope',
    case: 'case',
    sources: 'corpus sources',
    corpus: 'corpus or accepted knowledge',
  };
  return changes.map((change) => labels[change] ?? change).join(', ');
}

export function frameLineageRows(continuation) {
  const carry = continuation?.carry;
  if (!carry) return [];
  const origin = continuation.originFrame ?? carry.origin;
  return [
    ['Continued from', origin.question?.text ?? origin.question ?? carry.origin?.question, 'input'],
    [
      'Earlier purpose',
      origin.intention?.text ?? origin.purpose ?? carry.origin?.purpose ?? 'Not recorded',
    ],
    ['Earlier scope', origin.scope?.label ?? origin.scopeLabel ?? carry.origin?.scopeLabel],
    ...((origin.case ?? carry.origin?.case)
      ? [['Earlier case', (origin.case ?? carry.origin.case).label, 'input']]
      : []),
    ...(carry ? [['Why this question changed', carry.rationale]] : []),
    ...(carry ? [['What changed', frameChangeLabel(carry.changes)]] : []),
    ...(continuation.opening ? [['Open connection', continuation.opening.label, 'warning']] : []),
    ...(carry
      ? [['Now', actionableCarryState(carry), carry.status === 'checked' ? 'located' : 'warning']]
      : []),
  ];
}

function actionableCarryState(carry) {
  if (carry.support === 'invalidated')
    return 'Earlier support does not carry. Check the current question and keep unresolved connections open.';
  if (carry.status === 'pending')
    return 'The connection remains pending. Inspect the current answer and support below.';
  if (carry.status === 'candidate')
    return 'The connection is a candidate. Review the current answer and open connections before relying on it.';
  if (carry.support === 'unchanged')
    return 'The checked reading is unchanged. Review the current answer and open connections below.';
  return 'The relation was carried. Review the current answer and open connections below.';
}
