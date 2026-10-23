import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inferRelations, validateRule } from '../../src/amr/inference.mjs';
import { graphRevision } from '../../src/recording/revisions.mjs';
import { evaluateAnswer } from '../../src/recording/answers.mjs';
import { prepareGraphs } from '../../src/models/graph-preparation.mjs';

const graph = (id, top, nodes, edges) => ({
  id,
  top,
  nodes: Object.entries(nodes).map(([id, concept]) => ({ id, concept })),
  edges: edges.map(([from, role, to], i) => ({ id: `e${i}`, from, role, to })),
});
const record = (query, sources) => ({
  inquiry: { text: 'Unchanged question', graphId: query.id },
  project: { placementId: 'root' },
  graphs: [query, ...sources.map((item) => item.graph)],
  sources: sources.map((item, i) => ({
    id: `s${i}`,
    nodeId: item.nodeId ?? 'root',
    text: item.text,
    graphId: item.graph.id,
  })),
});
const query = graph('q', 'a', { a: 'design', who: 'amr-unknown', thing: 'device' }, [
  ['a', ':ARG0', 'who'],
  ['a', ':ARG1', 'thing'],
]);
const source = graph('s', 'act', { act: 'design-01', person: 'person', object: 'device' }, [
  ['act', ':ARG0', 'person'],
  ['act', ':ARG1', 'object'],
]);
const base = record(query, [{ text: 'A person designed a device.', graph: source }]);
assert.equal(evaluateAnswer(base).status, 'open');
// Modality: a requirement (“must”) answers “should”; permission (“may”), a
// plain statement of what is done, and a recommendation do not answer more.
const rotation = (id, modal, modalRole) =>
  graph(
    id,
    modal ? 'm' : 'r',
    {
      ...(modal ? { m: modal } : {}),
      r: 'rotate-01',
      p: 'person',
      n: 'name',
      k: 'key',
    },
    [
      ...(modal ? [['m', modalRole, 'r']] : []),
      ['r', ':ARG0', 'p'],
      ['p', ':name', 'n'],
      ['r', ':ARG1', 'k'],
    ],
  );
const named = (g) => {
  g.nodes.push({ id: 'priya', concept: '"Priya"', literal: '"Priya"' });
  g.edges.push({ id: 'op', from: 'n', role: ':op1', to: 'priya' });
  return g;
};
const asking = (modal, modalRole) =>
  graph(`ask-${modal}`, 'm', { m: modal, r: 'rotate-01', u: 'amr-unknown', k: 'key' }, [
    ['m', modalRole, 'r'],
    ['r', ':ARG0', 'u'],
    ['r', ':ARG1', 'k'],
  ]);
const modalAnswer = (question, modal, modalRole) =>
  evaluateAnswer(
    record(question, [
      { text: 'Priya rotates the key.', graph: named(rotation(`src-${modal}`, modal, modalRole)) },
    ]),
  );
const should = asking('recommend-01', ':ARG1'),
  must = asking('obligate-01', ':ARG2');
const required = modalAnswer(should, 'obligate-01', ':ARG2');
assert.equal(required.status, 'supported', 'must answers should');
assert.deepEqual(
  required.answers.map((answer) => [answer.text, answer.readAs]),
  [['Priya', 'requirement']],
);
assert.equal(modalAnswer(must, 'obligate-01', ':ARG2').answers[0].readAs, undefined);
// A yes/no “should” keeps its marker; a negated “should” has no requirement reading.
const yesNo = (polarity) =>
  graph(
    `should-${polarity}`,
    'm',
    { m: 'recommend-01', r: 'rotate-01', p: 'person', k: 'key', y: polarity },
    [
      ['m', ':ARG1', 'r'],
      ['m', ':polarity', 'y'],
      ['r', ':ARG0', 'p'],
      ['r', ':ARG1', 'k'],
    ],
  );
