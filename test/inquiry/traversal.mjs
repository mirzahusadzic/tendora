/** Offline contract checks for the graph boundary. No model or test runner. */
import assert from 'node:assert/strict';
import { inspectConjunction, inspectFocus } from '../../src/amr/audit.mjs';
import { queryRetention } from '../../src/amr/retention.mjs';
import { collect, historyItems, proposedEnglish, walk } from '../../src/inquiry/crossing.mjs';

const graph = (top, labels, edges) => ({
  top,
  labels: new Map(Object.entries(labels)),
  edges: edges.map(([from, role, to]) => ({ from, role, to })),
});
const check = (name, run) => {
  run();
  console.log(`ok ${name}`);
};

check('possibility examines the content event while retaining modality and negation', () => {
  const query = graph(
    'can',
    { can: 'possible-01', know: 'recognize-02', person: 'person', minus: '-' },
    [
      ['can', ':ARG1', 'know'],
      ['can', ':polarity', 'minus'],
      ['know', ':ARG0', 'person'],
    ],
  );
  const source = graph('know', { know: 'recognize-02', person: 'person' }, [
    ['know', ':ARG0', 'person'],
  ]);
  const result = inspectFocus(query, [source], 'can').branch;
  assert.equal(result.concept, 'recognize-02');
  assert.equal(result.candidates.length, 1);
  assert(result.candidates[0].aligned.some((path) => path.includes(':ARG0')));
  assert(
    result.candidates[0].open.some(
      (path) => path.includes('possible-01') && path.includes(':polarity→ -'),
    ),
  );
  assert.equal(inspectFocus(query, [query], 'can').carry.paths.length, 0);
  const unrelated = graph('can', { can: 'possible-01', go: 'go-01' }, [['can', ':ARG1', 'go']]);
  assert.equal(inspectFocus(query, [unrelated], 'can').branch.candidates.length, 0);
  const ambiguous = graph('can', { can: 'possible-01', know: 'recognize-02', go: 'go-01' }, [
    ['can', ':ARG1', 'know'],
    ['can', ':ARG1', 'go'],
  ]);
  assert.equal(inspectFocus(ambiguous, [], 'can').branch.concept, 'possible-01');
});

const consumeQuery = graph(
  'consume',
  {
    consume: 'consume-01',
    token: 'token',
    form: 'form-01',
    scanner: 'scanner',
  },
  [
    ['consume', ':ARG1', 'token'],
    ['form', ':ARG1', 'token'], // normalized from `token :ARG1-of form-01`
    ['form', ':ARG0', 'scanner'],
  ],
);
const bareConsume = graph('consume', { consume: 'consume-01', token: 'token' }, [
  ['consume', ':ARG1', 'token'],
]);

check('nested inverse attachment remains in carry', () => {
  const result = inspectFocus(consumeQuery, [bareConsume], 'consume');
  assert(result.branch.required.some((path) => path.includes('token ←:ARG1─ form-01')));
  assert(result.carry.paths.some((path) => path.text.includes('form-01 ─:ARG0→ scanner')));
});

check('a source with the whole inverse attachment has no missing path', () => {
  const result = inspectFocus(consumeQuery, [consumeQuery], 'consume');
  assert.equal(result.carry.paths.length, 0);
});

check('shared actor does not pull sibling conjunction events into a branch', () => {
  const query = graph('and', { and: 'and', wash: 'wash-01', dress: 'dress-01', maya: 'person' }, [
    ['and', ':op1', 'wash'],
    ['and', ':op2', 'dress'],
    ['wash', ':ARG0', 'maya'],
    ['dress', ':ARG0', 'maya'],
  ]);
  const result = inspectConjunction(query, []);
  assert(result.branches[0].required.some((path) => path.includes('person')));
  assert(!result.branches[0].required.some((path) => path.includes('dress-01')));
  assert(!result.branches[1].required.some((path) => path.includes('wash-01')));
});

