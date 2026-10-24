/** Facts as integer columns read back as the objects they were made from,
 * field for field and in key order: proofs and alternatives, premises on later
 * facts, derivations, ids that are not their triple's key, unknown fields. */
import assert from 'node:assert/strict';
import { FactStore, storeOf, storePrefix } from '../../src/amr/fact-store.mjs';
import { inferRelations } from '../../src/amr/inference.mjs';
import { createGrammarMatcher } from '../../src/amr/hrg-query.mjs';
import { corpusSignature } from '../../src/amr/hrg-corpus.mjs';

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
const inference = inferRelations(inputs, rules);
const inferred = inference.facts;
// Inference writes its store as it derives: facts in their order, each later
// proof appended to the fact it proves.
assert.equal(
  JSON.stringify(inference.store.facts()),
  JSON.stringify(inferred),
  'Inference writes the store it returns',
);
assert(
  inferred.some((fact) => fact.alternatives?.length),
  'The cycle gives alternative proofs',
);
assert.equal(JSON.stringify(FactStore.from(inferred).facts()), JSON.stringify(inferred));
// The matcher reads a store's prefix from its columns, and its grammar groups
// a later prefix from the earlier one: the same signatures, matches and
// derivations as the same facts in a plain array.
const inferredStore = inference.store;
assert.equal(storeOf(inferred), inferredStore, 'Inference returns a prefix of its store');
assert.equal(storeOf([...inferred]), null, 'A copy is a plain array');
const prefix = storePrefix(inferred.slice(0, inputs.length), inferredStore);
assert.equal(corpusSignature(prefix), corpusSignature([...prefix]));
assert.equal(corpusSignature(inferred), corpusSignature([...inferred]), 'A later prefix');
const ways = [
  ['?a', ':door', '?b'],
  ['?a', ':way', '?b'],
];
const fromStore = createGrammarMatcher().match(ways, inferred, { limit: 1000 });
const fromArray = createGrammarMatcher().match(ways, [...inferred], { limit: 1000 });
assert(fromStore.matches.length > 1);
assert.equal(JSON.stringify(fromStore), JSON.stringify(fromArray), 'Matches read from the store');
const seed = { pattern: 1, ids: new Set([inferred.at(-1).id]) };
assert.equal(
  JSON.stringify(createGrammarMatcher().match(ways, inferred, { seed })),
  JSON.stringify(createGrammarMatcher().match(ways, [...inferred], { seed })),
  'A seed found through the store',
);
assert.throws(() => storePrefix([inferred[1]], inferredStore), /Not a prefix/);
const grown = storePrefix(inferred.slice(0, 2), inferredStore);
grown.push(inferred[2]);
assert.equal(storeOf(grown), null, 'A changed array is no longer a prefix');
const { columns } = FactStore.from(inferred).bytes;
assert(columns / inferred.length < 200, 'Tens of bytes a fact, not kilobytes');
console.log(
  'ok fact store: facts as integer columns read back exactly, with proofs, alternatives, premises on later facts and derivations; inference writes it, and the matcher reads its prefixes',
);
