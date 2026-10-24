/** One modal word read two ways, and one word in two concept forms, are read as
 * in the source and cited; other modals and other words settle nothing. */
import assert from 'node:assert/strict';
import { settleModalWord, settleWordForm } from '../../src/engine/answer.mjs';
import { evaluateAnswer } from '../../src/recording/answers.mjs';
import { readingNote } from '../../src/recording/answer-output.mjs';
import { unopened } from '../../src/amr/labels.mjs';

const graph = (id, top, nodes, edges) => ({
  id,
  top,
  nodes: Object.entries(nodes).map(([id, concept]) => ({ id, concept })),
  edges: edges.map(([from, role, to], i) => ({ id: `e${i}`, from, role, to })),
});
const recording = (question, text, sources) => ({
  inquiry: { text, graphId: question.id },
  project: { placementId: 'root' },
  graphs: [question, ...sources.map(([graph]) => graph)],
  sources: sources.map(([graph, sourceText]) => ({
    id: graph.id,
    nodeId: 'root',
    text: sourceText,
    graphId: graph.id,
  })),
});
const settle = (settler, record) => settler(record, {}, undefined, evaluateAnswer(record, {}));

// “A crew may leave the hall.” is possibility; “May a crew leave the hall?” permission.
const leaving = (id, modal) =>
  graph(id, 'm', { m: modal, l: 'leave-11', c: 'crew', h: 'hall' }, [
    ['m', ':ARG1', 'l'],
    ['l', ':ARG0', 'c'],
    ['l', ':ARG1', 'h'],
  ]);
const asked = (modal) => {
  const question = leaving('q', modal);
  question.nodes.push({ id: 'u', concept: 'amr-unknown' });
  question.edges.push({ id: 'eu', from: 'm', role: ':polarity', to: 'u' });
  return question;
};
const may = recording(asked('permit-01'), 'May a crew leave the hall?', [
  [leaving('s', 'possible-01'), 'A crew may leave the hall.'],
]);
assert.equal(evaluateAnswer(may, {}).status, 'open', 'Permission is not possibility as read');
const settled = settle(settleModalWord, may);
assert.equal(settled.answers[0].text, 'Yes');
assert.equal(settled.answers[0].readAs, 'modal-word');
assert.equal(
  readingNote(settled.answers[0]),
  'The question and the source both say “may”; read as in the source.',
);
assert.equal(
  settle(
    settleModalWord,
    recording(asked('obligate-01'), 'Must a crew leave the hall?', [
      [leaving('s', 'possible-01'), 'A crew may leave the hall.'],
    ]),
  ),
  null,
  '“Must” never answers “may”',
);
assert.equal(
  settle(
    settleModalWord,
    recording(asked('permit-01'), 'May a crew leave the hall?', [
      [leaving('s', 'possible-01'), 'A crew is able to leave the hall.'],
    ]),
  ),
  null,
  'A source that does not say the word answers nothing',
);

// “A rollback is a new act.” reads rollback as a noun; the question, as roll-back-02.
const act = (id, rollback) =>
  graph(id, 'a', { a: 'act', n: 'new-01', r: rollback }, [
    ['n', ':ARG1', 'a'],
    ['r', ':mod', 'a'],
  ]);
const rollbackQuestion = act('q', 'roll-back-02');
rollbackQuestion.nodes.push({ id: 'u', concept: 'amr-unknown' });
rollbackQuestion.edges.push({ id: 'eu', from: 'a', role: ':polarity', to: 'u' });
const form = recording(rollbackQuestion, 'Is a rollback a new act?', [
  [act('s', 'rollback'), 'A rollback is a new act.'],
]);
assert.equal(evaluateAnswer(form, {}).status, 'open');
const read = settle(settleWordForm, form);
assert.equal(read.answers[0].text, 'Yes');
assert.deepEqual(read.answers[0].wordForms, [{ asked: 'roll-back-02', read: 'rollback' }]);
assert.equal(
  readingNote(read.answers[0]),
  "The question's “roll back” is read as the source's “rollback”.",
);
// The same word in another sense is read in the source's sense.
const sense = structuredClone(form);
sense.graphs[1].nodes.find((node) => node.id === 'r').concept = 'roll-back-01';
assert.equal(
  readingNote(settle(settleWordForm, sense).answers[0]),
  "The question's “roll back” is read in the source's sense.",
);
const otherWord = structuredClone(form);
otherWord.graphs[0].nodes.find((node) => node.id === 'r').concept = 'retreat-01';
assert.equal(settle(settleWordForm, otherWord), null, 'Another word is not a form of this one');
// A sentence's opening capital is not the word's; an acronym keeps its capitals.
assert.equal(
  unopened('Customer service', 0, 'Customer service manages returns.'),
  'customer service',
);
assert.equal(unopened('AI', 0, 'AI may propose a change.'), 'AI');
assert.equal(unopened('Tendora', 4, 'Ask Tendora.'), 'Tendora', 'Only the opening word');
console.log(
  'ok readings: one modal word read as in the source, one word in two forms; other modals and words settle nothing',
);
