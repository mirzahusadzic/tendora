/** Cooperative frames retain provenance without turning graph similarity into evidence. */
import assert from 'node:assert/strict';
import {
  carryStatusLabel,
  checkFrameCarry,
  createInquiryFrame,
  frameChanges,
  validateFrameCarry,
  validateInquiryFrame,
} from '../../src/recording/frame.mjs';
import { graphRevision } from '../../src/recording/revisions.mjs';

const source = (id, text, revision = `revision-${id}`) => ({
  id,
  nodeId: 'root',
  sentenceId: `sentence-${id}`,
  revision,
  graphRevision: `graph-${id}`,
  textDigest: `digest-${id}`,
  text,
});
const selectedCase = {
  id: 'case-a',
  kind: 'authored',
  placementId: 'case-role',
  conceptId: 'case-role',
  revision: 'case-r1',
  label: 'Synthetic incident',
  sources: [source('case-source', 'The lead approved restart A.')],
  binding: null,
};
const intention = (id, text) => ({ id, text, actor: 'participant', at: '2026-10-20T00:00:00Z' });
const baseQuery = {
  top: 'r',
  assertionTop: 'r',
  nodes: [
    { id: 'r', concept: 'restart-01' },
    { id: 'o', concept: 'operator' },
    { id: 's', concept: 'service' },
    { id: 'if', concept: 'approve-01' },
    { id: 'lead', concept: 'lead' },
  ],
  edges: [
    { id: 'e0', from: 'r', role: ':ARG0', to: 'o' },
    { id: 'e1', from: 'r', role: ':ARG1', to: 's' },
    { id: 'e2', from: 'r', role: ':condition', to: 'if' },
    { id: 'e3', from: 'if', role: ':ARG0', to: 'lead' },
  ],
};
const frame = (changes = {}) =>
  createInquiryFrame({
    projectId: 'project',
    projectRevision: 'project-r1',
    question: 'May the operator restart the service?',
    questionRevision: graphRevision(baseQuery),
    intention: intention('purpose-r1', 'Establish whether a restart is permitted.'),
    scope: { placementId: 'root', label: 'Incident / Root' },
    caseSelection: selectedCase,
    sources: [source('source-r1', 'The lead approved restart A.')],
    ...changes,
  });

const origin = frame();
validateInquiryFrame(origin);
assert.equal(validateInquiryFrame(JSON.parse(JSON.stringify(origin))).id, origin.id);
assert.deepEqual(frameChanges(origin, frame()), []);
assert.throws(() => validateInquiryFrame({ ...origin, id: 'f'.repeat(64) }), /changed/u);

const purpose = frame({
  intention: intention('purpose-r2', 'Explain restart authority to maintenance planning.'),
});
assert.deepEqual(frameChanges(origin, purpose), ['purpose']);
const purposeCarry = checkFrameCarry({
  origin,
  receiving: purpose,
  opening: null,
  action: 'revise-purpose',
  rationale: 'The result now needs to inform a plan.',
});
validateFrameCarry(purposeCarry);
assert.equal(purposeCarry.status, 'checked');
assert.equal(purposeCarry.support, 'unchanged');
assert.match(carryStatusLabel(purposeCarry), /Correspondence checked.*support unchanged/u);

const stalePurpose = checkFrameCarry({
  origin,
  receiving: frame({ intention: purpose.intention }),
  opening: null,
  action: 'revise-purpose',
  rationale: 'Purpose changed without changing the checking context.',
  originGraph: null,
  receivingGraph: null,
});
assert.equal(stalePurpose.status, 'checked');
assert.equal(
  frameChanges(
    frame({
      sources: [
        {
          ...source('runtime', 'Same', 'same-revision'),
          sentenceId: 'same-sentence',
          graphRevision: 'normalized',
          textDigest: 'same-text',
        },
      ],
    }),
    frame({
      sources: [
        {
          ...source('authored', 'Same', 'same-revision'),
          sentenceId: 'same-sentence',
          graphRevision: 'authored',
          textDigest: 'same-text',
        },
      ],
    }),
  ).includes('sources'),
  false,
  'Source-stage fingerprints do not masquerade as source changes',
);

const unacquiredOrigin = frame({ questionRevision: null });
const unacquiredReceiving = frame({ questionRevision: null, intention: purpose.intention });
const unacquiredCarry = checkFrameCarry({
  origin: unacquiredOrigin,
  receiving: unacquiredReceiving,
  opening: null,
  action: 'revise-purpose',
  rationale: 'Revise purpose before acquisition.',
});
assert.equal(unacquiredCarry.status, 'pending');
assert.equal(unacquiredCarry.support, 'recheck');

