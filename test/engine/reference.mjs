/** A pronoun the question's reading left unresolved refers to something the
 * question names, never to a co-argument, and only when that is unambiguous. */
import assert from 'node:assert/strict';
import { referenceReading, settleReference } from '../../src/engine/answer.mjs';
import { evaluateAnswer } from '../../src/recording/answers.mjs';

const graph = (id, top, nodes, edges) => ({
  id,
  top,
  nodes: Object.entries(nodes).map(([id, concept]) => ({ id, concept })),
  edges: edges.map(([from, role, to], i) => ({ id: `e${i}`, from, role, to })),
});
// “Does inspecting a seal break it?”
const question = graph(
  'q',
  'b',
  { b: 'break-01', i: 'inspect-01', s: 'seal', p: 'it', u: 'amr-unknown' },
  [
    ['b', ':ARG0', 'i'],
    ['i', ':ARG1', 's'],
    ['b', ':ARG1', 'p'],
    ['b', ':polarity', 'u'],
  ],
);
const reading = referenceReading(question);
assert.equal(reading.antecedent, 'seal');
assert(
  reading.graph.edges.some((edge) => edge.from === 'b' && edge.role === ':ARG1' && edge.to === 's'),
);
assert(!reading.graph.nodes.some((node) => node.concept === 'it'));

// “Does the clerk file it?”: the only entity is a co-argument, so no reading.
const coArgument = graph('q2', 'f', { f: 'file-01', c: 'clerk', p: 'it', u: 'amr-unknown' }, [
  ['f', ':ARG0', 'c'],
  ['f', ':ARG1', 'p'],
  ['f', ':polarity', 'u'],
]);
assert.equal(referenceReading(coArgument), null);
// Two candidate entities: ambiguous, so no reading.
const two = structuredClone(question);
two.nodes.push({ id: 'd', concept: 'door' });
two.edges.push({ id: 'e9', from: 'i', role: ':location', to: 'd' });
assert.equal(referenceReading(two), null);

// The source says the seal is not broken by inspecting it.
const source = graph('s', 'b', { b: 'break-01', i: 'inspect-01', s: 'seal', n: '-' }, [
  ['b', ':ARG0', 'i'],
  ['i', ':ARG1', 's'],
  ['b', ':ARG1', 's'],
  ['b', ':polarity', 'n'],
]);
const recording = (q) => ({
  inquiry: { text: 'Does inspecting a seal break it?', graphId: q.id },
  project: { placementId: 'root' },
  graphs: [q, source],
  sources: [
    { id: 's0', nodeId: 'root', text: 'Inspecting a seal does not break it.', graphId: 's' },
  ],
});
const plain = evaluateAnswer(recording(question), {});
assert.equal(plain.status, 'open', 'The unresolved pronoun alone does not match');
const settled = settleReference(recording(question), {}, undefined, plain);
assert.equal(settled.answers[0].text, 'No');
assert.deepEqual(settled.answers[0].reference, { pronoun: 'it', antecedent: 'seal' });
assert.equal(settled.answers[0].readAs, 'reference');
assert.equal(
  settleReference(recording(coArgument), {}, undefined, evaluateAnswer(recording(coArgument), {})),
  null,
);
console.log(
  'ok a question pronoun reads as the one entity the question names, never a co-argument',
);
