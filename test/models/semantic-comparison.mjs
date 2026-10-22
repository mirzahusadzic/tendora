/** Authored metric regression cases and an independent finite alignment oracle. */
import assert from 'node:assert/strict';
import { compareGraphs, comparisonProfile } from '../../src/models/semantic-comparison.mjs';
import { prepareGraphs } from '../../src/models/graph-preparation.mjs';

const fail = '(f / fail-01 :mod (u / urgent))';
const cases = [
  ['identity', fail, fail, true],
  ['renaming', fail, '(x / fail-01 :mod (y / urgent))', true],
  ['focus', fail, '(u / urgent :mod-of (f / fail-01))', true],
  ['domain', fail, '(u / urgent :domain (f / fail-01))', true],
  ['negation', fail, '(f / fail-01 :mod (u / urgent) :polarity -)', false],
  ['qualification', fail, '(f / fail-01 :mod (u / frequent))', false],
  [
    'roles',
    '(s / sell-01 :ARG0 (c / company) :ARG1 (v / service))',
    '(s / sell-01 :ARG1 (c / company) :ARG0 (v / service))',
    false,
  ],
  ['sense', '(p / pay-01)', '(p / pay-04)', false],
  [
    'operator',
    '(a / and :op1 (f / frequent) :op2 (u / urgent))',
    '(a / or :op1 (f / frequent) :op2 (u / urgent))',
    false,
  ],
  [
    'reentrancy',
    '(s / see-01 :ARG0 (p / person) :ARG1 p)',
    '(s / see-01 :ARG0 (p / person) :ARG1 (q / person))',
    false,
  ],
  ['duplicate', '(s / see-01 :ARG0 (p / person))', '(s / see-01 :ARG0 (p / person) :ARG0 p)', true],
  [
    'reification',
    '(k / knife :location (d / drawer))',
    '(b / be-located-at-91 :ARG1 (k / knife) :ARG2 (d / drawer))',
    true,
  ],
  [
    'qualified reification',
    '(k / knife :location (d / drawer))',
    '(b / be-located-at-91 :ARG1 (k / knife) :ARG2 (d / drawer) :polarity -)',
    false,
  ],
  ['unicode identity', '(n / name :op1 "Mirža")', '(n / name :op1 "Mirža")', true],
  ['unicode distinction', '(n / name :op1 "Malmo")', '(n / name :op1 "Malmö")', false],
  ['literal case', '(n / name :op1 "A")', '(n / name :op1 "a")', false],
  ['literal spacing', '(n / name :op1 "New York")', '(n / name :op1 "NewYork")', false],
  [
    'lexical consist-of',
    '(m / mixture :consist-of (w / water))',
    '(w / water :consist-of (m / mixture))',
    false,
  ],
  [
    'lexical prep-out-of',
    '(g / go-01 :prep-out-of (r / room))',
    '(r / room :prep-out-of (g / go-01))',
    false,
  ],
];
const result = await compareGraphs(
  cases.map(([, reference, hypothesis]) => ({ reference, hypothesis })),
);
assert.equal(result.profile, comparisonProfile);
assert.equal(result.parameters.solver, 'Python-MIP/HIGHS');
assert.equal(result.source.runtimeCommit, 'e00a02b954e8d6baf3e362844da4e9ae6509efc9');
assert.equal(result.versions['semcat-runtime'], '0.1.0');
for (const [i, [name, , , equal]] of cases.entries()) {
  const value = result.results[i];
  assert(value.complete, `${name}: ${JSON.stringify(value)}`);
  assert.equal(value.score === 1, equal, name);
  assert(Math.abs(value.score - (value.local.score + 0.75 * value.global.score) / 1.75) < 1e-10);
}
assert.deepEqual(
  new Set(result.results[1].local.correspondence.map(JSON.stringify)),
  new Set(
    [
      ['f', 'x'],
      ['u', 'y'],
    ].map(JSON.stringify),
  ),
);
assert.deepEqual(
  new Set(Object.values(result.results[11].origins.hypothesis)),
  new Set(['k', 'd']),
);

// A single eight-cycle versus two four-cycles below a common root: identical
// WL colors, but different incidence. Mapped triples must distinguish them.
const cycle =
  '(r / and :op1 (a0 / person :ARG0 (b0 / team) :ARG0 (b1 / team)) :op1 (a1 / person :ARG0 b1 :ARG0 (b2 / team)) :op1 (a2 / person :ARG0 b2 :ARG0 (b3 / team)) :op1 (a3 / person :ARG0 b3 :ARG0 b0))';
const split =
  '(r / and :op1 (a0 / person :ARG0 (b0 / team) :ARG0 (b1 / team)) :op1 (a1 / person :ARG0 b1 :ARG0 b0) :op1 (a2 / person :ARG0 (b2 / team) :ARG0 (b3 / team)) :op1 (a3 / person :ARG0 b3 :ARG0 b2))';