const confirmed = modalAnswer(yesNo('amr-unknown'), 'obligate-01', ':ARG2');
assert.deepEqual(
  confirmed.answers.map((answer) => [answer.polarity, answer.readAs]),
  [['positive', 'requirement']],
);
assert.equal(
  modalAnswer(yesNo('-'), 'obligate-01', ':ARG2').answers.length,
  0,
  'Not recommended is not the same as not required',
);
for (const [question, modal, role, reason] of [
  [should, 'possible-01', ':ARG1', 'may does not answer should'],
  [must, 'possible-01', ':ARG1', 'may does not answer must'],
  [should, null, null, 'what is done does not answer should'],
  [must, 'recommend-01', ':ARG1', 'should does not answer must'],
]) {
  const result = modalAnswer(question, modal, role);
  assert.equal(result.status, 'open', reason);
  assert.equal(result.answers.length, 0, reason);
}
// A date or time answer reads by its parts, not as "date-entity".
const collection = graph(
  'collect',
  'c',
  { c: 'collect-01', v: 'van', d: 'date-entity', p: 'afternoon' },
  [
    ['c', ':ARG0', 'v'],
    ['c', ':time', 'd'],
    ['d', ':dayperiod', 'p'],
  ],
);
collection.nodes.push({ id: 't', concept: '16:00', literal: '"16:00"' });
collection.edges.push({ id: 'time', from: 'd', role: ':time', to: 't' });
const when = graph('when', 'c', { c: 'collect-01', v: 'van', u: 'amr-unknown' }, [
  ['c', ':ARG0', 'v'],
  ['c', ':time', 'u'],
]);
assert.deepEqual(
  evaluateAnswer(
    record(when, [{ text: 'The van collects at four in the afternoon.', graph: collection }]),
  ).answers.map((answer) => answer.text),
  ['16:00, afternoon'],
);
const alias = {
  id: 'mapping',
  name: 'Authored design equivalence',
  attribution: 'Business terminology decision',
  sources: [],
  when: [['?event', ':instance', 'design-01']],
  then: [['?event', ':instance', 'design']],
};
const mapped = evaluateAnswer(base, { rules: [alias] });
assert.equal(mapped.status, 'supported');
assert.equal(mapped.answers[0].text, 'person');
assert.deepEqual(mapped.answers[0].ruleIds, ['mapping']);
assert.deepEqual(mapped.answers[0].sourceIds, ['s0']);
const alternative = structuredClone(source);
alternative.id = 's2';
alternative.nodes.find((node) => node.id === 'person').concept = 'organization';
const several = record(query, [
  { text: 'A person designed a device.', graph: source },
  { text: 'An organization designed a device.', graph: alternative },
]);
assert.equal(evaluateAnswer(several, { rules: [alias] }).status, 'ambiguous');
const answerSet = evaluateAnswer(
  { ...several, answerExpectation: { mode: 'set' } },
  { rules: [alias] },
);
assert.equal(answerSet.status, 'supported');
assert.deepEqual(
  new Set(answerSet.answers.map((answer) => answer.text)),
  new Set(['person', 'organization']),
);
const collectionQuestion = graph('collection-q', 'r', { r: 'repair-01', u: 'amr-unknown' }, [
  ['r', ':ARG1', 'u'],
]);
const collectionSource = graph(
  'collection-s',
  'r',
  { r: 'repair-01', c: 'and', b: 'bicycle', s: 'scooter' },
  [
    ['r', ':ARG1', 'c'],
    ['c', ':op1', 'b'],
    ['c', ':op2', 's'],
  ],
);
const collectionRecord = record(collectionQuestion, [
  { text: 'Bicycles and scooters are repaired.', graph: collectionSource },
]);
assert.equal(evaluateAnswer(collectionRecord).answers[0].text, 'bicycle and scooter');
collectionSource.nodes.find((node) => node.id === 'c').surfaceLabel = 'and';
assert.equal(evaluateAnswer(collectionRecord).answers[0].text, 'bicycle and scooter');
collectionSource.nodes.find((node) => node.id === 'c').authoredLabel = 'Bicycles and scooters.';
const labeledCollection = evaluateAnswer(collectionRecord);
assert.equal(labeledCollection.answers[0].text, 'Bicycles and scooters.');
assert.deepEqual(labeledCollection.answers[0].sourceIds, ['s0']);
assert.equal(labeledCollection.status, 'supported', 'Display labels do not change the proof');
const teamQuestion = graph('team-q', 'r', { r: 'repair-01', u: 'amr-unknown' }, [
  ['r', ':ARG0', 'u'],
]);
const teamSource = graph('team-s', 'r', { r: 'repair-01', t: 'team', b: 'blue' }, [
  ['r', ':ARG0', 't'],
  ['t', ':mod', 'b'],
]);
const teamRecord = record(teamQuestion, [{ text: 'The blue team repairs.', graph: teamSource }]);
const namedTeam = evaluateAnswer(teamRecord);
assert.equal(namedTeam.answers[0].text, 'blue team');
teamRecord.sources[0].text = 'A team repairs.';
const bareTeam = evaluateAnswer(teamRecord);
assert.equal(bareTeam.answers[0].text, 'team', 'Do not invent a phrase absent from the source');
assert.equal(bareTeam.answers[0].bindings[0].id, namedTeam.answers[0].bindings[0].id);
assert.deepEqual(bareTeam.answers[0].sourceIds, namedTeam.answers[0].sourceIds);

