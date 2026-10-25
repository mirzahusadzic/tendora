/** Names in questions. A reading's :wiki link is the parser's guess at a real-world referent. A
 * question's guess is not something a source must also have made: "Jordan" in
 * a question linked to a famous Jordan still reads the corpus's Jordan. Names
 * keep their parts, so a different name stays different. */
import assert from 'node:assert/strict';
import { evaluateAnswer } from '../../src/recording/answers.mjs';

const graph = (id, top, nodes, edges) => ({
  id,
  top,
  nodes: Object.entries(nodes).map(([id, concept]) =>
    /^"|^-$/u.test(concept) ? { id, concept, literal: concept } : { id, concept },
  ),
  edges: edges.map(([from, role, to], i) => ({ id: `e${i}`, from, role, to })),
});
const person = (wiki, ...name) => ({
  nodes: {
    p: 'person',
    w: wiki,
    n: 'name',
    ...Object.fromEntries(name.map((part, i) => [`o${i}`, `"${part}"`])),
  },
  edges: [
    ['p', ':wiki', 'w'],
    ['p', ':name', 'n'],
    ...name.map((_, i) => ['n', `:op${i + 1}`, `o${i}`]),
  ],
});
// "Jordan, the database administrator, tests a backup." read without a link.
const jordan = person('-', 'Jordan');
const source = graph('s', 't', { t: 'test-01', b: 'backup', ...jordan.nodes }, [
  ['t', ':ARG0', 'p'],
  ['t', ':ARG1', 'b'],
  ...jordan.edges,
]);
const record = (query) => ({
  inquiry: { text: 'Question', graphId: query.id },
  project: { placementId: 'root' },
  graphs: [query, source],
  sources: [{ id: 's0', nodeId: 'root', text: 'Jordan tests a backup.', graphId: 's' }],
});
const asked = (who) =>
  graph('q', 't', { t: 'test-01', u: 'amr-unknown', ...who.nodes }, [
    ['t', ':ARG0', 'p'],
    ['t', ':ARG1', 'u'],
    ...who.edges,
  ]);

// "What does Jordan test?" linked to the basketball player.
const linked = evaluateAnswer(record(asked(person('"Michael_Jordan"', 'Jordan'))));
assert.equal(linked.status, 'supported', 'A question link is no requirement on the sources');
assert.deepEqual(
  linked.answers.map((answer) => answer.text),
  ['backup'],
);
// "What does Michael Jordan test?" names someone else: the name's parts differ.
const other = evaluateAnswer(record(asked(person('"Michael_Jordan"', 'Michael', 'Jordan'))));
assert.equal(other.status, 'open', 'A different name is not the corpus Jordan');

// "Jordan, the database administrator, tests a backup." asked "Does Jordan test a
// backup?": a participant the question names is identified; the source's
// appositive narrows nothing, so the answer is a plain Yes.
const titled = graph(
  's',
  't',
  { t: 'test-01', b: 'backup', a: 'administrate-01', d: 'database', ...jordan.nodes },
  [
    ['t', ':ARG0', 'p'],
    ['t', ':ARG1', 'b'],
    ['a', ':ARG0', 'p'],
    ['a', ':ARG1', 'd'],
    ...jordan.edges,
  ],
);
const yesNo = graph(
  'q',
  't',
  { t: 'test-01', u: 'amr-unknown', b: 'backup', ...person('-', 'Jordan').nodes },
  [
    ['t', ':polarity', 'u'],
    ['t', ':ARG0', 'p'],
    ['t', ':ARG1', 'b'],
    ...person('-', 'Jordan').edges,
  ],
);
const plain = evaluateAnswer({ ...record(yesNo), graphs: [yesNo, titled] });
assert.equal(plain.status, 'supported', "A named participant's description qualifies nothing");
assert.deepEqual(
  plain.answers.map((answer) => answer.text),
  ['Yes'],
);
// Described instead of named ("Does the administrator test a backup?"), what the
// source adds about the participant may narrow it, and stays a qualification.
const described = graph(
  'q',
  't',
  { t: 'test-01', u: 'amr-unknown', b: 'backup', p: 'person', a: 'administrate-01' },
  [
    ['t', ':polarity', 'u'],
    ['t', ':ARG0', 'p'],
    ['t', ':ARG1', 'b'],
    ['a', ':ARG0', 'p'],
  ],
);
assert.equal(
  evaluateAnswer({ ...record(described), graphs: [described, titled] }).status,
  'conditional',
);
// A Yes that holds under the source's clause says Yes, and names the clause.
const timed = graph(
  's',
  't',
  { t: 'test-01', b: 'backup', f: 'before', r: 'restore-02', ...jordan.nodes },
  [
    ['t', ':ARG0', 'p'],
    ['t', ':ARG1', 'b'],
    ['t', ':time', 'f'],
    ['f', ':op1', 'r'],
    ['r', ':ARG0', 'p'],
    ['r', ':ARG1', 'b'],
    ...jordan.edges,
  ],
);
const qualified = evaluateAnswer({ ...record(yesNo), graphs: [yesNo, timed] });
assert.equal(qualified.status, 'conditional');
assert.deepEqual(
  qualified.answers.map((answer) => [answer.text, answer.qualifications.length]),
  [['Yes', 1]],
  'The answer is Yes; its qualification stays beside it',
);
console.log(
  'ok question names: links ignored, names distinguish, a named participant is identified, a qualified Yes says Yes',
);
