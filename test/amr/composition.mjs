import assert from 'node:assert/strict';
import { searchCompositions } from '../../src/amr/composition.mjs';
import { inferRelations, traceRelations } from '../../src/amr/inference.mjs';
const run = (input) => {
  const iterator = searchCompositions(input);
  let step;
  do {
    step = iterator.next();
  } while (!step.done);
  return step.value;
};
const facts = [
  ['ticket-A', 'concerns', 'failure-A'],
  ['failure-A', 'frequency', '3'],
  ['ticket-B', 'concerns', 'failure-B'],
  ['failure-B', 'frequency', '1'],
  ['payment-team', 'covers', 'payout'],
  ['failure-A', 'type', 'payout'],
].map((triple) => ({ triple, sourceIds: [triple[0]] }));
const rules = [
  {
    id: 'frequency',
    name: 'Three counts as frequent in this test',
    when: [['?f', 'frequency', '3']],
    then: [['?f', 'frequent', 'true']],
  },
  {
    id: 'coverage',
    name: 'Coverage of a failure type',
    when: [
      ['?f', 'frequent', 'true'],
      ['?f', 'type', '?type'],
      ['?team', 'covers', '?type'],
    ],
    then: [['?f', 'handled-by', '?team']],
  },
  {
    id: 'policy',
    name: 'Recommend the covering team',
    when: [
      ['?ticket', 'concerns', '?f'],
      ['?f', 'handled-by', '?team'],
    ],
    then: [
      ['$recommendation', 'for-ticket', '?ticket'],
      ['$recommendation', 'team', '?team'],
    ],
  },
];
const goals = [
  ['?r', 'for-ticket', 'ticket-A'],
  ['?r', 'team', '?answer'],
];
const input = { facts, rules, goals };
const full = run(input);
assert(full.complete, JSON.stringify(full.stats));
assert(full.proofs.length);
assert(full.proofs.every((proof) => proof.bindings['?answer'] === 'payment-team'));
assert(
  full.proofs.some((proof) => new Set(proof.applications.map((app) => app.ruleId)).size === 3),
);
assert.equal(
  run({
    ...input,
    goals: [
      ['?r', 'for-ticket', 'ticket-B'],
      ['?r', 'team', '?answer'],
    ],
  }).proofs.length,
  0,
);
assert.equal(
  run({ ...input, rules: rules.filter((rule) => rule.id !== 'policy') }).proofs.length,
  0,
);
const limited = run({ ...input, limits: { maxStates: 2 } });
assert(!limited.complete);
assert(limited.frontier.length);
const resumed = run({ ...input, initial: limited });
assert(resumed.complete);
assert(resumed.proofs.length);
const capped = run({ ...input, limits: { maxChecks: 2 } });
assert(!capped.complete);
assert(capped.stats.checks <= 2);
const cycle = run({
  facts: [],
  goals: [['a', 'p', 'b']],
  rules: [{ id: 'self', when: [['?a', 'p', '?b']], then: [['?a', 'p', '?b']] }],
  limits: { maxStates: 100, maxDepth: 5 },
});
assert.equal(cycle.proofs.length, 0);
assert(cycle.complete);
assert(cycle.stats.cycleStops > 0);
const mutual = run({
  facts: [],
  goals: [['?a', 'p', 'b']],
  rules: [
    { id: 'p', when: [['?x', 'q', '?y']], then: [['?x', 'p', '?y']] },
    { id: 'q', when: [['?x', 'p', '?y']], then: [['?x', 'q', '?y']] },
  ],
});
assert(mutual.complete);
assert.equal(mutual.proofs.length, 0);
const alternate = run({
  ...input,
  facts: [...facts, { triple: ['another-team', 'covers', 'payout'], sourceIds: ['other'] }],
});
assert.deepEqual(
  new Set(alternate.proofs.map((proof) => proof.bindings['?answer'])),
  new Set(['payment-team', 'another-team']),
);

const independent = [
  {
    id: 'first',
    name: 'First witness',
    when: [['a', 'p', 'b']],
    then: [['a', 'answer', 'b']],
    sourceIds: ['policy-one'],
  },
  {
    id: 'second',
    name: 'Second witness',
    when: [['a', 'q', 'b']],
    then: [['a', 'answer', 'b']],
    sourceIds: ['policy-two'],
  },
];
const evidence = [
  { triple: ['a', 'p', 'b'], sourceIds: ['one'] },
  { triple: ['a', 'q', 'b'], sourceIds: ['two'] },
];
for (const inputs of [evidence, evidence.slice(1)]) {
  const inferred = inferRelations(inputs, independent),
    answer = inferred.facts.find((fact) => fact.triple[1] === 'answer');
  assert(inferred.complete);
  assert(answer);
  assert.equal(answer.alternatives?.length ?? 0, inputs.length - 1);
  assert.deepEqual(
    new Set(traceRelations(inferred.facts, [answer.id]).ruleIds),
    new Set(inputs.length === 2 ? ['first', 'second'] : ['second']),
  );
}
assert(!inferRelations([], independent).facts.some((fact) => fact.triple[1] === 'answer'));
// A derived node is named by what derived it, not by when: the same rules in
// another order derive the same facts under the same names.
const growing = [
  {
    id: 'kin',
    name: 'Each crew has a lead',
    when: [['?c', ':instance', 'crew']],
    then: [
      ['?c', ':lead', '$l'],
      ['$l', ':instance', 'person'],
    ],
  },
  {
    id: 'tool',
    name: 'Each person has a tool',
    when: [['?p', ':instance', 'person']],
    then: [
      ['?p', ':tool', '$t'],
      ['$t', ':instance', 'tool'],
    ],
  },
];
const crews = ['north', 'south'].map((crew) => ({
  triple: [crew, ':instance', 'crew'],
  sourceIds: [crew],
}));
const derivedTriples = (rules) =>
  inferRelations(crews, rules)
    .facts.map((fact) => JSON.stringify(fact.triple))
    .sort();