// A witnessed instrumental descriptor is part of the answer phrase. The source
// says "payment key"; the graph keeps `key` as the head and `pay` as the
// instrument. Display must not narrow the answer to the bare head noun.
const instrumentQuestion = graph('instrument-question', 'r', { r: 'report-01', u: 'amr-unknown' }, [
  ['r', ':ARG1', 'u'],
]);
const instrumentSource = graph(
  'instrument-source',
  'r',
  { r: 'report-01', k: 'key', p: 'pay-01' },
  [
    ['r', ':ARG1', 'k'],
    ['p', ':instrument', 'k'],
  ],
);
const instrumentRecord = record(instrumentQuestion, [
  { text: 'Priya reports a payment key.', graph: instrumentSource },
]);
assert.equal(evaluateAnswer(instrumentRecord).answers[0].text, 'payment key');

// Nominal modifiers may be nested below the answer head. The complete source
// phrase remains presentation data and does not change the proof.
const nestedQuestion = graph('nested-question', 'r', { r: 'check-01', u: 'amr-unknown' }, [
  ['r', ':ARG1', 'u'],
]);
const nestedSource = graph(
  'nested-source',
  'r',
  { r: 'check-01', rate: 'rate', error: 'error-01', pay: 'pay-01' },
  [
    ['r', ':ARG1', 'rate'],
    ['rate', ':mod', 'error'],
    ['error', ':ARG1', 'pay'],
  ],
);
const nestedRecord = record(nestedQuestion, [
  { text: 'The operator checks the payment error rate.', graph: nestedSource },
]);
const nestedBefore = structuredClone(nestedRecord);
const nestedAnswer = evaluateAnswer(nestedRecord);
assert.equal(nestedAnswer.answers[0].text, 'payment error rate');
assert.deepEqual(nestedRecord, nestedBefore, 'Answer display does not rewrite the source graph');

// A parser can preserve the dependency while choosing the wrong lexical
// descriptor. Use the attributed source as the display boundary, not an alias.
const opaqueSource = graph(
  'opaque-source',
  'r',
  { r: 'keep-01', u: 'vault', thing: 'thing', tattoo: 'tattoo-01' },
  [
    ['r', ':ARG1', 'u'],
    ['u', ':mod', 'thing'],
    ['tattoo', ':ARG2', 'thing'],
  ],
);
const keepQuestion = graph('keep-question', 'r', { r: 'keep-01', u: 'amr-unknown' }, [
  ['r', ':ARG1', 'u'],
]);
const opaqueRecord = record(keepQuestion, [
  { text: 'The operator keeps the password vault.', graph: opaqueSource },
]);
assert.equal(evaluateAnswer(opaqueRecord).answers[0].text, 'password vault');

const hyphenSource = graph(
  'hyphen-source',
  'r',
  { r: 'keep-01', u: 'credential', glass: 'glass', break: 'break-01' },
  [
    ['r', ':ARG1', 'u'],
    ['u', ':mod', 'glass'],
    ['break', ':ARG1', 'glass'],
  ],
);
const hyphenRecord = record(keepQuestion, [
  { text: 'The operator keeps break-glass credentials.', graph: hyphenSource },
]);
assert.equal(evaluateAnswer(hyphenRecord).answers[0].text, 'break-glass credentials');

