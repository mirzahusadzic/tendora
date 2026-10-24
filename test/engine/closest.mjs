/** When nothing answers, the statements sharing the most of a question's content
 * concepts are named, rarer concepts weighing more; generic concepts never count. */
import assert from 'node:assert/strict';
import { closestStatements } from '../../src/engine/answer.mjs';

const graph = (id, nodes) => ({
  id,
  top: Object.keys(nodes)[0],
  nodes: Object.entries(nodes).map(([id, concept]) => ({ id, concept })),
  edges: [],
});
// “Who must archive a ledger after an audit?”
const question = graph('q', {
  o: 'obligate-01',
  a: 'archive-01',
  p: 'person',
  l: 'ledger',
  u: 'audit-01',
  w: 'amr-unknown',
});
const statements = [
  [
    's1',
    'A clerk archives the ledger after each audit.',
    { a: 'archive-01', c: 'clerk', l: 'ledger', u: 'audit-01' },
  ],
  ['s2', 'A ledger has pages.', { h: 'have-03', l: 'ledger', p: 'page' }],
  ['s3', 'A person keeps a ledger.', { k: 'keep-01', p: 'person', l: 'ledger' }],
  ['s4', 'An auditor reads reports.', { r: 'read-01', p: 'person', t: 'report' }],
];
const recording = {
  inquiry: { text: 'Who must archive a ledger after an audit?', graphId: 'q' },
  graphs: [question, ...statements.map(([id, , nodes]) => graph(id, nodes))],
  sources: statements.map(([id, text]) => ({ id, nodeId: 'root', text, graphId: id })),
};
const related = closestStatements(recording);
assert.deepEqual(
  related.map((item) => item.sourceId),
  ['s1', 's3', 's2'],
  'Most shared and rarest first; a tie goes to the more focused statement; person alone names nothing',
);
assert.deepEqual(related[0].shares, ['archive', 'audit', 'ledger']);
assert.deepEqual(related[1].shares, ['ledger'], 'person is generic and does not count');
assert(related[0].score > related[1].score);
assert.equal(closestStatements(recording, 1).length, 1);
// A development response is the author's own contribution, not a statement to point to.
recording.sources[0].development = { contributionId: 'c1' };
assert(!closestStatements(recording).some((item) => item.sourceId === 's1'));
console.log(
  'ok closest statements: shared content concepts, rarer first, generic concepts ignored',
);
