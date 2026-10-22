/** Narrow conditional semantics, independent of vocabulary or the requested answer. */
import assert from 'node:assert/strict';
import { conditionalReading } from '../../src/amr/conditions.mjs';
import { evaluateAnswer } from '../../src/recording/answers.mjs';
const graph = (id, top, nodes, edges) => ({
  id,
  top,
  nodes: Object.entries(nodes).map(([id, concept]) => ({ id, concept })),
  edges: edges.map(([from, role, to], i) => ({ id: `e${i}`, from, role, to })),
});
const policy = graph(
  'policy',
  'r',
  {
    r: 'recommend-01',
    h: 'handle-01',
    t: 'team',
    p: 'payment',
    x: 'ticket',
    c: 'concern-02',
    f: 'fail-01',
    o: 'pay-out-03',
    n: 'frequent-02',
  },
  [
    ['r', ':ARG1', 'h'],
    ['h', ':ARG0', 't'],
    ['t', ':mod', 'p'],
    ['h', ':ARG1', 'x'],
    ['r', ':condition', 'c'],
    ['c', ':ARG0', 'x'],
    ['c', ':ARG1', 'f'],
    ['f', ':ARG1', 'o'],
    ['n', ':ARG1', 'f'],
  ],
);
const evidence = graph(
  'evidence',
  'c',
  { c: 'concern-02', x: 'ticket', f: 'fail-01', o: 'pay-out-03', n: 'frequent-02' },
  [
    ['c', ':ARG0', 'x'],
    ['c', ':ARG1', 'f'],
    ['f', ':ARG1', 'o'],
    ['n', ':ARG1', 'f'],
  ],
);
const query = graph(
  'query',
  'r',
  { r: 'recommend-01', h: 'handle-01', t: 'team', p: 'amr-unknown', x: 'ticket' },
  [
    ['r', ':ARG1', 'h'],
    ['h', ':ARG0', 't'],
    ['t', ':mod', 'p'],
    ['h', ':ARG1', 'x'],
  ],
);
const record = (sources = [policy, evidence], q = query) => ({
  inquiry: { text: 'Who?', graphId: q.id },
  project: { placementId: 'root' },
  graphs: [q, ...sources],
  sources: sources.map((g) => ({
    id: g.id,
    graphId: g.id,
    nodeId: 'root',
    text: g.id === 'policy' ? 'Proposed conditional policy.' : 'Observed evidence.',
  })),
});
const result = evaluateAnswer(record());
assert.equal(result.status, 'supported');
assert.equal(result.answers[0].text, 'payment');
assert.deepEqual(result.answers[0].qualifications, []);
assert.deepEqual(new Set(result.answers[0].sourceIds), new Set(['policy', 'evidence']));
assert.equal(
  evaluateAnswer(record([policy])).status,
  'open',
  'A template cannot assert its own antecedent',
);
const modify = (g, fn) => {
  const copy = structuredClone(g);
  fn(copy);
  return copy;
};
const incomplete = modify(evidence, (g) => {
  g.nodes = g.nodes.filter((n) => n.id !== 'n');
  g.edges = g.edges.filter((e) => e.from !== 'n');
});
const explained = evaluateAnswer(record([policy, incomplete]));
assert.equal(explained.status, 'open');
assert.deepEqual(explained.answers, [], 'A missing premise never supplies an answer');
const gap = explained.openings.find((o) => o.kind === 'condition');
assert.equal(gap.from, 'frequent-02');
assert.equal(gap.role, ':ARG1');
assert.equal(gap.to, 'fail-01');
assert.deepEqual(new Set(gap.sourceIds), new Set(['policy', 'evidence']));
assert(gap.matches[0].derivation, 'The available part is recognized by the native HRG chart');
assert(!evaluateAnswer(record([policy])).openings.some((o) => o.kind === 'condition'));
const unrelated = modify(incomplete, (g) => {
  g.edges.find((edge) => edge.from === 'f').role = ':ARG2';
});
assert(!evaluateAnswer(record([policy, unrelated])).openings.some((o) => o.kind === 'condition'));
const renamedIncomplete = [policy, incomplete, query].map((g) =>
  modify(g, (copy) => {
    copy.nodes.forEach((n) => {
      if (n.concept === 'frequent-02') n.concept = 'visible-02';
      if (n.concept === 'pay-out-03') n.concept = 'simulation';
    });
  }),
);
assert.equal(
  evaluateAnswer(record(renamedIncomplete.slice(0, 2), renamedIncomplete[2])).openings.find(
    (o) => o.kind === 'condition',
  ).from,
  'visible-02',
  'Condition explanations do not depend on domain vocabulary',
);
for (const changed of [
  modify(evidence, (g) => (g.nodes.find((n) => n.id === 'o').concept = 'log-on-02')),
  modify(evidence, (g) => (g.edges = g.edges.filter((e) => e.from !== 'n'))),
  modify(evidence, (g) => {
    g.nodes.push({ id: 'neg', concept: '-' });
    g.edges.push({ id: 'neg', from: 'c', role: ':polarity', to: 'neg' });
  }),
  modify(evidence, (g) => {
    g.nodes.push({ id: 'possible', concept: 'possible-01' });
    g.edges.push({ id: 'possible', from: 'possible', role: ':ARG1', to: 'c' });
    g.top = 'possible';
  }),
])
  assert.equal(
    evaluateAnswer(record([policy, changed])).status,
    'open',
    'Condition must be asserted with the same restrictions',
  );
