/** Proofs as integer arrays: what holds without a source, found in one pass,
 * is what inference without that source derives; and the sources every proof
 * of a fact rests on are exactly those without which it fails. Alternatives,
 * cycles and chains included. */
import assert from 'node:assert/strict';
import {
  inferRelations,
  necessarySources,
  proofGraph,
  supportLevels,
  withheldSupport,
} from '../../src/amr/inference.mjs';
import { FactStore, storePrefix } from '../../src/amr/fact-store.mjs';

// Two ways to a reachable gate, a cycle between two rooms, and a chain.
const inputs = [
  { triple: ['hall', ':door', 'yard'], sourceIds: ['plan'] },
  { triple: ['yard', ':door', 'gate'], sourceIds: ['plan'] },
  { triple: ['hall', ':path', 'gate'], sourceIds: ['survey'] },
  { triple: ['east', ':door', 'west'], sourceIds: ['notes'] },
  { triple: ['west', ':door', 'east'], sourceIds: ['notes'] },
  { triple: ['hall', ':kind', 'room'], sourceIds: ['register'] },
];
const rules = [
  {
    id: 'step',
    name: 'A door is a way',
    sourceIds: ['doors'],
    when: [['?a', ':door', '?b']],
    then: [['?a', ':way', '?b']],
  },
  {
    id: 'path',
    name: 'A path is a way',
    sourceIds: ['paths'],
    when: [['?a', ':path', '?b']],
    then: [['?a', ':way', '?b']],
  },
  {
    id: 'reach',
    name: 'Ways compose',
    sourceIds: ['reach'],
    when: [
      ['?a', ':way', '?b'],
      ['?b', ':way', '?c'],
    ],
    then: [['?a', ':way', '?c']],
  },
  {
    id: 'marked',
    name: 'A room with a way out is marked',
    sourceIds: ['marks'],
    when: [
      ['?a', ':kind', 'room'],
      ['?a', ':way', '?b'],
    ],
    then: [['?a', ':marked', '$m']],
  },
];
const full = inferRelations(inputs, rules);
assert(full.complete);
const graph = proofGraph(full.facts);
assert(graph.proofFact.length > graph.length, 'Some facts have alternative proofs');
const sources = [...new Set([...inputs, ...rules].flatMap((item) => item.sourceIds))];
const necessity = necessarySources(graph);
assert(necessity.complete);
for (const source of sources) {
  const truth = new Set(
    inferRelations(
      inputs.filter((input) => !input.sourceIds.includes(source)),
      rules.filter((rule) => !rule.sourceIds.includes(source)),
    ).facts.map((fact) => fact.id),
  );
  const holds = withheldSupport(graph, [source]);
  for (let f = 0; f < graph.length; f++) {
    const id = graph.facts[f].id;
    assert.equal(Boolean(holds[f]), truth.has(id), `${id} without ${source}`);
    assert.equal(!necessity.of(f).includes(source), truth.has(id), `${id} needs ${source}?`);
  }
}
// Levels: for a source order, what holds at level k is what holds without the
// sources after k, and a proof is usable from the level its sources and
// premises allow. Every prefix of several orders, and sources never given.
const orders = [sources, [...sources].reverse(), [...sources.slice(1), sources[0]]];
for (const order of orders)
  for (const never of [null, order[0]]) {
    const at = new Map(order.map((source, i) => [source, i]));
    if (never) at.delete(never);
    const levels = supportLevels(graph, (source) => at.get(source));
    for (let k = 0; k < order.length; k++) {
      const withheld = sources.filter((source) => !(at.get(source) <= k));
      const holds = withheldSupport(graph, withheld);
      for (let f = 0; f < graph.length; f++)
        assert.equal(levels.facts[f] <= k, Boolean(holds[f]), `${graph.facts[f].id} at ${k}`);
      for (let p = 0; p < graph.proofFact.length; p++) {
        let usable = !graph.broken[p];
        for (let i = graph.sourceStart[p]; i < graph.sourceStart[p + 1]; i++)
          usable &&= !withheld.includes(graph.sourceIds[graph.sourcePool[i]]);
        for (let i = graph.premiseStart[p]; i < graph.premiseStart[p + 1]; i++)
          usable &&= Boolean(holds[graph.premises[i]]);
        assert.equal(levels.proofs[p] <= k, usable, `proof ${p} at ${k}`);
      }
    }
  }
// Read from inference's store or from the objects, the graph is the same.
const objects = proofGraph([...full.facts]);
assert.notEqual(objects, graph);
const withoutNotes = withheldSupport(objects, ['notes']);
assert.deepEqual([...withoutNotes], [...withheldSupport(graph, ['notes'])]);
const fromObjects = necessarySources(objects);
for (let f = 0; f < graph.length; f++)
  assert.deepEqual(fromObjects.of(f), necessity.of(f), 'Necessity read from the objects');
// Every prefix of the store: a proof resting on a later fact is unusable.
const samePrefixes = (facts, store) => {
  let cut = 0;
  for (let n = 1; n <= facts.length; n++) {
    const prefix = facts.slice(0, n);
    const early = proofGraph(storePrefix(prefix, store)),
      earlyObjects = proofGraph([...prefix]);
    for (const field of ['factProofs', 'proofFact', 'broken', 'premiseStart', 'premises'])
      assert.deepEqual([...early[field]], [...earlyObjects[field]], `${field} at ${n}`);
    cut += early.broken.reduce((sum, b) => sum + b, 0);
  }
  return cut;
};
samePrefixes(full.facts, full.store);
const later = [
  [['a', ':way', 'c'], { ruleId: 'r', premises: ['["c",":door","a"]'], sourceIds: [] }],
  [['c', ':door', 'a'], { sourceIds: ['plan'] }],
].map(([triple, proof]) => ({ id: JSON.stringify(triple), triple, ...proof }));
assert.equal(samePrefixes(later, FactStore.from(later)), 1, 'Cut off from a later premise');
const at = (triple) => graph.position.get(JSON.stringify(triple));
assert.deepEqual(
  necessity.of(at(['hall', ':way', 'gate'])),
  [],
  'Reached by a door and a path, by two rules: no single source is needed',
);
assert.deepEqual(necessity.of(at(['east', ':way', 'east'])).sort(), ['doors', 'notes', 'reach']);
console.log(
  'ok provenance: support without a source matches inference without it; necessary sources are exactly the ones whose absence breaks a fact',
);