const changedSource = frame({
  projectRevision: 'project-r2',
  sources: [source('source-r2', 'The lead approved restart A.', 'source-r2')],
});
assert.deepEqual(frameChanges(origin, changedSource), ['corpus', 'sources']);
const sourceCarry = checkFrameCarry({
  origin,
  receiving: changedSource,
  opening: null,
  action: 'revise-scope',
  rationale: 'The source was revised.',
});
assert.equal(sourceCarry.support, 'invalidated');
assert.equal(sourceCarry.status, 'candidate');

const acceptedKnowledge = frame({ projectRevision: 'project-r3' });
assert.deepEqual(frameChanges(origin, acceptedKnowledge), ['corpus']);
const knowledgeCarry = checkFrameCarry({
  origin,
  receiving: acceptedKnowledge,
  opening: null,
  action: 'continue-opening',
  rationale: 'Accepted a new corpus-relative binding.',
});
assert.equal(knowledgeCarry.status, 'candidate');
assert.equal(knowledgeCarry.support, 'invalidated');

const otherProject = frame({ projectId: 'other-project', projectRevision: 'other-r1' });
const crossProject = checkFrameCarry({
  origin,
  receiving: otherProject,
  opening: null,
  action: 'continue-opening',
  rationale: 'Reuse the earlier question in another project.',
});
assert.equal(crossProject.status, 'pending');
assert.equal(crossProject.support, 'invalidated');
assert.match(crossProject.reason, /another project/u);

const changedCase = frame({
  projectRevision: 'project-r4',
  caseSelection: {
    ...selectedCase,
    revision: 'case-r2',
    sources: [source('case-b', 'Restart B.')],
  },
});
assert.deepEqual(frameChanges(origin, changedCase), ['corpus', 'case']);
const boundCase = frame({
  projectRevision: 'project-r5',
  caseSelection: {
    ...selectedCase,
    binding: {
      caseNodeId: 'case-role',
      queryNodeId: 'restart',
      graphDigest: 'graph-r1',
      questionDigest: 'q1',
      decisionId: 'd1',
    },
  },
});
assert.deepEqual(frameChanges(origin, boundCase), ['corpus', 'case']);

const opening = {
  id: 'query:e2',
  kind: 'query',
  label: 'restart condition approve',
  edge: baseQuery.edges[2],
};
const sameQuestion = frame();
const otherReceivingGraph = structuredClone(baseQuery);
const otherQuestion = frame({
  projectRevision: 'project-r6',
  question: 'May the maintenance plan include a restart?',
  questionRevision: graphRevision(otherReceivingGraph),
});
const candidate = checkFrameCarry({
  origin: sameQuestion,
  receiving: otherQuestion,
  opening,
  action: 'revise-question',
  rationale: 'Reframe the permission as a planning question.',
  originGraph: baseQuery,
  receivingGraph: otherReceivingGraph,
});
validateFrameCarry(candidate);
assert.equal(candidate.status, 'checked');
assert.equal(candidate.support, 'invalidated');

const changedPredicate = structuredClone(baseQuery);
changedPredicate.nodes.find((node) => node.id === 'r').concept = 'approve-01';
const predicateReceiving = frame({
  projectRevision: 'project-r7',
  question: 'Who approved the restart?',
  questionRevision: graphRevision(changedPredicate),
});
const predicateCarry = checkFrameCarry({
  origin: sameQuestion,
  receiving: predicateReceiving,
  opening,
  action: 'revise-question',
  rationale: 'The receiving question changed the predicate.',
  originGraph: baseQuery,
  receivingGraph: changedPredicate,
});
assert.equal(predicateCarry.status, 'candidate');
assert.notEqual(predicateCarry.support, 'unchanged');

const changedActor = structuredClone(baseQuery);
changedActor.nodes.find((node) => node.id === 'o').concept = 'lead';
const actorReceiving = frame({
  projectRevision: 'project-r8',
  question: 'May the lead restart the service?',
  questionRevision: graphRevision(changedActor),
});
const actorCarry = checkFrameCarry({
  origin: sameQuestion,
  receiving: actorReceiving,
  opening,
  action: 'revise-question',
  rationale: 'The receiving question changed the actor.',
  originGraph: baseQuery,
  receivingGraph: changedActor,
});
assert.equal(actorCarry.status, 'candidate');
assert.notEqual(actorCarry.support, 'unchanged');

