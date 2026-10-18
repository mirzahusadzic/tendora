/** Part identity follows occurrences and rule applications, never traversal counters. */
import assert from 'node:assert/strict';
import { evaluateAnswer } from '../../src/recording/answers.mjs';
import { mergePartialContribution } from '../../src/project/authoring/partial.mjs';
const graph = (id, nodes, edges, top = 'r') => ({
  id,
  top,
  nodes: Object.entries(nodes).map(([id, concept]) => ({ id, concept })),
  edges: edges.map(([from, role, to], index) => ({ id: `e${index}`, from, role, to })),
});
const query = graph('query', { r: 'repair-01', p: 'person', b: 'bicycle', w: 'workshop' }, [
  ['r', ':ARG0', 'p'],
  ['r', ':ARG1', 'b'],
  ['r', ':location', 'w'],
]);
const repair = graph('repair', { r: 'repair-01', p: 'person', b: 'bicycle' }, [
  ['r', ':ARG0', 'p'],
  ['r', ':ARG1', 'b'],
]);
const ready = graph('ready', { r: 'ready-01', b: 'bicycle' }, [['r', ':ARG1', 'b']]);
const conditional = graph(
  'conditional',
  { r: 'repair-01', p: 'person', b: 'bicycle', s: 'ready-01' },
  [
    ['r', ':ARG0', 'p'],
    ['r', ':ARG1', 'b'],
    ['r', ':condition', 's'],
    ['s', ':ARG1', 'b'],
  ],
);
const assess = (sources, question = query, options) =>
  evaluateAnswer(
    {
      inquiry: { text: 'Does a person repair a bicycle in a workshop?', graphId: question.id },
      graphs: [question, ...sources],
      sources: sources.map((source, index) => ({
        id: `temporary-${index}`,
        graphId: source.id,
        text: source.id,
        nodeId: 'workshop',
        sentenceId: source.id,
        revision: 'frozen',
      })),
      project: { placementId: 'workshop' },
    },
    {},
    options,
  ).partial;
const fetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('Identity checks must be offline');
};
try {
  const first = assess([repair, conditional, ready]);
  const reorder = assess([ready, conditional, repair], {
    ...query,
    nodes: [...query.nodes].reverse(),
    edges: [...query.edges].reverse(),
  });
  assert(first.parts.some((part) => part.ruleIds.length));
  assert.deepEqual(
    first.parts.map((part) => part.id).sort(),
    reorder.parts.map((part) => part.id).sort(),
  );
  assert.deepEqual(
    first.openings.map((opening) => opening.identity).sort(),
    reorder.openings.map((opening) => opening.identity).sort(),
  );
  const contribution = { id: 'owned', scopePlacementId: 'workshop', question: { graph: query } };
  contribution.partial = mergePartialContribution(contribution, first);
  const second = mergePartialContribution(contribution, reorder);
  assert(
    second.parts.every((part) => part.evidenceHistory.length === 1),
    'Neither rule IDs nor generated participant counters leak into history',
  );
  const relocated = mergePartialContribution(
    { ...contribution, scopePlacementId: 'another-scope' },
    first,
  );
  assert.equal(relocated.invalidation, 'scope-changed');
  assert(relocated.parts.every((part) => !part.current && part.scope.placementId === 'workshop'));
  const revised = structuredClone(contribution);
  revised.question.graph.edges.find((edge) => edge.role === ':location').role = ':destination';
  const invalidated = mergePartialContribution(revised, first);
  assert.equal(invalidated.invalidation, 'question-changed');
  assert(invalidated.parts.every((part) => !part.current));
  assert.equal(invalidated.questionRevision, contribution.partial.questionRevision);

  const ambiguous = structuredClone(repair);
  ambiguous.nodes.push({ id: 'other', concept: 'bicycle' });
  ambiguous.edges.push({ id: 'another', from: 'r', role: ':ARG1', to: 'other' });
  const variants = assess([ambiguous]);
  assert.equal(variants.parts.length, 2);
  const owned = mergePartialContribution({ ...contribution, partial: undefined }, variants);
  assert.equal(owned.parts.length, 1, 'One root occurrence owns its distinct proof alternatives');
  assert.equal(owned.parts[0].supports.length, 2);
  assert.notDeepEqual(owned.parts[0].supports[0].bindings, owned.parts[0].supports[1].bindings);
  assert(
    owned.parts[0].supports.every((proof) => proof.bindings.length === 3),
    'Distinct participants are never unioned into one proof',
  );

  const full = { ...query, id: repair.id };
  const complete = assess([full], query, { retainPartialCoverage: true });
  assert.equal(complete.resolved, true);
  assert.deepEqual(
    complete.openings,
    [],
    'A complete attributed assertion does not manufacture an unjoined aporia',
  );
  const closed = mergePartialContribution(
    { ...contribution, partial: mergePartialContribution(contribution, assess([repair])) },
    complete,
  );
  assert.equal(closed.parts.filter((part) => part.current).length, 1);
  assert(closed.aporias.every((opening) => opening.state === 'supported'));
  assert.equal(
    closed.parts[0].evidenceHistory.length,
    2,
    'Branch growth preserves its owner and records the changed support',
  );
  console.log(
    'ok stable query/source ordering, generated participant provenance, separate ambiguous proofs and complete-assertion closure',
  );
} finally {
  globalThis.fetch = fetch;
}