assert.equal(
  evaluateAnswer(
    record(
      [policy, evidence],
      modify(query, (g) => (g.nodes[0].concept = 'possible-01')),
    ),
  ).status,
  'open',
);
const malformed = modify(policy, (g) =>
  g.edges.push({ id: 'wrong', from: 'h', role: ':ARG0', to: 'c' }),
);
assert(conditionalReading(malformed).reason);
assert.equal(evaluateAnswer(record([malformed, evidence])).status, 'open');
const conjunction = modify(policy, (g) => {
  g.nodes.push({ id: 'and', concept: 'and' }, { id: 'check', concept: 'check-01' });
  g.edges.find((e) => e.role === ':condition').to = 'and';
  g.edges.push(
    { id: 'op1', from: 'and', role: ':op1', to: 'c' },
    { id: 'op2', from: 'and', role: ':op2', to: 'check' },
    { id: 'arg', from: 'check', role: ':ARG1', to: 'x' },
  );
});
assert(conditionalReading(conjunction).when);
assert.equal(
  evaluateAnswer(record([conjunction, evidence])).status,
  'open',
  'All conjuncts must be asserted',
);
assert(
  conditionalReading(
    modify(conjunction, (g) => (g.nodes.find((n) => n.id === 'check').concept = 'and')),
  ).reason,
  'Malformed nested conjunction cannot be dropped',
);
const negativePolicy = modify(policy, (g) => {
  g.nodes.push({ id: 'neg', concept: '-' });
  g.edges.push({ id: 'neg', from: 'r', role: ':polarity', to: 'neg' });
});
assert.equal(
  evaluateAnswer(record([negativePolicy, evidence])).status,
  'open',
  'A negative conclusion cannot supply a positive answer',
);
const negativeQuery = modify(query, (g) => {
  g.nodes.push({ id: 'neg', concept: '-' });
  g.edges.push({ id: 'neg', from: 'r', role: ':polarity', to: 'neg' });
});
assert.equal(
  evaluateAnswer(record([negativePolicy, evidence], negativeQuery)).status,
  'open',
  'Negated policies remain unsupported, without dropping their negation',
);
// AMR may reify the same policy as have-condition-91 :ARG1 conclusion :ARG2 condition.
const reified = modify(policy, (g) => {
  g.nodes.push({ id: 'w', concept: 'have-condition-91' });
  g.edges = g.edges.filter((e) => e.role !== ':condition');
  g.edges.push(
    { id: 'conclusion', from: 'w', role: ':ARG1', to: 'r' },
    { id: 'condition', from: 'w', role: ':ARG2', to: 'c' },
  );
  g.top = 'w';
});
const reifiedResult = evaluateAnswer(record([reified, evidence]));
assert.equal(reifiedResult.status, 'supported', 'A reified condition reads like :condition');
assert.equal(reifiedResult.answers[0].text, 'payment');
assert.deepEqual(new Set(reifiedResult.answers[0].sourceIds), new Set(['policy', 'evidence']));
assert.equal(
  evaluateAnswer(record([reified])).status,
  'open',
  'A reified template cannot assert its own antecedent or conclusion',
);
const reifiedExtra = modify(reified, (g) => {
  g.nodes.push({ id: 'neg', concept: '-' });
  g.edges.push({ id: 'neg', from: 'w', role: ':polarity', to: 'neg' });
});
assert(conditionalReading(reifiedExtra).reason, 'Other roles on the reification are not dropped');
assert.equal(evaluateAnswer(record([reifiedExtra, evidence])).status, 'open');
console.log(
  'ok explicit AMR conditions retain shared participants, assertion, conjunction, negation, modality, reified form and exact policy qualification',
);
