/** Frozen original compound reading, coherent partial proofs, and scope controls. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareGraphs } from '../../src/models/graph-preparation.mjs';
import { evaluateAnswer } from '../../src/recording/answers.mjs';
import { originalHandPenman } from '../support/original-hand-question.mjs';
import { connectQuestion } from '../../src/amr/development.mjs';

const graph = (id, top, nodes, edges) => ({
  id,
  top,
  nodes: Object.entries(nodes).map(([id, value]) => ({
    id,
    ...(typeof value === 'string' ? { concept: value } : value),
  })),
  edges: edges.map(([from, role, to], index) => ({ id: `e${index}`, from, role, to })),
});
const assess = (query, sources, options) =>
  evaluateAnswer(
    {
      inquiry: { text: 'The entire question remains unchanged.', graphId: query.id },
      graphs: [query, ...sources.map((source) => source.graph)],
      sources: sources.map((source, index) => ({
        id: `source${index}`,
        nodeId: `placement${index}`,
        sentenceId: `sentence${index}`,
        revision: `revision${index}`,
        text: source.text ?? `Source ${index}`,
        graphId: source.graph.id,
        ...(source.development ? { development: source.development } : {}),
      })),
    },
    {},
    options,
  );

const fetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('Frozen partial coverage cannot acquire new meaning');
};
try {
  // Exact original reading already preserved by the lexical-audit regression.
  // Its misspelled interaction and acquired intercede frame are not repaired.
  const prepared = (await prepareGraphs([{ penman: originalHandPenman }])).results[0];
  assert(prepared.ok);
  const question = { ...prepared.graph, id: 'original-compound' };
  const frozen = JSON.parse(
    await readFile(new URL('../support/qa-domain-fixtures.json', import.meta.url), 'utf8'),
  );
  const sourceTexts = [
    'The programmer recognizes intention in the resulting design.',
    'The programmer recognizes intention in a larger design.',
  ];
  const sources = sourceTexts.map((text, index) => ({
    text,
    graph: { ...frozen.graphs.find((entry) => entry.text === text).graph, id: `reading${index}` },
  }));
  const before = JSON.stringify({ question, sources });
  const original = assess(question, sources);
  assert.equal(original.status, 'open');
  assert.deepEqual(original.answers, []);
  assert.equal(original.partial.complete, true);
  assert.equal(original.partial.parts.length, 2);
  for (const part of original.partial.parts) {
    assert.deepEqual(part.edgeIds, ['e3', 'e5', 'e7', 'e9']);
    assert(part.derivation, 'Each partial graph has an actual HRG query derivation');
    assert.equal(part.sourceIds.length, 1, 'Independent occurrences never become one event');
    assert.equal(part.dependencies.length, 1);
    assert.equal(part.dependencies[0].revision, `revision${part.sourceIds[0].slice(-1)}`);
    assert(part.dependencies[0].graphRevision);
    assert.deepEqual(part.qualifications, [sources[Number(part.sourceIds[0].slice(-1))].text]);
    assert(
      part.graph.edges.every((edge) =>
        question.edges.some(
          (item) => item.id === edge.id && item.from === edge.from && item.to === edge.to,
        ),
      ),
    );
    assert(!part.nodeIds.includes('z6'), 'No possessive identity is invented');
    assert(!part.nodeIds.includes('z13'), 'Disconnected touchability is not recognition support');
  }
  assert.deepEqual(
    original.partial.openings.map((opening) => opening.edgeId),
    ['e11', 'e13', 'e15', 'e17', 'e19', 'e21', 'e23', 'e25'],
  );
  assert.deepEqual(
    original.openings.filter((opening) => opening.kind === 'relation').map((opening) => opening.id),
    ['e11', 'e13', 'e15', 'e17', 'e19', 'e21', 'e23', 'e25'],
    'Supported core relations do not also appear as missing connections',
  );
  assert(original.partial.openings.every((opening) => opening.anchor.edgeId === opening.edgeId));
  assert.equal(JSON.stringify({ question, sources }), before);
  assert.equal(
    assess(question, []).partial.parts.length,
    0,
    'Withdrawal removes every dependent part',
  );
  assert.equal(assess(question, sources.slice(0, 1)).partial.parts.length, 1);
  assert.equal(
    assess(
      question,
      sources.map((source) => ({ ...source, development: { asserted: false } })),
    ).partial.parts.length,
    0,
    'A retained question is never evidence',
  );

  const compound = graph(
    'compound',
    'r',
    { r: 'repair-01', p: 'person', b: 'bicycle', w: 'workshop' },
    [
      ['r', ':ARG0', 'p'],
      ['r', ':ARG1', 'b'],
      ['r', ':location', 'w'],
    ],
  );
  const repair = graph('repair', 'r', { r: 'repair-01', p: 'person', b: 'bicycle' }, [
    ['r', ':ARG0', 'p'],
    ['r', ':ARG1', 'b'],
  ]);
  const supported = assess(compound, [{ graph: repair }]);
  assert.deepEqual(supported.partial.parts[0].edgeIds, ['e0', 'e1']);
  const negative = structuredClone(repair);
  negative.nodes.push({ id: 'minus', concept: '-', literal: '-' });
  negative.edges.push({ id: 'polarity', from: 'r', role: ':polarity', to: 'minus' });
  assert.equal(
    assess(compound, [{ graph: negative }]).partial.parts.length,
    0,
    'Negative source scope cannot be dropped',
  );
  const negativeQuestion = structuredClone(compound);
  negativeQuestion.nodes.push({ id: 'minus', concept: '-', literal: '-' });
  negativeQuestion.edges.push({ id: 'polarity', from: 'r', role: ':polarity', to: 'minus' });
  assert.equal(
    assess(negativeQuestion, [{ graph: repair }]).partial.parts.length,
    0,
    'Query polarity is mandatory in every partial root',
  );
  const negativePart = assess(negativeQuestion, [{ graph: negative }]).partial.parts[0];
  assert(negativePart.edgeIds.includes('polarity'));
  const modal = structuredClone(repair);
  modal.top = 'possible';
  modal.nodes.push({ id: 'possible', concept: 'possible-01' });
  modal.edges.push({ id: 'modality', from: 'possible', role: ':ARG1', to: 'r' });
  assert.equal(
    assess(compound, [{ graph: modal }]).partial.parts.length,
    0,
    'An embedded possible event is not an asserted repair',
  );

  const split = assess(compound, [
    { graph: graph('actor', 'r', { r: 'repair-01', p: 'person' }, [['r', ':ARG0', 'p']]) },
    { graph: graph('theme', 'r', { r: 'repair-01', b: 'bicycle' }, [['r', ':ARG1', 'b']]) },
  ]);
  assert.equal(split.partial.parts.length, 2);
  assert(
    split.partial.parts.every((part) => part.sourceIds.length === 1 && part.edgeIds.length === 1),
  );
  assert(
    split.partial.parts.every((part) => part.openings.length === 2),
    'Each part retains its own missing joins',
  );
  const splitQuestion = structuredClone(compound);
  splitQuestion.nodes = splitQuestion.nodes.filter((node) => node.id !== 'w');
  splitQuestion.edges = splitQuestion.edges.filter((edge) => edge.id !== 'e2');
  assert(
    assess(splitQuestion, [
      { graph: graph('actor', 'r', { r: 'repair-01', p: 'person' }, [['r', ':ARG0', 'p']]) },
      { graph: graph('theme', 'r', { r: 'repair-01', b: 'bicycle' }, [['r', ':ARG1', 'b']]) },
    ]).partial.openings.some((opening) => opening.kind === 'connection'),
  );

  const describedActor = graph(
    'described-actor',
    'o',
    { o: 'obligate-01', c: 'check-01', p: 'person', d: 'clerk-01', l: 'label-01', w: 'room' },
    [
      ['o', ':ARG1', 'c'],
      ['c', ':ARG0', 'p'],
      ['p', ':ARG0-of', 'd'],
      ['d', ':ARG1', 'l'],
      ['c', ':location', 'w'],
    ],
  );
  const clerk = structuredClone(describedActor);
  clerk.id = 'clerk';
  clerk.nodes = clerk.nodes.filter((node) => node.id !== 'w');
  clerk.edges = clerk.edges.filter((edge) => edge.id !== 'e4');
  const actorBefore = JSON.stringify({ describedActor, clerk });
  for (const [descriptor, theme] of [
    ['inspect-01', 'seal-01'],
    ['clerk-01', 'seal-01'],
  ]) {
    const unrelated = structuredClone(clerk);
    unrelated.id = 'unrelated';
    unrelated.nodes.find((node) => node.id === 'd').concept = descriptor;
    unrelated.nodes.find((node) => node.id === 'l').concept = theme;
    const unrelatedBefore = JSON.stringify(unrelated);
    const rejected = assess(describedActor, [{ graph: unrelated }]);
    assert(
      rejected.partial.parts.every((part) => !part.nodeIds.includes('p')),
      'A generic actor cannot lose its nominal descriptor or descriptor theme',
    );
    assert.equal(JSON.stringify(unrelated), unrelatedBefore);
  }
  const anonymous = structuredClone(clerk);
  anonymous.nodes = anonymous.nodes.filter((node) => !['d', 'l'].includes(node.id));
  anonymous.edges = anonymous.edges.filter((edge) => !['e2', 'e3'].includes(edge.id));
  assert(
    assess(describedActor, [{ graph: anonymous }]).partial.parts.every(
      (part) => !part.nodeIds.includes('p'),
    ),
    'A source with no nominal descriptor cannot bind the described actor',
  );
  const attributed = assess(describedActor, [{ graph: clerk }]);
  const actorPart = attributed.partial.parts.find((part) => part.edgeIds.includes('e1'));
  assert(actorPart, 'The correctly described actor still supports a partial check branch');
  assert.deepEqual(actorPart.edgeIds, ['e0', 'e1', 'e2', 'e3']);
  assert.deepEqual(actorPart.sourceIds, ['source0']);
  assert.equal(actorPart.dependencies[0].revision, 'revision0');
  assert(actorPart.derivation);
  assert.equal(JSON.stringify({ describedActor, clerk }), actorBefore);

  const namedQuestion = structuredClone(compound);
  namedQuestion.nodes.push(
    { id: 'name', concept: 'name' },
    { id: 'text', concept: 'Jo', literal: '"Jo"' },
  );
  namedQuestion.edges.push(
    { id: 'name', from: 'p', role: ':name', to: 'name' },
    { id: 'literal', from: 'name', role: ':op1', to: 'text' },
  );
  const named = assess(namedQuestion, [{ graph: repair }]);
  assert(
    named.partial.parts.every((part) => !part.nodeIds.includes('p')),
    'Named identity cannot be discarded to match an anonymous participant',
  );

  const typedQuestion = graph(
    'who',
    'r',
    { r: 'protect-01', p: { concept: 'amr-unknown', semanticTypes: ['agent'] }, f: 'refuse-01' },
    [
      ['r', ':ARG1', 'p'],
      ['r', ':ARG0', 'f'],
    ],
  );
  const boundary = graph(
    'boundary',
    'r',
    { r: 'protect-01', p: { concept: 'boundary', semanticTypes: ['entity'] }, f: 'refuse-01' },
    [
      ['r', ':ARG1', 'p'],
      ['r', ':ARG0', 'f'],
    ],
  );
  const mistyped = assess(typedQuestion, [{ graph: boundary }]);
  assert.equal(
    mistyped.status,
    'open',
    'Who cannot bind a non-agent merely because the role matches',
  );
  assert(mistyped.partial.parts.every((part) => !part.nodeIds.includes('p')));
  const person = structuredClone(boundary);
  person.nodes.find((node) => node.id === 'p').semanticTypes = ['agent'];
  person.nodes.find((node) => node.id === 'p').concept = 'person';
  assert.equal(assess(typedQuestion, [{ graph: person }]).status, 'supported');
  const entityQuestion = structuredClone(typedQuestion);
  entityQuestion.nodes.find((node) => node.id === 'p').semanticTypes = ['entity'];
  for (const type of ['agent', 'place', 'time', 'quantity', 'event']) {
    const specialized = structuredClone(person);
    specialized.nodes.find((node) => node.id === 'p').semanticTypes = [type];
    assert.equal(
      assess(entityQuestion, [{ graph: specialized }]).status,
      'supported',
      `${type} is an entity without requiring a redundant acquisition annotation`,
    );
    assert(
      connectQuestion(entityQuestion, specialized).matches.length,
      'Graph interface facts use the same type inclusion as answer checking',
    );
  }
  const unannotated = structuredClone(boundary);
  delete unannotated.nodes.find((node) => node.id === 'p').semanticTypes;
  assert.equal(
    assess(entityQuestion, [{ graph: unannotated }]).status,
    'supported',
    'Entity is universal even without optional type metadata',
  );
  assert.equal(
    assess(typedQuestion, [{ graph: unannotated }]).status,
    'open',
    'Universal entity never implies agent',
  );
  const literal = structuredClone(boundary);
  Object.assign(
    literal.nodes.find((node) => node.id === 'p'),
    { concept: '3', literal: '3', semanticTypes: ['quantity'] },
  );
  assert.equal(
    assess(entityQuestion, [{ graph: literal }]).answers[0].text,
    '3',
    'Literal quantities remain graph entities',
  );
  const partialEntity = structuredClone(entityQuestion);
  partialEntity.nodes.push({ id: 'location', concept: 'unavailable-place' });
  partialEntity.edges.push({ id: 'location', from: 'r', role: ':location', to: 'location' });
  assert(
    assess(partialEntity, [{ graph: person }]).partial.parts.some((part) =>
      part.nodeIds.includes('p'),
    ),
    'A partial match retains the entity slot bound to a specialized agent',
  );
  const conditional = graph(
    'conditional',
    'r',
    {
      r: 'protect-01',
      p: { concept: 'person', semanticTypes: ['agent'] },
      f: 'refuse-01',
      ready: { concept: 'ready-01', semanticTypes: ['event'] },
    },
    [
      ['r', ':ARG1', 'p'],
      ['r', ':ARG0', 'f'],
      ['r', ':condition', 'ready'],
    ],
  );
  const premise = graph('premise', 'ready', { ready: 'ready-01' }, []);
  const consequent = assess(typedQuestion, [{ graph: conditional }, { graph: premise }]);
  assert.equal(
    consequent.status,
    'supported',
    'A fresh conditional participant retains its acquired answer type',
  );
  assert(consequent.answers[0].ruleIds.length);
  assert.equal(
    assess(entityQuestion, [{ graph: conditional }, { graph: premise }]).status,
    'supported',
    'Fresh conditional agents also carry the universal entity category',
  );
  assert.equal(
    assess(typedQuestion, [{ graph: conditional }]).status,
    'open',
    'Type metadata never supplies the missing condition',
  );
  assert.equal(
    assess(compound, [{ graph: repair }], { partialCoverage: { stateLimit: 0 } }).partial.complete,
    false,
  );
  console.log(
    'ok original compound partial proofs, exact residual anchors, source dependencies, role/identity/guard boundaries and typed answer slots',
  );
} finally {
  globalThis.fetch = fetch;
}
