/** A base without some sources, read from its proofs, answers as a check
 * without those sources does: a conclusion with another proof still holds,
 * one without any does not. */
import assert from 'node:assert/strict';
import {
  answerBase,
  evaluateAnswer,
  factIndex,
  withheldBase,
} from '../../src/recording/answers.mjs';

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
// Two kind statements make the same work a project: “Shared work is a
// project.” and “Work is a project.”
const shared = graph('shared', 'p', { p: 'project', w: 'work-01', h: 'share-01' }, [
  ['w', ':mod', 'p'],
  ['h', ':ARG1', 'w'],
]);
const any = graph('any', 'p', { p: 'project', w: 'work-01' }, [['w', ':mod', 'p']]);
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
  shared: 'Shared work is a project.',
  any: 'Work is a project.',
};
const record = (sources) => ({
  inquiry: { text: 'What does the crew bring to the project?', graphId: 'question' },
  project: { placementId: 'root' },
  graphs: [question, ...sources],
  sources: sources.map((g) => ({ id: g.id, graphId: g.id, nodeId: 'root', text: texts[g.id] })),
});
const all = [statement, shared, any];
const recording = record(all);
const knowledge = {};
const base = answerBase(recording, knowledge);
const view = (answer) => [answer.status, answer.answers.map((a) => a.text)];
assert.deepEqual(view(evaluateAnswer(recording, knowledge, { base })), ['supported', ['tool']]);
for (const withheld of [['shared'], ['any'], ['shared', 'any'], ['statement']]) {
  const without = withheldBase(base, withheld);
  const read = evaluateAnswer(recording, knowledge, { base: without });
  const checked = evaluateAnswer(record(all.filter((g) => !withheld.includes(g.id))), knowledge);
  assert.deepEqual(view(read), view(checked), `Withholding ${withheld} reads as it checks`);
}
// A view's index reads its parent's positions, as an index of its own facts
// would: every lookup by every term, with some facts replaced by fewer proofs.
const lookups = (facts) => {
  const index = factIndex(facts);
  const keys = new Set(
    facts.flatMap((fact) => [
      fact.id,
      ...fact.triple,
      ...(fact.sourceIds ?? []),
      ...(fact.fragmentIds ?? []),
    ]),
  );
  return JSON.stringify(
    [...keys].map((key) => [
      index.of(key),
      index.touching(key),
      index.from(key),
      index.instancesOf(key),
      index.inFragments([key]),
      index.byId(key) ?? null,
      index.withIds([key]),
      index.ofAny([key]),
    ]),
  );
};
assert.equal(
  lookups(base.inference.facts),
  lookups([...base.inference.facts]),
  "Inference's facts indexed from its store",
);
let replaced = 0;
for (const withheld of [['shared'], ['any'], ['statement']]) {
  const without = withheldBase(base, withheld);
  for (const facts of [without.inference.facts, without.material.facts])
    assert.equal(lookups(facts), lookups([...facts]), `The index of a view without ${withheld}`);
  replaced += without.inference.facts.filter((fact) => !base.inference.facts.includes(fact)).length;
}
assert(replaced > 0, 'Some facts keep fewer proofs in a view');
assert.deepEqual(
  view(evaluateAnswer(recording, knowledge, { base: withheldBase(base, ['shared']) })),
  ['conditional', ['tool']],
  'Another kind statement still makes the work a project; its sharing now qualifies the answer',
);
assert.equal(
  evaluateAnswer(recording, knowledge, { base: withheldBase(base, ['shared', 'any']) }).status,
  'open',
);
console.log(
  'ok withheld: a base without sources, read from its proofs, answers as a check without them',
);
