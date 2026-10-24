/** A kind statement extends every node its subject's description fits, one
 * way, and only when the reading agrees with the sentence; negated, named and
 * asked statements extend nothing. */
import assert from 'node:assert/strict';
import { kindReading } from '../../src/amr/kinds.mjs';
import { evaluateAnswer } from '../../src/recording/answers.mjs';

const graph = (id, top, nodes, edges) => ({
  id,
  top,
  nodes: Object.entries(nodes).map(([id, concept]) => ({ id, concept })),
  edges: edges.map(([from, role, to], i) => ({ id: `e${i}`, from, role, to })),
});
// “The crew brings a tool to the shared work.”
const statement = graph(
  'statement',
  'b',
  { b: 'bring-01', c: 'crew', t: 'tool', w: 'work-01', h: 'share-01' },
  [
    ['b', ':ARG0', 'c'],
    ['b', ':ARG1', 't'],
    ['b', ':ARG2', 'w'],
    ['h', ':ARG1', 'w'],
  ],
);
// “Shared work is a project.”, prepared: the subject :mod the claim.
const definition = graph('definition', 'p', { p: 'project', w: 'work-01', h: 'share-01' }, [
  ['w', ':mod', 'p'],
  ['h', ':ARG1', 'w'],
]);
// “A project is shared work.”
const reverse = graph('reverse', 'w', { p: 'project', w: 'work-01', h: 'share-01' }, [
  ['p', ':mod', 'w'],
  ['h', ':ARG1', 'w'],
]);
const question = graph(
  'question',
  'b',
  { b: 'bring-01', c: 'crew', u: 'amr-unknown', p: 'project' },
  [
    ['b', ':ARG0', 'c'],
    ['b', ':ARG1', 'u'],
    ['b', ':ARG2', 'p'],
  ],
);
const texts = {
  statement: 'The crew brings a tool to the shared work.',
  definition: 'Shared work is a project.',
  reverse: 'A project is shared work.',
};
const record = (sources, text = texts) => ({
  inquiry: { text: 'What does the crew bring to the project?', graphId: 'question' },
  project: { placementId: 'root' },
  graphs: [question, ...sources],
  sources: sources.map((g) => ({ id: g.id, graphId: g.id, nodeId: 'root', text: text[g.id] })),
});

const rule = kindReading(definition, texts.definition);
assert.deepEqual(rule.then, [
  ['?k1', ':instance', 'project'],
  ['?k1', '@semanticType', 'entity'],
]);
assert.equal(evaluateAnswer(record([statement])).status, 'open');
const composed = evaluateAnswer(record([statement, definition]));
assert.equal(composed.status, 'supported');
assert.equal(composed.answers[0].text, 'tool');
assert.deepEqual(
  [...composed.answers[0].sourceIds].sort(),
  ['definition', 'statement'],
  'The shared work is a project, so the tool is brought to the project',
);
assert.equal(
  evaluateAnswer(record([statement, reverse])).status,
  'open',
  'What is a project is shared work; the shared work is not thereby a project',
);

const modify = (g, fn) => {
  const copy = structuredClone(g);
  fn(copy);
  return copy;
};
const negated = modify(definition, (g) => {
  g.nodes.push({ id: 'n', concept: '-' });
  g.edges.push({ id: 'n', from: 'p', role: ':polarity', to: 'n' });
});
assert.equal(kindReading(negated, 'Shared work is not a project.'), null);
const named = modify(definition, (g) => {
  g.nodes.push({ id: 'm', concept: 'name' });
  g.edges.push({ id: 'm', from: 'w', role: ':name', to: 'm' });
});
assert.equal(kindReading(named, 'Shared work is a project.'), null, 'A named thing is no kind');
const asked = modify(definition, (g) => {
  g.nodes.find((n) => n.id === 'p').concept = 'amr-unknown';
});
assert.equal(kindReading(asked, 'What is shared work?'), null);
assert.equal(
  kindReading(definition, texts.reverse),
  null,
  'A reading that puts the subject after the copula disagrees with the sentence',
);
assert.equal(
  evaluateAnswer(record([statement, definition], { ...texts, definition: texts.reverse })).status,
  'open',
);
console.log(
  'ok kinds: a kind statement extends the nodes its subject fits, one way, when its reading agrees with the sentence; negated, named and asked statements extend nothing',
);
