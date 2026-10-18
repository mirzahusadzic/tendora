/** Clause proofs preserve scope, ports, occurrence identity and negative controls. */
import assert from 'node:assert/strict';
import { clauseFragments } from '../../src/amr/clause-fragments.mjs';
import { answerMaterial, evaluateAnswer } from '../../src/recording/answers.mjs';
import { inferRelations, matchRelations } from '../../src/amr/inference.mjs';
import { inquiryPattern, normalizeCoordinatedUnknowns } from '../../src/amr/patterns.mjs';
import { graphRevision } from '../../src/recording/revisions.mjs';

const graph = (id, top, nodes, edges) => ({
  id,
  top,
  nodes: Object.entries(nodes).map(([id, concept]) => ({ id, concept })),
  edges: edges.map(([from, role, to], index) => ({ id: `e${index}`, from, role, to })),
});
const source = graph(
  's',
  'and',
  {
    and: 'and',
    r: 'rehearse-01',
    s: 'simulate-01',
    p: 'possible-01',
    v: 'prove-01',
    c: 'cause-01',
    neg: '-',
  },
  [
    ['and', ':op1', 'r'],
    ['and', ':op2', 'v'],
    ['r', ':ARG0', 's'],
    ['r', ':ARG1', 'p'],
    ['v', ':ARG0', 's'],
    ['v', ':ARG1', 'c'],
    ['v', ':polarity', 'neg'],
  ],
);
const question = graph('q', 'r', { r: 'rehearse-01', s: 'amr-unknown', p: 'possible-01' }, [
  ['r', ':ARG0', 's'],
  ['r', ':ARG1', 'p'],
]);
const negativeQuestion = graph('q', 'v', { v: 'prove-01', s: 'simulate-01', c: 'cause-01' }, [
  ['v', ':ARG0', 's'],
  ['v', ':ARG1', 'c'],
]);
const record = (sources = [source], query = question) => ({
  inquiry: { text: 'Frozen question', graphId: 'q' },
  project: { placementId: 'root' },
  graphs: [query, ...sources],
  sources: sources.map((graph) => ({
    id: graph.id,
    graphId: graph.id,
    text: 'Frozen ' + graph.id,
    nodeId: 'root',
  })),
});
const edit = (value, fn) => {
  const copy = structuredClone(value);
  fn(copy);
  return copy;
};
const fragments = clauseFragments(source);
assert.equal(fragments.fragments.length, 3);
assert.deepEqual(
  new Set(fragments.fragments.flatMap((item) => item.graph.edges.map((edge) => edge.id))),
  new Set(source.edges.map((edge) => edge.id)),
);
assert(
  fragments.fragments
    .find((item) => item.root === 'r')
    .ports.some((port) => port.nodeId === 's' && port.fragments.includes('v')),
);
const result = evaluateAnswer(record());
assert.equal(result.status, 'supported', 'An unrelated negative clause does not negate rehearsal');
assert.equal(result.answers[0].text, 'simulate-01');
assert.deepEqual(result.answers[0].sourceIds, ['s']);
assert(result.answers[0].ruleIds.includes('s/clause/r/project-v1'));
assert(result.answers[0].fragmentIds.includes('s/clause/r'));
assert(!result.answers[0].facts.some((fact) => fact.triple[1] === ':polarity'));
for (const concept of ['possible-01', 'say-01']) {
  const embedded = edit(source, (graph) => {
    graph.nodes.push({ id: 'context', concept });
    graph.edges.find((edge) => edge.from === 'and' && edge.to === 'v').to = 'context';
    graph.edges.push({ id: 'context-edge', from: 'context', role: ':ARG1', to: 'v' });
  });
  const scoped = evaluateAnswer(record([embedded]));
  assert.equal(
    scoped.status,
    'supported',
    'Shared participants do not import a sibling’s embedded negative context',
  );
  assert(!scoped.answers[0].facts.some((fact) => fact.triple[1] === ':polarity'));
  assert.equal(
    evaluateAnswer(record([embedded], negativeQuestion)).status,
    'open',
    'Embedded negative content is not independently asserted',
  );
}
assert.equal(
  evaluateAnswer(record([source], negativeQuestion)).answers[0].text,
  'No',
  'Projected polarity survives derivation',
);
assert.equal(
  evaluateAnswer(
    record(
      [source],
      edit(negativeQuestion, (q) => {
        q.nodes.find((node) => node.id === 's').concept = 'amr-unknown';
      }),
    ),
  ).status,
  'open',
  'A negative clause cannot yield a positive participant answer',
);
const material = answerMaterial(record());
const direct = {
  ...structuredClone(fragments.fragments.find((fragment) => fragment.root === 'r').graph),
  id: 'direct',
};
const eventBinding = {
  id: 'same-rehearsal',
  name: 'Same rehearsal',
  attribution: 'Explicit occurrence reference',
  scopePlacementId: 'root',
  references: [source, direct].map((graph) => ({
    text: 'Frozen ' + graph.id,
    nodeId: 'root',
    sourceNodeId: 'r',
    graphRevision: graphRevision(graph),
  })),
};
assert.equal(
  answerMaterial(record([source, direct]), { bindings: [eventBinding] }).bindings.length,
  1,
  'Unrelated sentence polarity does not block an explicitly identified positive event',
);
const noProjection = inferRelations(
  material.facts,
  material.rules.filter((rule) => rule.kind !== 'clause-projection'),
);
assert.equal(
  matchRelations(inquiryPattern(question).patterns, noProjection.facts).matches.length,
  0,
  'Ablating composition retracts the answer',
);

