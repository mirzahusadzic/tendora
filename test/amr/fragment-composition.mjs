import assert from 'node:assert/strict';
import {
  connectedFragments,
  checkFragmentMap,
  literalCorrespondence,
  composeEnvelopes,
  verifyEnvelope,
  alignmentGaps,
  relationPath,
  foldRelation,
  expandRelation,
} from '../../src/amr/fragment-composition.mjs';

const graph = (top, concepts, relations) => ({
  top,
  nodes: Object.entries(concepts).map(([id, concept]) => ({ id, concept })),
  edges: relations.map(([from, role, to], index) => ({ id: `e${index}`, from, role, to })),
});
const source = graph(
  'o',
  {
    o: 'offer-01',
    t: 'team',
    a: 'assist-01',
    h: 'human',
    f: 'fail-01',
    q: 'frequent-02',
    u: 'urgent',
  },
  [
    ['o', ':ARG0', 't'],
    ['o', ':ARG1', 'a'],
    ['a', ':ARG0', 'h'],
    ['a', ':ARG1', 'f'],
    ['q', ':ARG1', 'f'],
    ['f', ':mod', 'u'],
  ],
);
const carried = graph(
  'c',
  { c: 'and', x: 'fail-01', n: 'frequent-02', v: 'urgent', l: 'log-on-02', p: 'i' },
  [
    ['c', ':op1', 'n'],
    ['n', ':ARG1', 'x'],
    ['c', ':op2', 'v'],
    ['x', ':mod', 'v'],
    ['x', ':ARG1', 'l'],
    ['l', ':ARG0', 'p'],
  ],
);
const before = JSON.stringify([source, carried]);
const left = connectedFragments(source).find(
  (fragment) =>
    fragment.graph.nodes.length === 3 &&
    ['f', 'q', 'u'].every((id) => fragment.graph.nodes.some((node) => node.id === id)),
);
const right = connectedFragments(carried).find(
  (fragment) =>
    fragment.graph.nodes.length === 3 &&
    ['x', 'n', 'v'].every((id) => fragment.graph.nodes.some((node) => node.id === id)),
);
const pairs = [
  ['f', 'x'],
  ['q', 'n'],
  ['u', 'v'],
];
assert(checkFragmentMap(left.graph, right.graph, pairs));
assert(left.boundary.some((edge) => edge.from === 'a' && edge.to === 'f'));
assert(right.boundary.some((edge) => edge.from === 'x' && edge.to === 'l'));
const result = composeEnvelopes(source, carried, pairs);
assert(verifyEnvelope(source, result, 0));
assert(verifyEnvelope(carried, result, 1));
assert.equal(JSON.stringify([source, carried]), before);
assert.deepEqual(result.definition, source);
assert.deepEqual(result.carried, carried);
assert.equal(result.graph.nodes.length, source.nodes.length + carried.nodes.length - 3);
assert.equal(result.graph.edges.length, source.edges.length + carried.edges.length - 2);
const login = result.embeddings[1].l,
  human = result.embeddings[0].h;
const path = relationPath(result.graph, login, human);
assert.deepEqual(
  path.map((step) => [step.role, step.forward]),
  [
    [':ARG1', false],
    [':ARG1', false],
    [':ARG0', true],
  ],
);
assert.equal(result.anchors[1].top, result.embeddings[1].c);
assert(result.graph.nodes.every((node) => result.origins.nodes[node.id].length));
assert(result.graph.edges.every((edge) => result.origins.edges[edge.id].length));
assert(
  !result.graph.nodes.some((node) =>
    ['require-01', 'recommend-01', 'ticket'].includes(node.concept),
  ),
);

const changed = structuredClone(carried);
changed.nodes.find((node) => node.id === 'l').concept = 'pay-out-03';
assert.deepEqual(composeEnvelopes(source, changed, pairs).definition, result.definition);
const wrongRole = structuredClone(carried);
wrongRole.edges.find((edge) => edge.from === 'n').role = ':ARG0';
assert(
  !checkFragmentMap(
    left.graph,
    {
      ...right.graph,
      edges: right.graph.edges.map((edge) =>
        edge.from === 'n' ? { ...edge, role: ':ARG0' } : edge,
      ),
    },
    pairs,
  ),
);
assert.throws(() => composeEnvelopes(source, wrongRole, pairs), /relation/u);
assert.throws(
  () =>
    composeEnvelopes(source, carried, [
      ['f', 'x'],
      ['q', 'x'],
    ]),
  /Injective/u,
);
assert.throws(() => composeEnvelopes(source, carried, [['f', 'l']]), /concept/u);