// Actual legacy AMRBART acquisition has a structural name without surfaceLabel.
const frozenNames = JSON.parse(
  await readFile(new URL('../support/theatre-acquisitions.json', import.meta.url)),
);
const frozenSam = frozenNames.entries.find((entry) => entry.text === 'Sam repairs bicycles.');
const preparedName = (await prepareGraphs([{ penman: frozenSam.acquisition.penman }])).results[0];
assert(preparedName.ok);
const nameSource = { ...preparedName.graph, id: 'retained-name-source' };
assert(nameSource.nodes.every((node) => !node.surfaceLabel));
const nameQuestion = graph(
  'named-question',
  'r',
  { r: 'repair-01', u: 'amr-unknown', b: 'bicycle' },
  [
    ['r', ':ARG0', 'u'],
    ['r', ':ARG1', 'b'],
  ],
);
const nameRecord = record(nameQuestion, [{ text: frozenSam.text, graph: nameSource }]);
const nameBefore = structuredClone(nameRecord);
const namedPerson = evaluateAnswer(nameRecord);
assert.equal(namedPerson.status, 'supported');
assert.equal(namedPerson.answers[0].text, 'Sam');
assert.deepEqual(namedPerson.answers[0].bindings, [{ id: 's0#z1', text: 'Sam' }]);
assert.deepEqual(namedPerson.answers[0].sourceIds, ['s0']);
assert.deepEqual(namedPerson.answers[0].ruleIds, []);
assert.deepEqual(
  nameRecord,
  nameBefore,
  'Displaying a retained name must not alter its graph or source',
);
const otherName = structuredClone(nameRecord);
const nameLiteral = otherName.graphs[1].nodes.find((node) => node.literal === '"Sam"');
nameLiteral.literal = '"Alex"';
nameLiteral.concept = 'Alex';
otherName.sources[0].text = 'Alex repairs bicycles.';
const renamedPerson = evaluateAnswer(otherName);
assert.equal(
  renamedPerson.answers[0].text,
  'Alex',
  'Names are read from this bound participant, not vocabulary',
);
assert.equal(renamedPerson.status, namedPerson.status);
assert.equal(renamedPerson.answers[0].bindings[0].id, namedPerson.answers[0].bindings[0].id);
assert.deepEqual(
  renamedPerson.answers[0].derivation,
  namedPerson.answers[0].derivation,
  'The question derivation is unaffected by display-only name literals',
);
const guardedName = {
  id: 'guarded-name',
  name: 'A name available only with its guard',
  when: [['?person', ':instance', 'person']],
  then: [
    ['?person', ':name', '$name'],
    ['$name', ':op1', '$part'],
    ['$part', '@literal', '"Unavailable"'],
  ],
  guards: [['?person', ':polarity', '-']],
};
const withoutGuard = evaluateAnswer(nameRecord, { rules: [guardedName] });
assert.equal(withoutGuard.status, 'supported');
assert.equal(withoutGuard.answers[0].text, 'Sam', 'Unwitnessed guards cannot add a display name');
assert.deepEqual(withoutGuard.answers[0].ruleIds, [], 'Unavailable label adds no answer support');
const fullName = structuredClone(nameRecord);
fullName.graphs[1].nodes.push({ id: 'surname', concept: 'Lee', literal: '"Lee"' });
fullName.graphs[1].edges.unshift({ id: 'surname-edge', from: 'z2', role: ':op2', to: 'surname' });
assert.equal(
  evaluateAnswer(fullName).answers[0].text,
  'Sam Lee',
  'Name parts use numeric op order, not edge order',
);

const narrowed = structuredClone(base);
narrowed.graphs[1].nodes.push({ id: 'qualification', concept: 'frequent-02' });
narrowed.graphs[1].edges.push({
  id: 'qualifier',
  from: 'qualification',
  role: ':ARG1',
  to: narrowed.graphs[1].top,
});
const qualified = evaluateAnswer(narrowed, { rules: [alias] });
assert.equal(
  qualified.status,
  'conditional',
  'A broader query cannot erase an unmatched source qualification',
);
assert.deepEqual(qualified.answers[0].qualifications, [base.sources[0].text]);