for (const operator of ['or', 'possible-01', 'recommend-01', 'say-01']) {
  const wrapped = edit(source, (g) => {
    g.nodes.find((node) => node.id === 'and').concept = operator;
  });
  assert.equal(
    evaluateAnswer(record([wrapped])).status,
    'open',
    operator + ' does not assert its arguments',
  );
}
for (const role of [':polarity', ':condition', ':concession', ':time']) {
  const guarded = edit(source, (g) => {
    g.nodes.push({ id: 'guard', concept: role === ':polarity' ? '-' : 'condition' });
    g.edges.push({ id: 'guard', from: 'and', role, to: 'guard' });
  });
  assert.equal(
    evaluateAnswer(record([guarded])).status,
    'open',
    'Connector scope cannot be dropped: ' + role,
  );
}
assert.equal(
  evaluateAnswer(
    record([
      edit(source, (g) => {
        g.edges.find((edge) => edge.from === 'r' && edge.role === ':ARG0').role = ':ARG2';
      }),
    ]),
  ).status,
  'open',
);
assert.equal(evaluateAnswer(record([])).status, 'open');
const unconstrained = evaluateAnswer(record([source], graph('q', 'u', { u: 'amr-unknown' }, [])));
assert.equal(unconstrained.status, 'open');
assert(unconstrained.openings.some((opening) => opening.kind === 'question'));
assert.equal(
  evaluateAnswer(
    record([
      edit(source, (g) => {
        g.nodes.reverse();
        g.edges.reverse();
      }),
    ]),
  ).status,
  'supported',
);

const reentrant = graph('s', 'p', { p: 'protect-01', t: 'person' }, [
  ['p', ':ARG0', 't'],
  ['p', ':ARG1', 't'],
]);
const separate = graph('q', 'p', { p: 'protect-01', t: 'amr-unknown', x: 'person' }, [
  ['p', ':ARG0', 't'],
  ['p', ':ARG1', 'x'],
]);
assert.equal(
  evaluateAnswer(record([reentrant], separate)).status,
  'open',
  'Two independent query participants cannot collapse into one',
);
const sharedQuery = graph('q', 'p', { p: 'protect-01', t: 'amr-unknown' }, [
  ['p', ':ARG0', 't'],
  ['p', ':ARG1', 't'],
]);
assert.equal(evaluateAnswer(record([reentrant], sharedQuery)).answers[0].text, 'person');
const halfA = graph('a', 'p', { p: 'protect-01', t: 'person' }, [['p', ':ARG0', 't']]);
const halfB = graph('b', 'p', { p: 'protect-01', t: 'person' }, [['p', ':ARG1', 't']]);
assert.equal(
  evaluateAnswer(record([halfA, halfB], sharedQuery)).status,
  'open',
  'Repeated labels in independent occurrences do not join',
);