check('question marker is omitted but actual negative polarity remains', () => {
  const question = graph('wash', { wash: 'wash-01', unknown: 'amr-unknown' }, [
    ['wash', ':polarity', 'unknown'],
  ]);
  const negative = graph('wash', { wash: 'wash-01', minus: '-' }, [['wash', ':polarity', 'minus']]);
  assert.equal(inspectFocus(question, [], 'wash').branch.required.length, 0);
  assert(
    inspectFocus(negative, [], 'wash').branch.required.some((path) =>
      path.includes(':polarity→ -'),
    ),
  );
});

check('question bindings pin one source participant and retain open paths and source scope', () => {
  const query = graph(
    'must',
    {
      must: 'obligate-01',
      remain: 'remain-01',
      what: 'amr-unknown',
      possible: 'possible-01',
      challenge: 'challenge-01',
    },
    [
      ['must', ':ARG2', 'remain'],
      ['remain', ':ARG1', 'what'],
      ['remain', ':ARG3', 'possible'],
      ['possible', ':ARG1', 'challenge'],
      ['challenge', ':ARG1', 'what'],
    ],
  );
  const source = graph(
    'must',
    { ...Object.fromEntries(query.labels), what: 'cross-02', consequence: 'consequential-01' },
    [
      ...query.edges.map((edge) => [edge.from, edge.role, edge.to]),
      ['consequence', ':ARG1', 'what'],
    ],
  );
  const candidate = (sourceGraph) =>
    inspectFocus(query, [sourceGraph], 'remain').branch.candidates[0];
  const exact = candidate(source);
  assert.equal(exact.bindings.length, 1);
  assert.equal(exact.bindings[0].concept, 'cross-02');
  assert.equal(exact.bindings[0].openRefs.length, 0);
  assert(exact.openRefs.length > 0, 'provisional binding must not close the original carry');
  assert.equal(query.labels.get('what'), 'amr-unknown');
  const other = graph(
    'must',
    { ...Object.fromEntries(source.labels), other: 'cross-02' },
    source.edges.map((edge) => [
      edge.from,
      edge.role,
      edge.from === 'challenge' ? 'other' : edge.to,
    ]),
  );
  assert(
    candidate(other).bindings[0].openRefs.length > 0,
    'challenge must refer to the same crossing',
  );
  const negative = graph('must', { ...Object.fromEntries(source.labels), minus: '-' }, [
    ...source.edges.map((edge) => [edge.from, edge.role, edge.to]),
    ['challenge', ':polarity', 'minus'],
  ]);
  const negatedBinding = candidate(negative).bindings[0];
  assert.equal(negatedBinding.status, 'provisional');
  assert(negatedBinding.sourceScope.some((path) => path.text.includes(':polarity→ -')));
  const negativeQuery = graph('must', { ...Object.fromEntries(query.labels), minus: '-' }, [
    ...query.edges.map((edge) => [edge.from, edge.role, edge.to]),
    ['challenge', ':polarity', 'minus'],
  ]);
  assert(
    inspectFocus(negativeQuery, [source], 'remain').branch.candidates[0].bindings[0].openRefs
      .length > 0,
  );
  const wrongRole = graph(
    'must',
    Object.fromEntries(source.labels),
    source.edges.map((edge) => [
      edge.from,
      edge.from === 'remain' && edge.to === 'what' ? ':ARG2' : edge.role,
      edge.to,
    ]),
  );
  assert.equal(candidate(wrongRole).bindings.length, 0);
  const yesNo = graph('remain', { remain: 'remain-01', unknown: 'amr-unknown' }, [
    ['remain', ':polarity', 'unknown'],
  ]);
  assert.equal(inspectFocus(yesNo, [negative], 'remain').branch.candidates[0].bindings.length, 0);
  const node = { sources: [{ text: 'Source.', graph: source }], crossings: [] };
  const visit = walk(new Map([['node', node]]), 'node', {
    id: 'q',
    interpretation: 'q1',
    text: 'What?',
    graph: query,
  });
  assert.equal(collect(visit.returned).findings[0].bindings[0].sourceNodeId, 'what');
  assert(collect(visit.returned).openings.some((opening) => opening.kind === 'question'));
});

