/** Facts as integer columns read back as the objects they were made from,
 * field for field and in key order: proofs and alternatives, premises on later
 * facts, derivations, ids that are not their triple's key, unknown fields. */
import assert from 'node:assert/strict';
import { FactStore } from '../../src/amr/fact-store.mjs';
import { inferRelations } from '../../src/amr/inference.mjs';

const key = (triple) => JSON.stringify(triple);
const facts = [
  { triple: ['a', ':ARG0', 'b'], sourceIds: ['s1'], fragmentIds: ['s1/clause/z0'], guards: [] },
  { triple: ['a', ':instance', 'go-01'], sourceIds: ['s1'], id: key(['a', ':instance', 'go-01']) },
  {
    triple: ['b', ':instance', 'person'],
    sourceIds: ['s2'],
    bindingIds: ['bind-1'],
    id: 'b-person',
  },
  {
    id: key(['a', ':way', 'c']),
    triple: ['a', ':way', 'c'],
    ruleId: 'reach',
    premises: [key(['a', ':ARG0', 'b']), key(['c', ':ARG1', 'a'])],
    derivation: { corpus: 0, plan: 1, tree: { rule: 2, terminals: [], children: [] } },
    sourceIds: ['rules'],
    alternatives: [
      { sourceIds: ['s3'], fragmentIds: ['s3/clause/z1'], guards: ['["a",":polarity","-"]'] },
      { ruleId: 'step', premises: [key(['a', ':ARG0', 'b'])], sourceIds: ['rules'] },
    ],
    note: { kept: true },
  },
  // A premise may come after the fact it supports.
  { triple: ['c', ':ARG1', 'a'], sourceIds: ['s4'], id: key(['c', ':ARG1', 'a']) },
];
const store = FactStore.from(facts);
assert.equal(store.length, facts.length);
assert.equal(JSON.stringify(store.facts()), JSON.stringify(facts), 'Read back field for field');
assert.equal(store.position('b-person'), 2, 'An id that is not its triple key is kept');
assert.equal(store.proofs(3).length, 3, 'Its own proof, then its alternatives in order');

const inputs = [
  { triple: ['east', ':door', 'west'], sourceIds: ['notes'] },
  { triple: ['west', ':door', 'east'], sourceIds: ['notes'] },
  { triple: ['hall', ':door', 'gate'], sourceIds: ['plan'] },
  { triple: ['hall', ':path', 'gate'], sourceIds: ['survey'] },
];
const rules = [
  {
    id: 'step',
    name: 'A door is a way',
    when: [['?a', ':door', '?b']],
    then: [['?a', ':way', '?b']],
  },
  {
    id: 'path',
    name: 'A path is a way',
    when: [['?a', ':path', '?b']],
    then: [['?a', ':way', '?b']],
  },
  {
    id: 'reach',
    name: 'Ways compose',
    when: [
      ['?a', ':way', '?b'],
      ['?b', ':way', '?c'],
    ],
    then: [['?a', ':way', '?c']],
  },
];
const inferred = inferRelations(inputs, rules).facts;
assert(
  inferred.some((fact) => fact.alternatives?.length),
  'The cycle gives alternative proofs',
);
assert.equal(JSON.stringify(FactStore.from(inferred).facts()), JSON.stringify(inferred));
const { columns } = FactStore.from(inferred).bytes;
assert(columns / inferred.length < 200, 'Tens of bytes a fact, not kilobytes');
console.log(
  'ok fact store: facts as integer columns read back exactly, with proofs, alternatives, premises on later facts and derivations',
);