// Polarity stays attached to its original scope in a candidate; graph overlap
// cannot erase it and thereby turn the candidate into a positive assertion.
const negative = structuredClone(carried);
negative.nodes.push({ id: 'literal:minus', concept: '-', literal: '-' });
negative.edges.push({ id: 'negative', from: 'x', role: ':polarity', to: 'literal:minus' });
const negativeComposition = composeEnvelopes(source, negative, pairs);
assert(verifyEnvelope(negative, negativeComposition, 1));
assert(
  negativeComposition.graph.edges.some(
    (edge) => edge.role === ':polarity' && edge.from === negativeComposition.embeddings[1].x,
  ),
);

// A high-overlap alignment still exposes the offer/require difference.
const inquiry = graph('r', { r: 'require-01', a: 'attend-02', h: 'human', q: 'amr-unknown' }, [
  ['r', ':ARG1', 'a'],
  ['a', ':ARG0', 'h'],
  ['r', ':polarity', 'q'],
]);
const diagnostic = alignmentGaps(inquiry, source, [
  ['r', 'o'],
  ['a', 'a'],
  ['h', 'h'],
]);
assert.deepEqual(
  diagnostic.nodes.map((node) => node.concept),
  ['require-01', 'attend-02'],
);
assert.equal(diagnostic.edges.length, 2);
const tampered = structuredClone(result);
tampered.graph.edges = tampered.graph.edges.filter((edge) => edge.to !== human);
assert(!verifyEnvelope(source, tampered, 0));

// Derive a reusable relation from the best-fit source structure, with its offer,
// frequency and case context outside the definition. Exact expansion is the
// content-preservation obligation, independently of any similarity score.
const signature = (input) =>
  JSON.stringify({
    top: input.top,
    assertionTop: input.assertionTop,
    nodes: input.nodes.map((node) => [node.id, node.concept, node.literal]).sort(),
    edges: input.edges.map((edge) => [edge.id, edge.from, edge.role, edge.to]).sort(),
  });
const folded = foldRelation(source, ['a', 'h', 'f', 'u'], ['u']);
assert.deepEqual(new Set(folded.ports), new Set(['a', 'f', 'u']));
assert(folded.context.edges.some((edge) => edge.from === 'o' && edge.to === 'a'));
assert(folded.context.edges.some((edge) => edge.from === 'q' && edge.to === 'f'));
assert.equal(signature(expandRelation(folded)), signature(source));
const whole = foldRelation(
  source,
  source.nodes.map((node) => node.id),
);
assert.deepEqual(whole.ports, [source.top]);
assert.equal(signature(expandRelation(whole)), signature(source));
const atCase = foldRelation(
  negativeComposition.graph,
  ['a', 'h', 'f', 'u'].map((id) => negativeComposition.embeddings[0][id]),
);
assert(atCase.context.edges.some((edge) => edge.role === ':polarity'));
assert.equal(signature(expandRelation(atCase)), signature(negativeComposition.graph));
// The source definition can be reused unchanged at a fresh occurrence, with an
// explicit map for private nodes and ports; case context is not in that definition.
const reused = {
  ...atCase,
  definition: folded.definition,
  ports: folded.ports,
  occurrence: {
    bindings: Object.fromEntries(
      folded.definition.nodes.map((node) => [node.id, negativeComposition.embeddings[0][node.id]]),
    ),
  },
};
assert.equal(signature(expandRelation(reused)), signature(negativeComposition.graph));
assert.deepEqual(reused.definition, folded.definition);
// A new occurrence renames both nodes and edges. The stored relation remains
// unchanged, including when the surrounding graph contains reentrancy/polarity.
const renamed = structuredClone(source),
  nodeMap = Object.fromEntries(source.nodes.map((node) => [node.id, `copy-${node.id}`]));
