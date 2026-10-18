/** The preparation/scoring boundary agrees on roles and retains source origins. */
import assert from 'node:assert/strict';
import { prepareGraphs, normalizedRoleProfile } from '../../src/models/graph-preparation.mjs';
import { compareGraphs } from '../../src/models/semantic-comparison.mjs';

const prepare = (graphs, options = {}) =>
  prepareGraphs(graphs, { ...options, profile: normalizedRoleProfile });
const variants = [
  '(f / fail-01 :mod (u / urgent))',
  '(u / urgent :domain (f / fail-01))',
  '(u / urgent :mod-of (f / fail-01))',
  '(f / fail-01 :domain-of (u / urgent))',
];
const batch = await prepare(variants.map((penman) => ({ penman })));
assert(
  batch.results.every((item) => item.ok),
  JSON.stringify(batch),
);
const relations = (graph) => graph.edges.map((e) => [e.from, e.role, e.to]);
for (const [i, item] of batch.results.entries()) {
  assert.deepEqual(relations(item.graph), [['f', ':mod', 'u']]);
  assert.equal(item.graph.top, i === 1 || i === 2 ? 'u' : 'f');
  assert.equal(item.graph.assertionTop, item.graph.top);
  const repeated = (await prepare([{ graph: item.graph, originalPenman: item.penman }])).results[0];
  assert(repeated.ok, JSON.stringify(repeated));
  assert.deepEqual(
    repeated.graph,
    item.graph,
    'Preparation is idempotent, including occurrence IDs',
  );
}
const scores = await compareGraphs(
  variants.map((hypothesis) => ({ reference: variants[0], hypothesis })),
);
assert.equal(scores.normalizationProfile, normalizedRoleProfile);
for (const score of scores.results) {
  assert(score.complete && score.score === 1);
  const prepared = await prepare([{ penman: score.standardized.hypothesis }]);
  const graph = prepared.results[0].graph,
    origins = score.origins.hypothesis;
  assert.deepEqual(
    graph.edges.map((e) => [origins[e.from], e.role, origins[e.to]]),
    [['f', ':mod', 'u']],
  );
}

// Each inverse spelling must agree between role-only preparation and a graph.
const roles = [
  ':mod',
  ':domain',
  ':ARG0',
  ':ARG1',
  ':consist-of',
  ':prep-on-behalf-of',
  ':prep-out-of',
].flatMap((role) => Array.from({ length: 5 }, (_, i) => role + '-of'.repeat(i)));
const roleMap = (await prepare([], { roles })).roles;
const roleGraphs = await prepare(
  roles.map((role) => ({ penman: `(a / thing ${role} (b / thing))` })),
);
for (const [i, item] of roleGraphs.results.entries()) {
  assert(item.ok, JSON.stringify(item));
  const { role, inverse } = roleMap[roles[i]];
  assert.deepEqual(relations(item.graph), [inverse ? ['b', role, 'a'] : ['a', role, 'b']]);
}

const input = '(f / fail-01 :mod (u / urgent~e.2 :domain-of (g / go-01)) :polarity -)';
const prepared = (
  await prepare([
    { penman: input, operations: [{ kind: 'relabel' }, { kind: 'reroot', node: 'a1' }] },
  ])
).results[0];
assert(prepared.ok, JSON.stringify(prepared));
assert.notEqual(prepared.graph.top, prepared.graph.assertionTop);
assert.equal(prepared.alignments.length, 1);
assert.deepEqual(
  new Set(Object.values(prepared.origins.nodes).flatMap((origin) => origin.nodes)),
  new Set(['f', 'u', 'g']),
);
assert(prepared.graph.edges.some((e) => e.role === ':polarity'));

// Reification is delegated to PENMAN; mapped edges retain all source triples.
const reified = '(k / knife :ARG1-of (b / be-located-at-91 :ARG2 (d / drawer)))';
const converted = (await prepare([{ penman: reified, operations: [{ kind: 'dereify-safe' }] }]))
  .results[0];
assert(converted.ok, JSON.stringify(converted));
assert.deepEqual(relations(converted.graph), [['k', ':location', 'd']]);
assert.deepEqual(converted.origins.edges[converted.graph.edges[0].id].nodes, ['b']);
assert.equal(converted.origins.edges[converted.graph.edges[0].id].edges.length, 2);
const roundTrip = (
  await prepare([
    {
      graph: converted.graph,
      originalPenman: converted.penman,
      operations: [{ kind: 'reify' }, { kind: 'dereify' }],
    },
  ])
).results[0];
assert(roundTrip.ok, JSON.stringify(roundTrip));
assert.deepEqual(relations(roundTrip.graph), [['k', ':location', 'd']]);

// Distinguish the source anchor from the scorer's canonical display root.
const rooted = (
  await prepare([
    {
      penman: '(b / be-located-at-91 :ARG1 (k / knife) :ARG2 (d / drawer))',
      operations: [{ kind: 'dereify-safe' }],
    },
  ])
).results[0];
assert(rooted.ok);
assert(rooted.graph.nodes.some((n) => n.id === 'b'));
const qualified = (
  await prepare([
    {
      penman: reified.replace(':ARG2', ':polarity - :ARG2'),
      operations: [{ kind: 'dereify-safe' }],
    },
  ])
).results[0];
assert(qualified.ok && qualified.graph.nodes.some((n) => n.concept === 'be-located-at-91'));
const literals = await prepare([{ penman: '(n / name :op1 "Mirža" :op2 "3" :op3 3)' }]);
assert.deepEqual(
  literals.results[0].graph.nodes.filter((n) => n.literal !== undefined).map((n) => n.literal),
  ['"Mirža"', '"3"', '3'],
);
console.log(
  `ok shared PENMAN role profile: ${variants.length} equivalent graphs, ${roles.length} inverse spellings, scoring correspondence, idempotence, transformations and source origins`,
);