assert.deepEqual(derivedTriples(growing), derivedTriples([...growing].reverse()));
assert.deepEqual(
  derivedTriples(growing),
  inferRelations([...crews].reverse(), growing)
    .facts.map((fact) => JSON.stringify(fact.triple))
    .sort(),
  'Nor does the order of the premises name what is derived',
);
// Semi-naive rounds: a chain derives one link a round, and only the rule that
// reads the new link runs again; the rest found everything they could.
const chain = Array.from({ length: 8 }, (_, i) => ({
  id: `step-${i}`,
  name: `Step ${i}`,
  when: [['?x', `link-${i}`, '?y']],
  then: [['?x', `link-${i + 1}`, '?y']],
}));
const chained = inferRelations([{ triple: ['a', 'link-0', 'b'], sourceIds: ['seed'] }], chain);
assert(chained.facts.some((fact) => fact.triple[1] === 'link-8'));
assert.equal(chained.rounds, 9);
assert(
  chained.evaluations < 2 * chain.length,
  `Rules untouched by the last round are not matched again (${chained.evaluations} of ${chain.length * chained.rounds})`,
);
// A fact joins the base cohort without being new: X rests on P, which first
// has only a view's proof (so X is outside the base) and later gains an
// ordinary one. A view that reads X and an older fact, but not P, must still
// match once X is in the base, as evaluating every rule again would.
const rule = (id, from, to, extra = {}) => ({
  id,
  name: id,
  when: [['?a', from, '?b']],
  then: [['?a', to, '?b']],
  ...extra,
});
const joined = inferRelations(
  [
    { triple: ['k', 'cue', 'v'], sourceIds: ['cue'] },
    { triple: ['k', 'start', 'v'], sourceIds: ['start'] },
    { triple: ['v', 'kind', 'place'], sourceIds: ['kind'] },
  ],
  [
    rule('view-held', 'cue', 'held', { baseOnly: true }),
    rule('linked', 'held', 'linked'),
    rule('mid', 'start', 'mid'),
    rule('late', 'mid', 'late'),
    rule('held', 'late', 'held'),
    {
      id: 'view-answer',
      name: 'view-answer',
      when: [
        ['?a', 'linked', '?b'],
        ['?b', 'kind', 'place'],
      ],
      then: [['?a', 'answer', '?b']],
      baseOnly: true,
    },
  ],
);
assert(
  joined.facts.some((fact) => fact.triple[1] === 'answer'),
  'A fact that joins the base cohort seeds the views that read it',
);
const duplicate = { triple: ['a', 'same', 'b'], sourceIds: ['one'], bindingIds: ['binding-one'] };
const copies = inferRelations(
  [duplicate, duplicate, { ...duplicate, sourceIds: ['two'], bindingIds: ['binding-two'] }],
  [],
);
assert.equal(copies.facts.length, 1);
assert.equal(copies.facts[0].alternatives.length, 1);
assert.deepEqual(
  new Set(traceRelations(copies.facts, [copies.facts[0].id]).bindingIds),
  new Set(['binding-one', 'binding-two']),
);

// Equivalent triples may have different polarity guards; support is chosen
// per occurrence, including when a rule is traced through its own premises.
const shared = ['person', ':instance', 'person'],
  guard = ['event', ':polarity', 'minus'];
const guarded = { triple: shared, sourceIds: ['negative'], guards: [JSON.stringify(guard)] };
const unguarded = { triple: shared, sourceIds: ['positive'] };
const reading = {
  id: 'reading',
  name: 'Read a person',
  when: [shared],
  then: [['answer', '@label', 'person']],
};
for (const inputs of [
  [guarded, unguarded],
  [unguarded, guarded],
]) {
  const inference = inferRelations(inputs, [reading]);
  const answer = inference.facts.find((fact) => fact.triple[0] === 'answer');
  assert(answer);
  assert.deepEqual(traceRelations(inference.facts, [answer.id]).sourceIds, ['positive']);
  assert(run({ facts: inputs, rules: [], goals: [shared] }).proofs.length);
}
assert(!inferRelations([guarded], [reading]).facts.some((fact) => fact.triple[0] === 'answer'));
assert.equal(run({ facts: [guarded], rules: [], goals: [shared] }).proofs.length, 0);
const negativeReading = { ...reading, when: [shared, guard] };
const negativeInference = inferRelations(
  [guarded, { triple: guard, sourceIds: ['negative'] }],
  [negativeReading],
);
assert(negativeInference.facts.some((fact) => fact.triple[0] === 'answer'));
console.log(
  'ok bounded composition joins shared bindings, keeps competing answers, resumes and rejects circular support',
);
