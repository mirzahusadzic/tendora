/** One modal word read two ways is read as in the source and cited; other
 * modals settle nothing. A word in two concept forms is no longer read in by
 * the engine (test/engine/settlement.mjs); an answer recorded that way still
 * shows how it was read. */
import assert from 'node:assert/strict';
import { settleModalWord } from '../../src/engine/answer.mjs';
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

assert.equal(
  settle(
    settleModalWord,
    recording(asked('possible-01'), 'Can a crew leave the hall?', [
      [leaving('s', 'permit-01'), 'A crew may leave the hall.'],
    ]),
  ),
  null,
  '“Can” never answers “may”',
);
// Two modal words: which modal the source's reading settles is not known, so
// none is rewritten. “May a crew that can swim leave the hall?”
const swimming = (id, modal) => {
  const g = leaving(id, modal);
  g.nodes.push({ id: 'k', concept: 'capable-01' }, { id: 'w', concept: 'swim-01' });
  g.edges.push(
    { id: 'ek', from: 'k', role: ':ARG1', to: 'w' },
    { id: 'ew', from: 'w', role: ':ARG0', to: 'c' },
  );
  return g;
};
const twoModals = swimming('q', 'permit-01');
twoModals.nodes.push({ id: 'u', concept: 'amr-unknown' });
twoModals.edges.push({ id: 'eu', from: 'm', role: ':polarity', to: 'u' });
assert.equal(
  settle(
    settleModalWord,
    recording(twoModals, 'May a crew that can swim leave the hall?', [
      [swimming('s', 'possible-01'), 'A crew that can swim may leave the hall.'],
    ]),
  ),
  null,
  'A question with two modal words settles none',
);

// An answer recorded through a word's other form, before the engine stopped
// reading questions that way, still says how it was read.
assert.equal(
  readingNote({ readAs: 'word-form', wordForms: [{ asked: 'roll-back-02', read: 'rollback' }] }),
  "The question's “roll back” is read as the source's “rollback”.",
);
assert.equal(
  readingNote({
    readAs: 'word-form',
    wordForms: [{ asked: 'roll-back-02', read: 'roll-back-01' }],
  }),
  "The question's “roll back” is read in the source's sense.",
);
// A sentence's opening capital is not the word's; an acronym keeps its capitals.
assert.equal(
  unopened('Customer service', 0, 'Customer service manages returns.'),
  'customer service',
);
assert.equal(unopened('AI', 0, 'AI may propose a change.'), 'AI');
assert.equal(unopened('Tendora', 4, 'Ask Tendora.'), 'Tendora', 'Only the opening word');
console.log(
  'ok readings: one modal word read as in the source; other modals settle nothing; recorded word-form answers still say how they were read',
);
