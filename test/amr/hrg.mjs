/** Independent graph/relational oracles for the paper-derived compiler and chart. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  orderedDecomposition,
  extractHrg,
  graphTerminals,
} from '../../src/amr/hrg-decomposition.mjs';
import { compileCorpus, grammarFacts } from '../../src/amr/hrg-corpus.mjs';
import { matchChart, createGrammarMatcher } from '../../src/amr/hrg-query.mjs';

const fixture = JSON.parse(
  await readFile(new URL('../support/qa-domain-fixtures.json', import.meta.url), 'utf8'),
);
for (const { graph } of fixture.graphs) {
  const terminals = graphTerminals(graph);
  for (const order of [graph.nodes.map((n) => n.id), graph.nodes.map((n) => n.id).reverse()]) {
    const extracted = extractHrg(order, terminals),
      emitted = [],
      mapping = new Map();
    let fresh = 0;
    const expand = (id, external) => {
      const rule = extracted.rules[id],
        local = [...external];
      while (local.length < rule.vertices.length) local.push('v' + fresh++);
      rule.vertices.forEach((v, i) => {
        if (mapping.has(v))
          assert.equal(mapping.get(v), local[i], 'Reentrancy survives external attachments');
        else mapping.set(v, local[i]);
      });
      for (const term of rule.terminals)
        emitted.push([term.id, term.label, term.ports.map((i) => local[i])]);
      for (const child of rule.children)
        expand(
          child.id,
          child.ports.map((i) => local[i]),
        );
    };
    expand(0, []);
    assert.deepEqual(
      emitted.sort(),
      terminals.map((t) => [t.id, t.label, t.vertices.map((v) => mapping.get(v))]).sort(),
    );
    assert.equal(new Set(mapping.values()).size, graph.nodes.length);
  }
}
const permutations = (xs) =>
  xs.length
    ? xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map((ys) => [x, ...ys]))
    : [[]];
const eliminationWidth = (n, edges, order) => {
  const adjacent = Array.from({ length: n }, () => new Set());
  for (const [a, b] of edges) {
    adjacent[a].add(b);
    adjacent[b].add(a);
  }
  let width = 0;
  for (const v of order) {
    const neighbors = adjacent[v];
    width = Math.max(width, neighbors.size);
    for (const a of neighbors) {
      for (const b of neighbors) if (a !== b) adjacent[a].add(b);
      adjacent[a].delete(v);
    }
  }
  return width;
};
let widthCases = 0;
for (let n = 1; n <= 4; n++) {
  const vertices = Array.from({ length: n }, (_, i) => i),
    pairs = vertices.flatMap((a) => vertices.filter((b) => a < b).map((b) => [a, b]));
  for (let bits = 0; bits < 2 ** pairs.length; bits++) {
    const edges = pairs.filter((_, i) => bits & (1 << i)),
      orders = permutations(vertices);
    const reference = Math.min(...orders.map((order) => eliminationWidth(n, edges, order)));
    const observed = Math.min(
      ...orders.map(
        (order) =>
          orderedDecomposition(
            order,
            edges.map((vertices) => ({ vertices })),
          ).width,
      ),
    );
    assert.equal(observed, reference);
    widthCases++;
  }
}

const variable = (v) => v.startsWith('?');
function oracle(patterns, facts, index = 0, values = {}, witnesses = []) {
  if (index === patterns.length) {
    const nodes = new Set(
      patterns.flatMap(([a, role, b]) =>
        role.startsWith(':') ? [a, ...(role === ':instance' ? [] : [b])].filter(variable) : [],
      ),
    );
    const assigned = [...nodes].map((v) => values[v]);
    return new Set(assigned).size === assigned.length ? [{ values, witnesses }] : [];
  }
  const result = [];
  for (const fact of facts) {
    const next = { ...values };
    let ok = true;
    patterns[index].forEach((term, at) => {
      const value = fact.triple[at];
      if (!variable(term)) {
        if (term !== value) ok = false;
      } else if (term in next && next[term] !== value) ok = false;
      else next[term] = value;
    });
    if (ok) result.push(...oracle(patterns, facts, index + 1, next, [...witnesses, fact.id]));
  }
  return result;
}
const signatures = (matches) =>
  matches
    .map((m) => JSON.stringify([Object.entries(m.values).sort(), [...m.witnesses].sort()]))
    .sort();
let seed = 1039;
const random = (max) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % max;
};
for (let i = 0; i < 250; i++) {
  const facts = Array.from({ length: 3 + random(6) }, (_, id) => ({
    id: String(id),
    triple: ['v' + random(4), ':r' + random(2), 'v' + random(4)],
  }));
  const patterns = Array.from({ length: 1 + random(4) }, () => [
    random(3) ? '?x' + random(3) : 'v' + random(4),
    random(3) ? ':r' + random(2) : '?role',
    random(3) ? '?x' + random(3) : 'v' + random(4),
  ]);
  const actual = matchChart(patterns, facts, { limit: 100000 });
  assert(actual.complete);
  assert.deepEqual(signatures(actual.matches), signatures(oracle(patterns, facts)));
}

const triples = [
  ['want', ':instance', 'want-01'],
  ['want', ':ARG0', 'person'],
  ['want', ':ARG1', 'go'],
  ['go', ':instance', 'go-01'],
  ['go', ':ARG0', 'person'],
  ['person', ':instance', 'person'],
];
const facts = ['first', 'second'].flatMap((source) =>
  triples.map((triple, i) => ({
    id: `${source}/${i}`,
    sourceIds: [source],
    triple: triple.map((v, at) =>
      at === 0 || (at === 2 && triple[1] !== ':instance') ? `${source}/${v}` : v,
    ),
  })),
);
const patterns = [
  ['?w', ':instance', 'want-01'],
  ['?w', ':ARG0', '?p'],
  ['?w', ':ARG1', '?g'],
  ['?g', ':instance', 'go-01'],
  ['?g', ':ARG0', '?p'],
];
const matcher = createGrammarMatcher(),
  answer = matcher.match(patterns, facts);
assert.equal(answer.matches.length, 2);
assert(matcher.corpora[0].stats.sharedRules > 0, 'Source-independent productions are reused');
assert.deepEqual(
  grammarFacts(matcher.corpora[0], facts)
    .map((f) => [f.id, f.triple])
    .sort(),
  facts.map((f) => [f.id, f.triple]).sort(),
);
for (const match of answer.matches) {
  const seen = new Set();
  const check = (tree) => {
    const plan = answer.plan.rules[tree.rule];
    assert.deepEqual(
      tree.ports,
      plan.vertices.slice(0, plan.rank).map((v) => [v, match.values[v]]),
    );
    for (const terminal of tree.terminals) {
      assert(!seen.has(terminal.pattern));
      seen.add(terminal.pattern);
      const fact = facts.find((f) => f.id === terminal.fact);
      assert.deepEqual(
        patterns[terminal.pattern].map((v) => (variable(v) ? match.values[v] : v)),
        fact.triple,
      );
      assert(terminal.production);
    }
    for (const child of tree.children) check(child);
  };
  check(match.derivation.tree);
  assert.equal(seen.size, patterns.length);
}
const changed = structuredClone(facts);
changed.find((f) => f.id === 'first/4').triple[2] = 'first/other-person';
assert.equal(
  createGrammarMatcher().match(patterns, changed).matches.length,
  1,
  'Independent occurrences cannot supply reentrancy',
);
assert.deepEqual(
  signatures(createGrammarMatcher().match(patterns, [...facts].reverse()).matches),
  signatures(answer.matches),
);
const cache = matcher.cache(),
  warm = createGrammarMatcher(cache);
assert.equal(warm.match(patterns, facts).matches.length, 2);
assert.equal(warm.stats.compilations, 0);
warm.match(patterns, changed);
assert.equal(warm.stats.compilations, 1, 'Changed roles/attachments invalidate the cache');
assert(!matchChart(patterns, facts, { budget: 1 }).complete);
for (let budget = 0; budget <= answer.work; budget++) {
  const bounded = matchChart(patterns, facts, { budget });
  for (const match of bounded.matches) {
    assert.equal(match.witnesses.length, patterns.length);
    for (const [i, witness] of match.witnesses.entries()) {
      const fact = facts.find((f) => f.id === witness);
      assert(fact, `Budget ${budget}: every returned binding needs every query witness`);
      assert.deepEqual(
        fact.triple,
        patterns[i].map((term) => (variable(term) ? match.values[term] : term)),
      );
    }
  }
}
const compiled = compileCorpus(facts),
  broken = structuredClone(compiled.grammar);
const used = answer.matches[0].derivation.tree;
const terminals = (tree) => [...tree.terminals, ...tree.children.flatMap(terminals)];
delete broken.rules[terminals(used)[0].production.rule];
assert.equal(
  matchChart(patterns, grammarFacts(broken, facts)).matches.length,
  0,
  'Removing a reused production retracts the answer; no flat-matcher fallback',
);
console.log(
  `ok HRG: 148 graph reconstructions; ${widthCases} exhaustive width cases; 250 independent query oracles; source identities, reentrancy, derivations, production ablation and cache invalidation`,
);