const coordinated = graph(
  'q',
  'c',
  { c: 'and', p: 'possible-01', a: 'authorize-01', k: 'keep-01', u: 'amr-unknown' },
  [
    ['c', ':op1', 'p'],
    ['c', ':op2', 'k'],
    ['p', ':ARG1', 'a'],
    ['a', ':ARG0', 'u'],
    ['k', ':ARG0', 'u'],
  ],
);
const authorizer = graph(
  'authorization',
  'p',
  { p: 'possible-01', a: 'authorize-01', u: 'person' },
  [
    ['p', ':ARG1', 'a'],
    ['a', ':ARG0', 'u'],
  ],
);
const keeper = graph('keeping', 'k', { k: 'keep-01', u: 'organization' }, [['k', ':ARG0', 'u']]);
const sharedParticipant = graph(
  'shared-participant',
  'c',
  { c: 'and', p: 'possible-01', a: 'authorize-01', k: 'keep-01', u: 'person' },
  [
    ['c', ':op1', 'p'],
    ['c', ':op2', 'k'],
    ['p', ':ARG1', 'a'],
    ['a', ':ARG0', 'u'],
    ['k', ':ARG0', 'u'],
  ],
);
const coordinatedText = 'Who may authorize use of the room, and who keeps its key?';
const singleText = 'Who may authorize use of the room?';
assert.equal(normalizeCoordinatedUnknowns(coordinated, singleText).graph, coordinated);
assert.notEqual(normalizeCoordinatedUnknowns(coordinated, coordinatedText).graph, coordinated);
const coordinatedRecord = record([authorizer, keeper], coordinated);
coordinatedRecord.inquiry.text = coordinatedText;
const coordinatedBefore = structuredClone(coordinatedRecord);
const splitAnswer = evaluateAnswer(coordinatedRecord, {}, { retainPartialCoverage: true });
assert.equal(splitAnswer.status, 'supported');
assert.deepEqual(
  splitAnswer.answers[0].bindings.map((binding) => binding.text),
  ['person', 'organization'],
);
assert.deepEqual(new Set(splitAnswer.answers[0].sourceIds), new Set(['authorization', 'keeping']));
assert.match(splitAnswer.queryNormalization, /independent branch slots/u);
assert.deepEqual(coordinatedRecord, coordinatedBefore, 'Neither query nor sources are mutated');
const sharedAnswer = evaluateAnswer(record([sharedParticipant], coordinated));
assert.equal(sharedAnswer.status, 'supported', 'The acquired shared reading wins when it resolves');
assert.equal(sharedAnswer.queryNormalization, undefined);
const polarityOnly = edit(coordinated, (graph) => {
  for (const edge of graph.edges.filter((edge) => edge.to === 'u')) edge.role = ':polarity';
});
assert.equal(normalizeCoordinatedUnknowns(polarityOnly, coordinatedText).graph, polarityOnly);
assert.equal(evaluateAnswer(record([])).status, 'open');
const duplicate = edit(source, (g) => {
  g.id = 'other';
});
const duplicates = evaluateAnswer(record([source, duplicate]));
assert.equal(
  duplicates.status,
  'ambiguous',
  'Independent same-label participants are not silently identified',
);
assert.equal(duplicates.candidates.length, 2);
assert(duplicates.candidates.every((answer) => answer.sourceIds.length === 1));
assert.equal(
  evaluateAnswer(record([duplicate])).status,
  'supported',
  'Independent remaining support survives source removal',
);
console.log(
  'ok scoped clause proofs, reconstruction, shared ports, polarity, modality, role changes, ablation, occurrence identity and source removal',
);
