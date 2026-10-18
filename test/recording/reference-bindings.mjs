import assert from 'node:assert/strict';
import { bindReferences } from '../../src/recording/reference-bindings.mjs';
import { graphRevision } from '../../src/recording/revisions.mjs';
import { inferRelations } from '../../src/amr/inference.mjs';
import { answerMaterial, evaluateAnswer } from '../../src/recording/answers.mjs';
import { compositionMaterial } from '../../src/recording/composition.mjs';
import { searchCompositions } from '../../src/amr/composition.mjs';

const graph = () => ({ top: 'f', nodes: [{ id: 'f', concept: 'fail-01' }], edges: [] });
const graphs = [graph(), graph()];
const sources = graphs.map((_, index) => ({
  id: `s${index}`,
  nodeId: `placement${index}`,
  text: `Occurrence ${index}`,
}));
const facts = sources.flatMap((source) =>
  [
    [source.id + '#f', ':instance', 'fail-01'],
    [source.id + '#f', '@source', source.id],
    [source.id + '#f', '@node', 'f'],
  ].map((triple) => ({ triple, sourceIds: [source.id] })),
);
const material = {
  sources,
  sourceGraphs: sources.map((source, i) => ({
    sourceId: source.id,
    graph: graphs[i],
    revision: graphRevision(graphs[i]),
  })),
  facts,
  skipped: [],
  nodes: sources.map((source) => ({ id: source.id + '#f', sourceId: source.id })),
  rules: [
    {
      id: 'owner',
      name: 'Original occurrence',
      when: [
        ['?f', ':instance', 'fail-01'],
        ['?f', '@source', 's1'],
      ],
      then: [['?f', '@label', 'selected']],
    },
  ],
};
const binding = {
  id: 'joined',
  name: 'Selected failure',
  attribution: 'Explicitly reviewed identity',
  scopePlacementId: 'scope',
  references: sources.map((source, i) => ({
    text: source.text,
    nodeId: source.nodeId,
    sourceNodeId: 'f',
    graphRevision: graphRevision(graphs[i]),
  })),
};
assert.equal(
  bindReferences(material, [], () => true).bindings.length,
  0,
  'Shared concepts do not install identity',
);
const joined = bindReferences(material, [binding], () => true);
assert.equal(joined.bindings.length, 1);
assert(
  joined.facts.some(
    (fact) => JSON.stringify(fact.triple) === JSON.stringify(['s1#f', '@source', 's1']),
  ),
);
assert(
  !joined.facts.some(
    (fact) => JSON.stringify(fact.triple) === JSON.stringify(['s0#f', '@source', 's1']),
  ),
);
const inferred = inferRelations(joined.facts, joined.rules);
assert(
  inferred.facts.some(
    (fact) => JSON.stringify(fact.triple) === JSON.stringify(['s0#f', '@label', 'selected']),
  ),
);
assert.equal(bindReferences(material, [binding], () => false).bindings.length, 0);
const stale = structuredClone(binding);
stale.references[0].graphRevision = 'changed';
assert.equal(
  bindReferences(material, [stale], () => true).skipped[0].kind,
  'reference changed or unavailable',
);

for (const boundary of [
  'possible-01',
  'report-01',
  'say-01',
  'tell-01',
  'quote-01',
  'think-01',
  'believe-01',
]) {
  const guarded = structuredClone(material);
  const effective = guarded.sourceGraphs[1].graph;
  effective.nodes.push({ id: 'p', concept: boundary });
  effective.top = 'p';
  effective.edges.push({ id: 'e0', from: 'p', role: ':ARG1', to: 'f' });
  guarded.sourceGraphs[1].revision = graphRevision(effective);
  const reviewed = structuredClone(binding);
  reviewed.references[1].graphRevision = graphRevision(effective);
  assert.equal(
    bindReferences(guarded, [reviewed], () => true).skipped[0].kind,
    'reference assertion boundary',
  );
}