const edgeMap = Object.fromEntries(source.edges.map((edge) => [edge.id, `copy-${edge.id}`]));
renamed.top = nodeMap[renamed.top];
renamed.nodes.forEach((node) => {
  node.id = nodeMap[node.id];
});
renamed.edges.forEach((edge) => {
  edge.id = edgeMap[edge.id];
  edge.from = nodeMap[edge.from];
  edge.to = nodeMap[edge.to];
});
const renamedFold = foldRelation(
  renamed,
  folded.definition.nodes.map((node) => nodeMap[node.id]),
  ['copy-u'],
);
const renamedOccurrence = {
  ...renamedFold,
  definition: folded.definition,
  ports: folded.ports,
  occurrence: {
    bindings: Object.fromEntries(
      folded.definition.nodes.map((node) => [node.id, nodeMap[node.id]]),
    ),
    edgeBindings: Object.fromEntries(
      folded.definition.edges.map((edge) => [edge.id, edgeMap[edge.id]]),
    ),
  },
};
assert.equal(signature(expandRelation(renamedOccurrence)), signature(renamed));
for (const input of [source, negativeComposition.graph])
  for (const fragment of connectedFragments(input)) {
    assert.equal(
      signature(
        expandRelation(
          foldRelation(
            input,
            fragment.graph.nodes.map((node) => node.id),
          ),
        ),
      ),
      signature(input),
    );
  }
assert.throws(() => foldRelation(source, ['o', 'f']), /connected/u);
assert.throws(() => foldRelation(source, ['f', 'f']), /connected/u);
const wrongPort = structuredClone(folded);
wrongPort.occurrence.bindings.a = 'f';
assert.throws(() => expandRelation(wrongPort), /bindings/u);
const wrongConcept = structuredClone(folded);
wrongConcept.context.nodes.find((node) => node.id === 'a').concept = 'attend-02';
assert.throws(() => expandRelation(wrongConcept), /meaning/u);
// SEMCAT maps variables; literal attributes extend that correspondence only at
// the same incoming role/value. A duplicate attribute retains both origins.
const named = graph('n', { n: 'name', v: 'Mira' }, [['n', ':op1', 'v']]);
named.nodes[1].literal = '"Mira"';
const otherName = graph('other', { other: 'name', value: 'Mira' }, [['other', ':op1', 'value']]);
otherName.nodes[1].literal = '"Mira"';
assert.deepEqual(literalCorrespondence(named, otherName, [['n', 'other']]), [
  ['n', 'other'],
  ['v', 'value'],
]);
assert(checkFragmentMap(named, otherName, [['n', 'other']]));
assert(
  !checkFragmentMap(named, otherName, [
    ['n', 'other'],
    ['n', 'other'],
  ]),
);
const joinedName = composeEnvelopes(named, otherName, [['n', 'other']]);
assert.equal(joinedName.graph.edges.length, 1);
assert.equal(joinedName.graph.nodes.length, 2);
assert.equal(joinedName.origins.edges.e0.length, 2);
assert(verifyEnvelope(named, joinedName, 0));
assert(verifyEnvelope(otherName, joinedName, 1));
const differentValue = structuredClone(otherName);
differentValue.nodes[1].literal = '"Rafi"';
assert(!checkFragmentMap(named, differentValue, [['n', 'other']]));
const twoPorts = graph('n', { n: 'name', second: 'name', a: 'Mira', b: 'Mira' }, [
  ['n', ':mod', 'second'],
  ['n', ':op1', 'a'],
  ['second', ':op1', 'b'],
]);
twoPorts.nodes.slice(2).forEach((node) => {
  node.literal = '"Mira"';
});
const sharedValue = graph('n2', { n2: 'name', s2: 'name', v: 'Mira' }, [
  ['n2', ':mod', 's2'],
  ['n2', ':op1', 'v'],
  ['s2', ':op1', 'v'],
]);
sharedValue.nodes[2].literal = '"Mira"';
const joinedPorts = composeEnvelopes(twoPorts, sharedValue, [
  ['n', 'n2'],
  ['second', 's2'],
]);
assert(verifyEnvelope(twoPorts, joinedPorts, 0));
assert(verifyEnvelope(sharedValue, joinedPorts, 1));
assert.equal(joinedPorts.graph.edges.length, 3);
assert.equal(joinedPorts.graph.nodes.length, 3);
console.log(
  'ok connected composition and expandable relation variants preserve source/case contents, roles, scope and explicit query gaps',
);