const renamed = structuredClone(base);
renamed.inquiry.text = 'By whom was the device designed?';
const changed = renamed.graphs[0];
changed.top = 'event';
const names = { a: 'event', who: 'answer', thing: 'target' };
changed.nodes.forEach((node) => {
  node.id = names[node.id];
});
changed.edges.reverse().forEach((edge) => {
  edge.from = names[edge.from];
  edge.to = names[edge.to];
});
assert.equal(
  evaluateAnswer(renamed, { rules: [alias] }).answers[0].text,
  'person',
  'Wording and graph node names do not select the answer',
);
changed.edges[0].role = ':ARG2';
assert.equal(
  evaluateAnswer(renamed, { rules: [alias] }).status,
  'open',
  'Changing the role changes the result',
);
const parseCorrection = {
  id: 'role-correction',
  revision: graphRevision(changed),
  attribution: 'Reviewed parser role correction',
  edits: [
    {
      kind: 'edge',
      id: changed.edges[0].id,
      from: changed.edges[0].from,
      to: changed.edges[0].to,
      role: ':ARG1',
    },
  ],
};
assert.equal(
  evaluateAnswer(renamed, { rules: [alias], queryParses: [parseCorrection] }).status,
  'supported',
);
const different = structuredClone(renamed);
different.graphs[0].nodes[0].concept = 'other';
assert.equal(
  evaluateAnswer(different, { rules: [alias], queryParses: [parseCorrection] }).questionParses
    .length,
  0,
  'A parser correction is guarded by the graph, never the question string',
);

const joinQuery = graph('q', 'event', { event: 'assign-01', person: 'amr-unknown', job: 'work' }, [
  ['event', ':ARG0', 'person'],
  ['event', ':ARG1', 'job'],
]);
const left = graph(
  'left',
  'eligible',
  { eligible: 'qualify-01', actor: 'person', category: 'specialty' },
  [
    ['eligible', ':ARG0', 'actor'],
    ['eligible', ':ARG1', 'category'],
  ],
);
const right = graph('right', 'need', { need: 'need-01', task: 'work', category: 'specialty' }, [
  ['need', ':ARG0', 'task'],
  ['need', ':ARG1', 'category'],
]);
const joined = record(joinQuery, [
  { text: 'A person has a specialty.', graph: left },
  { text: 'Work needs that specialty.', graph: right },
]);
const relation = {
  id: 'assignment',
  name: 'Assignment through an authored reference',
  attribution: 'Reviewed sentence interpretation',
  sources: [{ text: 'A person has a specialty.' }, { text: 'Work needs that specialty.' }],
  when: [
    ['?qualified', ':instance', 'qualify-01'],
    ['?qualified', ':ARG0', '?person'],
    ['?qualified', ':ARG1', '?specialty'],
    ['?need', ':instance', 'need-01'],
    ['?need', ':ARG0', '?job'],
    ['?need', ':ARG1', '?required'],
    ['?required', '@same', '?specialty'],
  ],
  then: [
    ['$assignment', ':instance', 'assign-01'],
    ['$assignment', ':ARG0', '?person'],
    ['$assignment', ':ARG1', '?job'],
    ['$assignment', '@asserted', 'true'],
  ],
};
assert.equal(
  evaluateAnswer(joined, { rules: [relation] }).status,
  'open',
  'Identical words do not establish a cross-reference',
);
const reference = {
  id: 'reference',
  name: 'Same specialty',
  attribution: 'Explicit reference decision',
  sources: relation.sources,
  when: [
    ['?left', '@text', 'A person has a specialty.'],
    ['?right', '@text', 'Work needs that specialty.'],
    ['?x', '@source', '?left'],
    ['?x', ':instance', 'specialty'],
    ['?y', '@source', '?right'],
    ['?y', ':instance', 'specialty'],
  ],
  then: [['?y', '@same', '?x']],
};
const answer = evaluateAnswer(joined, { rules: [reference, relation] });
assert.equal(answer.status, 'supported');
assert.deepEqual(new Set(answer.answers[0].sourceIds), new Set(['s0', 's1']));
assert.deepEqual(new Set(answer.answers[0].ruleIds), new Set(['reference', 'assignment']));
const missing = structuredClone(joined);
missing.sources.pop();
assert.equal(
  evaluateAnswer(missing, { rules: [reference, relation] }).status,
  'open',
  'Removing either premise removes the answer',
);