const assertionChanged = structuredClone(baseQuery);
assertionChanged.assertionTop = 'if';
const assertionReceiving = frame({
  projectRevision: 'project-r9',
  question: 'Is the lead approval conditional?',
  questionRevision: graphRevision(assertionChanged),
});
const assertionCarry = checkFrameCarry({
  origin: sameQuestion,
  receiving: assertionReceiving,
  opening,
  action: 'revise-question',
  rationale: 'The assertion anchor moved.',
  originGraph: baseQuery,
  receivingGraph: assertionChanged,
});
assert.equal(assertionCarry.status, 'candidate');
assert.equal(assertionCarry.support, 'invalidated');

const qualificationMoved = structuredClone(baseQuery);
qualificationMoved.edges.find((edge) => edge.id === 'e2').role = ':concession';
const qualificationReceiving = frame({
  projectRevision: 'project-r10',
  question: 'May the operator restart despite the approval?',
  questionRevision: graphRevision(qualificationMoved),
});
const qualificationCarry = checkFrameCarry({
  origin: sameQuestion,
  receiving: qualificationReceiving,
  opening,
  action: 'revise-question',
  rationale: 'The qualification changed scope.',
  originGraph: baseQuery,
  receivingGraph: qualificationMoved,
});
assert.equal(qualificationCarry.status, 'candidate');

const repeated = {
  ...baseQuery,
  nodes: [...baseQuery.nodes, { id: 'lead2', concept: 'lead' }],
  edges: [...baseQuery.edges, { id: 'e4', from: 'if', role: ':ARG1', to: 'lead2' }],
};
const repeatedReceiving = frame({
  projectRevision: 'project-r11',
  question: 'Who approved the service restart?',
  questionRevision: graphRevision(repeated),
});
const ambiguous = checkFrameCarry({
  origin: sameQuestion,
  receiving: repeatedReceiving,
  opening,
  action: 'revise-question',
  rationale: 'Keep both possible mappings visible.',
  originGraph: baseQuery,
  receivingGraph: repeated,
});
assert.equal(ambiguous.status, 'candidate');
assert.equal(ambiguous.support, 'invalidated');
assert.equal(validateFrameCarry(ambiguous).id, ambiguous.id);

const combinedGraph = structuredClone(baseQuery);
const combined = frame({
  projectRevision: 'project-r12',
  question: 'What may the maintenance plan include?',
  questionRevision: graphRevision(combinedGraph),
  scope: { placementId: 'planning', label: 'Planning' },
  sources: [source('planning', 'The maintenance plan includes restart A.')],
});
const combinedCarry = checkFrameCarry({
  origin,
  receiving: combined,
  opening,
  action: 'revise-scope',
  rationale: 'Move the question into planning after changing it.',
  originGraph: baseQuery,
  receivingGraph: combinedGraph,
});
assert.equal(combinedCarry.status, 'checked');
assert.equal(combinedCarry.support, 'invalidated');
assert.deepEqual(combinedCarry.changes, ['corpus', 'question', 'scope', 'sources']);

const staleGraph = structuredClone(baseQuery);
staleGraph.nodes.find((node) => node.id === 'r').concept = 'approve-01';
assert.throws(
  () =>
    checkFrameCarry({
      origin: sameQuestion,
      receiving: otherQuestion,
      opening,
      action: 'revise-question',
      rationale: 'A stale graph must not justify a checked carry.',
      originGraph: staleGraph,
      receivingGraph: otherReceivingGraph,
    }),
  /does not match/u,
);

const sourceGraph = {
  ...baseQuery,
  nodes: baseQuery.nodes.map((node) => ({ ...node, id: `s-${node.id}` })),
  edges: baseQuery.edges.map((edge) => ({
    ...edge,
    from: `s-${edge.from}`,
    to: `s-${edge.to}`,
  })),
  top: 's-r',
  assertionTop: 's-r',
};
const sourceFrame = frame({
  projectRevision: 'project-r13',
  questionRevision: graphRevision(sourceGraph),
});
const sourceReceiving = frame({
  projectRevision: 'project-r14',
  question: 'Which approval relation applies?',
  questionRevision: graphRevision(otherReceivingGraph),
});
const wrongSide = checkFrameCarry({
  origin: sourceFrame,
  receiving: sourceReceiving,
  opening: { ...opening, kind: 'source-edge', edge: sourceGraph.edges[2] },
  action: 'revise-question',
  rationale: 'Check a source-side opening against its source graph.',
  originGraph: baseQuery,
  originGraphRole: 'source',
  receivingGraph: otherReceivingGraph,
});
assert.notEqual(wrongSide.status, 'checked');

console.log(
  'ok inquiry frames: revisioned identity, purpose-only provenance, unacquired pending state, corpus/case invalidation, candidate-only mappings, ambiguous identity and source opening provenance',
);