check('ordinary morphology does not suppress a meaningful AMR graph', () => {
  for (const [english, concept] of [
    ['ran', 'run-01'],
    ['ate', 'eat-01'],
    ['making', 'make-01'],
  ]) {
    const result = queryRetention(english, graph('event', { event: concept }, []));
    assert.equal(result.status, 'uncertain', `${english} → ${concept}`);
  }
});

check('question-marker-only parses cannot replace a contentful question', () => {
  const collapsed = graph('p', { p: 'have-polarity-91', minus: '-' }, [['p', ':ARG2', 'minus']]);
  assert.equal(queryRetention('Does Maya wash', collapsed).status, 'no-content-anchor');
  const whCollapsed = graph('unknown', { unknown: 'amr-unknown' }, []);
  assert.equal(queryRetention('Who ran?', whCollapsed).status, 'no-content-anchor');
});

check('recursive returns keep source events separate and stop only branch cycles', () => {
  const labels = {
    wash: 'wash-01',
    actor: 'person',
    actorName: 'name',
    item: 'product',
    itemName: 'name',
    spagetti: 'Spagetti',
  };
  const actor = (who) => [
    ['wash', ':ARG0', 'actor'],
    ['actor', ':name', 'actorName'],
    ['actorName', ':op1', who],
  ];
  const item = [
    ['wash', ':ARG1', 'item'],
    ['item', ':name', 'itemName'],
    ['itemName', ':op1', 'spagetti'],
  ];
  const query = graph('wash', { ...labels, maya: 'Maya' }, [...actor('maya'), ...item]);
  const morning = graph('wash', { ...labels, maya: 'Maya' }, actor('maya'));
  const kitchen = graph('wash', { ...labels, leo: 'Leo' }, [...actor('leo'), ...item]);
  const sink = graph('wash', { ...labels, maya: 'Maya' }, [...actor('maya'), ...item]);
  const pantry = graph('store', { store: 'store-01' }, []);
  const source = (text, value) => ({ text, graph: value, affinity: 0.5 });
  const nodes = new Map([
    [
      'morning',
      { sources: [source('Maya washes.', morning)], crossings: ['kitchen', 'pantry', 'sink'] },
    ],
    ['kitchen', { sources: [source('Leo washes Spagetti.', kitchen)], crossings: ['sink'] }],
    ['sink', { sources: [source('Maya washes Spagetti.', sink)], crossings: ['morning'] }],
    ['pantry', { sources: [source('The pantry stores food.', pantry)], crossings: [] }],
  ]);
  const result = walk(nodes, 'morning', {
    id: 'q',
    text: 'Did Maya wash Spagetti?',
    graph: query,
    interpretation: 'amr-v1',
  });
  const [viaKitchen, viaPantry, directSink] = result.children.map((child) => child.result);
  assert.equal(result.local.findings[0].aligned.length, 1);
  assert.equal(viaKitchen.local.findings[0].aligned.length, 1);
  assert(
    viaKitchen.local.findings[0].alternatives.some((alternative) =>
      alternative.observed.includes('Leo'),
    ),
  );
  assert.equal(viaKitchen.children[0].result.local.findings[0].open.length, 0);
  assert.equal(viaKitchen.children[0].result.children[0].result.kind, 'cycle');
  assert.equal(directSink.kind, 'visit'); // no global already-visited flag
  assert.equal(viaPantry.local.unchanged, true);
  assert.equal(collect(viaPantry.returned).openings[0].paths.length, 2);
  const returned = collect(result.returned);
  assert.equal(returned.findings.length, 3); // direct sink is not new evidence
  assert(
    returned.findings
      .filter((finding) => finding.node !== 'sink')
      .every((finding) => finding.open.length > 0),
  ); // no stitched Maya+Leo witness
  assert(historyItems(viaKitchen.incoming.history)[0].findings[0].aligned[0].includes('Maya'));
});