const yesQuery = graph('q', 'event', { event: 'act-01' }, []);
const possible = graph('s', 'possible', { possible: 'possible-01', event: 'act-01' }, [
  ['possible', ':ARG1', 'event'],
]);
assert.equal(
  evaluateAnswer(record(yesQuery, [{ text: 'The action may happen.', graph: possible }])).status,
  'open',
);
const conditionalRule = {
  id: 'may',
  name: 'Authored possibility interpretation',
  sources: [{ text: 'The action may happen.' }],
  when: [
    ['?possible', ':instance', 'possible-01'],
    ['?possible', '@asserted', 'true'],
    ['?possible', ':ARG1', '?event'],
    ['?event', ':instance', 'act-01'],
  ],
  then: [
    ['?event', '@asserted', 'conditional'],
    ['?event', '@qualification', 'May happen'],
  ],
};
const conditional = evaluateAnswer(
  record(yesQuery, [{ text: 'The action may happen.', graph: possible }]),
  { rules: [conditionalRule] },
);
assert.equal(conditional.status, 'conditional');
assert.equal(conditional.answers[0].text, 'May happen');
assert(conditional.answers[0].facts.some((fact) => fact.triple[1] === '@qualification'));
const questionAsSource = graph('s', 'event', { event: 'act-01', unknown: 'amr-unknown' }, [
  ['event', ':polarity', 'unknown'],
]);
assert.equal(
  evaluateAnswer(record(yesQuery, [{ text: 'Will it happen?', graph: questionAsSource }])).status,
  'open',
  'A source question is not an assertion',
);
const scoped = record(yesQuery, [
  { text: 'It happens in another case.', graph: graph('s', 'event', { event: 'act-01' }, []) },
]);
assert.equal(
  evaluateAnswer(scoped, {
    sourceScopes: [
      {
        text: scoped.sources[0].text,
        placementId: scoped.sources[0].nodeId,
        caseTexts: ['A different case.'],
      },
    ],
  }).status,
  'open',
);
const negative = graph('s', 'event', { event: 'act-01', minus: '-' }, [
  ['event', ':polarity', 'minus'],
]);
const no = evaluateAnswer(
  record(yesQuery, [{ text: 'The action does not happen.', graph: negative }]),
);
assert.equal(no.status, 'supported');
assert.equal(no.answers[0].text, 'No');
assert.equal(no.answers[0].polarity, 'negative');
const conflict = evaluateAnswer(
  record(yesQuery, [
    { text: 'The action does not happen.', graph: negative },
    { text: 'The action happens.', graph: graph('positive', 'event', { event: 'act-01' }, []) },
  ]),
);
assert.equal(conflict.status, 'conflict');
assert.deepEqual(new Set(conflict.candidates.map((answer) => answer.text)), new Set(['Yes', 'No']));
const negativeQuery = graph('q', 'event', { event: 'act-01', minus: '-' }, [
  ['event', ':polarity', 'minus'],
]);
assert.equal(
  evaluateAnswer(record(negativeQuery, [{ text: 'The action does not happen.', graph: negative }]))
    .status,
  'supported',
);
assert.throws(
  () => validateRule({ name: 'unbound', when: [['?x', 'p', 'v']], then: [['?missing', 'q', 'v']] }),
  /no premise/,
);
const loop = inferRelations(
  [{ triple: ['x', 'p', 'v'], sourceIds: [] }],
  [
    {
      id: 'loop',
      name: 'Recursive generator',
      when: [['?x', 'p', 'v']],
      then: [['$next', 'p', 'v']],
    },
  ],
  { maxRounds: 2 },
);
assert.equal(loop.complete, false, 'Evaluation limits never certify a result');
// A predicate bound as an answer reads by its attested word and the source's
// modifiers, never by its concept name.
const kept = graph('kept', 'k', { k: 'keep-01', r: 'registry', c: 'commit-01', p: 'public-02' }, [
  ['k', ':ARG0', 'r'],
  ['k', ':ARG1', 'c'],
  ['p', ':ARG1', 'c'],
]);
const keeps = graph('keeps', 'k', { k: 'keep-01', r: 'registry', w: 'amr-unknown' }, [
  ['k', ':ARG0', 'r'],
  ['k', ':ARG1', 'w'],
]);
const keptRecord = record(keeps, [{ text: 'The registry keeps public commitments.', graph: kept }]);
keptRecord.sources[0].readingLabels = { c: 'commitments' };
assert.equal(evaluateAnswer(keptRecord).answers[0].text, 'public commitments');
console.log(
  'ok AMR answers join attributed sentences, preserve identity/modality/polarity and reuse business mappings across phrasings',
);