const amr = (id, top, concepts, edges) => ({
  id,
  top,
  nodes: Object.entries(concepts).map(([id, concept]) => ({ id, concept })),
  edges: edges.map(([from, role, to], index) => ({ id: `e${index}`, from, role, to })),
});
const paid = amr('paid', 'p', { p: 'pay-01', i: 'i', b: 'bill' }, [
  ['p', ':ARG0', 'i'],
  ['p', ':ARG1', 'b'],
]);
const access = amr('access', 'a', { a: 'access-01', i: 'i', c: 'account', neg: '-' }, [
  ['a', ':ARG0', 'i'],
  ['a', ':ARG1', 'c'],
  ['a', ':polarity', 'neg'],
]);
const caseSources = [
  { id: 'access', nodeId: 'case', text: 'I did not access the account.', graphId: 'access' },
  { id: 'paid', nodeId: 'case', text: 'I paid the bill.', graphId: 'paid' },
];
const run = (material) => {
  const iterator = searchCompositions({
    facts: material.facts,
    rules: material.rules,
    goals: material.pattern.patterns,
  });
  let step;
  do {
    step = iterator.next();
  } while (!step.done);
  return step.value;
};
for (const ordered of [caseSources, [...caseSources].reverse()]) {
  const recording = {
    project: { placementId: 'scope' },
    caseState: { rootNodeId: 'case' },
    inquiry: { text: 'Did I pay the bill?', graphId: 'q' },
    sources: ordered,
    graphs: [{ ...paid, id: 'q' }, paid, access],
  };
  const result = evaluateAnswer(recording);
  assert.equal(
    result.status,
    'supported',
    'An unrelated negative sentence cannot guard the positive case assertion',
  );
  assert.deepEqual(
    result.answers.map((answer) => answer.text),
    ['Yes'],
  );
  const searched = run(compositionMaterial(recording, {}));
  assert(searched.complete);
  assert(
    searched.proofs.length,
    'Backward search must use the unguarded occurrence in either order',
  );
  const material = answerMaterial(recording);
  const rule = {
    id: 'paid-rule',
    name: 'Read the positive case assertion',
    when: compositionMaterial(recording, {}).pattern.patterns,
    then: [['answer', '@label', 'paid']],
  };
  assert(
    inferRelations(material.facts, [rule]).facts.some((fact) => fact.triple[0] === 'answer'),
    'Forward rules must also use a valid alternative occurrence',
  );
  const onlyNegative = {
    ...recording,
    sources: [caseSources[0]],
    inquiry: { text: 'Did I access the account?', graphId: 'q' },
    graphs: [
      amr('q', 'a', { a: 'access-01', i: 'i', c: 'account' }, [
        ['a', ':ARG0', 'i'],
        ['a', ':ARG1', 'c'],
      ]),
      access,
    ],
  };
  assert.equal(
    evaluateAnswer(onlyNegative).answers[0].text,
    'No',
    'Negative-only evidence must retain its polarity',
  );
}

// Identity does not make a reported destination an asserted destination.
for (const reporting of ['say-01', 'tell-01', 'quote-01', 'think-01', 'believe-01']) {
  const actual = amr('actual', 'g', { g: 'go-01', p: 'person' }, [['g', ':ARG0', 'p']]);
  const reported = amr('reported', 'r', { r: reporting, g: 'go-01', p: 'person', city: 'city' }, [
    ['r', ':ARG1', 'g'],
    ['g', ':ARG0', 'p'],
    ['g', ':destination', 'city'],
  ]);
  const recording = {
    project: { placementId: 'scope' },
    inquiry: { text: 'Where does the person go?', graphId: 'q' },
    graphs: [
      amr('q', 'g', { g: 'go-01', p: 'person', city: 'amr-unknown' }, [
        ['g', ':ARG0', 'p'],
        ['g', ':destination', 'city'],
      ]),
      actual,
      reported,
    ],
    sources: [
      { id: 'actual', nodeId: 'scope', text: 'The person goes.', graphId: 'actual' },
      {
        id: 'reported',
        nodeId: 'scope',
        text: `${reporting}: the person goes to the city.`,
        graphId: 'reported',
      },
    ],
  };
  const bindings = ['g', 'p'].map((sourceNodeId) => ({
    id: sourceNodeId,
    name: 'Reviewed identity',
    attribution: 'Identity only',
    scopePlacementId: 'scope',
    references: recording.sources.map((source) => ({
      text: source.text,
      nodeId: source.nodeId,
      sourceNodeId,
      graphRevision: graphRevision(recording.graphs.find((graph) => graph.id === source.graphId)),
    })),
  }));
  const result = evaluateAnswer(recording, { bindings });
  assert.equal(result.status, 'open', reporting);
  assert(
    result.skipped.some(
      (item) => item.bindingId === 'g' && item.kind === 'reference assertion boundary',
    ),
  );
  assert.equal(run(compositionMaterial(recording, { bindings })).proofs.length, 0, reporting);
}
console.log(
  'ok scoped identity preserves occurrence ownership and rejects changed, modal and reported event bindings',
);