check(
  'embedding order changes inspection without changing graph findings or dropping sources',
  () => {
    const sources = [
      { text: 'Full inverse attachment', graph: consumeQuery, affinity: 0.2 },
      { text: 'Bare attachment', graph: bareConsume, affinity: 0.9 },
    ];
    const run = () =>
      walk(new Map([['node', { sources, crossings: [] }]]), 'node', {
        id: 'q',
        text: 'query',
        graph: consumeQuery,
        interpretation: 'test',
      }).local.findings;
    const first = run();
    assert.deepEqual(
      first.map((item) => item.sourceIndex),
      [1, 0],
    );
    assert(first[0].open.length > 0);
    assert.equal(first[1].open.length, 0);
    sources[0].affinity = 0.95;
    const second = run();
    assert.deepEqual(
      second.map((item) => item.sourceIndex),
      [0, 1],
    );
    assert.deepEqual(second[0].alignedRefs, first[1].alignedRefs);
    assert.deepEqual(second[1].openRefs, first[0].openRefs);
  },
);

check('interpretation proposals change only their explicit surface span', () => {
  const patch = { from: 'spagetti', to: 'spaghetti' };
  assert.equal(proposedEnglish('Did Maya wash spagetti?', patch), 'Did Maya wash spaghetti?');
  assert.equal(proposedEnglish('Did Leo wash Spagetti?', patch), 'Did Leo wash spaghetti?');
  assert.equal(proposedEnglish('Did Leo wash pasta?', patch), null);
  assert.equal(proposedEnglish('Did Leo wash ultraspagetti?', patch), null);
  assert.throws(() => proposedEnglish('spagetti or spagetti?', patch), /ambiguous/);
});

check('an invalid source parse is an opening, not evidence of no event', () => {
  const query = graph('wash', { wash: 'wash-01' }, []);
  const nodes = new Map([
    ['unreadable', { sources: [{ text: 'Maya washes.', graph: null }], crossings: [] }],
  ]);
  const result = walk(nodes, 'unreadable', {
    id: 'q',
    text: 'Does Maya wash?',
    graph: query,
    interpretation: 'amr-v1',
  });
  assert.equal(result.local.unchanged, false);
  assert(collect(result.returned).openings.some((opening) => opening.kind === 'source-parse'));
});

check('conjunction scope and whole opening survive every return', () => {
  const query = graph('and', { and: 'and', wash: 'wash-01', leave: 'leave-11', minus: '-' }, [
    ['and', ':op1', 'wash'],
    ['and', ':op2', 'leave'],
    ['and', ':polarity', 'minus'],
  ]);
  const source = graph('store', { store: 'store-01' }, []);
  const nodes = new Map([
    ['first', { sources: [{ text: 'A store exists.', graph: source }], crossings: ['second'] }],
    ['second', { sources: [{ text: 'A store exists.', graph: source }], crossings: [] }],
  ]);
  const result = walk(nodes, 'first', {
    id: 'q',
    text: 'Maya neither washes nor leaves.',
    graph: query,
    interpretation: 'amr-v1',
  });
  assert(result.incoming.obligation.parentContext.includes(':polarity -'));
  assert(result.incoming.obligation.wholeOpening.includes('parent conjunction'));
  assert(result.children[0].result.incoming.obligation.parentContext.includes(':polarity -'));
  assert.equal(result.returned.children[0].target, 'second');
  const parentOpenings = collect(result.returned).openings.filter(
    (opening) => opening.kind === 'parent',
  );
  assert.equal(parentOpenings.length, 2);
  assert(parentOpenings.every((opening) => opening.scope.includes(':polarity -')));
});

check('an explicit stack returns beyond the former call-stack limit', () => {
  const query = graph('wash', { wash: 'wash-01' }, []);
  const source = graph('store', { store: 'store-01' }, []);
  const count = 4000;
  const nodes = new Map(
    Array.from({ length: count }, (_, i) => [
      String(i),
      {
        sources: [{ text: 'A store exists.', graph: source }],
        crossings: i + 1 < count ? [String(i + 1)] : [],
      },
    ]),
  );
  const result = walk(nodes, '0', {
    id: 'q',
    text: 'Does Maya wash?',
    graph: query,
    interpretation: 'amr-v1',
  });
  assert.equal(collect(result.returned).openings.length, count * 2);
});