const collision = (await compareGraphs([{ reference: cycle, hypothesis: split }])).results[0];
assert(collision.complete, JSON.stringify(collision));
assert(collision.global.score < 1 && collision.local.score < 1);
const limited = (
  await compareGraphs(
    [
      { reference: cycle, hypothesis: split },
      { reference: fail, hypothesis: fail },
    ],
    { maxMappings: 1 },
  )
).results;
assert.equal(limited[0].state, 'limited');
assert.equal(limited[0].score, null);
assert.equal(limited[1].score, 1);
const wiki = [{ reference: '(p / person :wiki "A")', hypothesis: '(p / person :wiki "B")' }];
assert.equal((await compareGraphs(wiki)).results[0].score, 1);
assert.equal(
  (await compareGraphs(wiki, { comparisons: [] })).results.length,
  1,
  'Options cannot replace the validated comparison list',
);
const retainedWiki = (await compareGraphs(wiki, { ignoreWiki: false })).results[0];
assert(retainedWiki.complete && retainedWiki.local.score < 1 && retainedWiki.global.score < 1);
const invalid = (
  await compareGraphs([
    { reference: '(x /)', hypothesis: fail },
    { reference: fail, hypothesis: fail },
  ])
).results;
assert.equal(invalid[0].state, 'error');
assert.equal(invalid[1].score, 1);
assert.equal(
  (await compareGraphs([{ reference: fail, hypothesis: fail }], { maxPairs: 1 })).results[0].state,
  'limited',
);
await assert.rejects(compareGraphs(Array(129).fill({ reference: fail, hypothesis: fail })), /128/);
const abort = new AbortController();
abort.abort();
await assert.rejects(compareGraphs([], { signal: abort.signal }), /abort/iu);
await assert.rejects(
  compareGraphs([{ reference: cycle, hypothesis: split }], { timeoutMs: 1 }),
  /timed out/,
);

const family = ['(x / person)', '(x / team)'];
for (const a of ['person', 'team'])
  for (const b of ['person', 'team'])
    for (const role of ['ARG0', 'ARG1']) family.push(`(a / ${a} :${role} (b / ${b}))`);
family.push(
  '(a / person :ARG0 (b / team) :ARG1 (c / team))',
  '(a / person :ARG0 (b / team :ARG1 (c / team)))',
);
const pairs = family.flatMap((reference) =>
  family.map((hypothesis) => ({ reference, hypothesis })),
);
const values = [];
for (let i = 0; i < pairs.length; i += 128)
  values.push(...(await compareGraphs(pairs.slice(i, i + 128))).results);
const normalized = values.flatMap((v) =>
  Object.values(v.standardized).map((penman) => ({ penman })),
);
const graphs = [];
for (let i = 0; i < normalized.length; i += 128) {
  const batch = await prepareGraphs(normalized.slice(i, i + 128));
  for (const item of batch.results) {
    assert(item.ok);
    graphs.push(item.graph);
  }
}
function triples(graph, origins) {
  const nodes = graph.nodes.map((n) => [origins[n.id], ':instance', n.concept]);
  const edges = graph.edges.map((e) => [origins[e.from], e.role, origins[e.to]]);
  return [
    ...nodes,
    ...edges,
    [origins[graph.top], ':root', graph.nodes.find((n) => n.id === graph.top).concept],
  ];
}
let mapsChecked = 0;
for (const [i, value] of values.entries()) {
  assert(value.complete, JSON.stringify(value));
  const left = triples(graphs[2 * i], value.origins.reference),
    right = triples(graphs[2 * i + 1], value.origins.hypothesis);
  const source = Object.values(value.origins.reference),
    target = Object.values(value.origins.hypothesis);
  const facts = new Set(right.map(JSON.stringify));
  const score = (map) =>
    left.filter(([s, r, t]) =>
      facts.has(
        JSON.stringify([
          map[s],
          r,
          source.includes(t) && ![':instance', ':root'].includes(r) ? map[t] : t,
        ]),
      ),
    ).length;
  let optimum = 0;
  const enumerate = (at, mapping, available) => {
    if (at === source.length) {
      optimum = Math.max(optimum, score(mapping));
      mapsChecked++;
      return;
    }
    enumerate(at + 1, mapping, available);
    for (const t of available)
      enumerate(
        at + 1,
        { ...mapping, [source[at]]: t },
        available.filter((x) => x !== t),
      );
  };
  enumerate(0, {}, target);
  assert(Math.abs(value.local.objectiveLowerBound - optimum) < 1e-6, JSON.stringify(pairs[i]));
  assert(Math.abs(value.local.objectiveUpperBound - optimum) < 1e-6);
  assert.equal(
    score(Object.fromEntries(value.local.correspondence)),
    optimum,
    'Returned source mapping attains the objective',
  );
  assert(Math.abs(value.local.score - (2 * optimum) / (left.length + right.length)) < 1e-10);
}
console.log(
  `ok authored SEMCAT: ${cases.length} semantic cases, WL collision, limits, Unicode, cancellation; ${pairs.length} oracle pairs / ${mapsChecked} partial injections`,
);
