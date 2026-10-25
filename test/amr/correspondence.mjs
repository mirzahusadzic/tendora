/** Proposals expose interpretation work; only accepted, coherent frames support answers. */
import assert from 'node:assert/strict';
import { proposeCorrespondences } from '../../src/amr/correspondence.mjs';
import {
  compileWording,
  connectQuestion,
  composeAnswer,
  questionBranches,
} from '../../src/amr/development.mjs';
import { evaluateAnswer } from '../../src/recording/answers.mjs';
import { sharedWording, swapsNamedParticipant } from '../../src/engine/clarify.mjs';

const graph = (id, top, nodes, edges) => ({
  id,
  top,
  nodes: Object.entries(nodes).map(([id, value]) => ({
    id,
    ...(typeof value === 'string' ? { concept: value } : value),
  })),
  edges: edges.map(([from, role, to], i) => ({ id: `e${i}`, from, role, to })),
});
const source = graph(
  'workshop',
  'r',
  { r: 'repair-01', p: { concept: 'person', surfaceLabel: 'Sam' }, b: 'bicycle' },
  [
    ['r', ':ARG0', 'p'],
    ['r', ':ARG1', 'b'],
  ],
);
const question = graph('who', 'r', { r: 'repair-01', p: 'amr-unknown', b: 'bike' }, [
  ['r', ':ARG0', 'p'],
  ['r', ':ARG1', 'b'],
]);
const bases = [{ id: 'source', graph: source, text: 'Sam repairs bicycles.' }];
const snapshot = JSON.stringify({ question, bases });
const candidates = proposeCorrespondences(question, bases);
assert.equal(candidates.length, 1);
const candidate = candidates[0];
assert.equal(candidate.basisId, 'source');
assert.equal(candidate.answerNodeId, 'p');
assert.equal(candidate.answerLabel, 'Sam');
assert.equal(candidate.alignment.asserted, false);
assert(candidate.alignment.contexts.some((c) => c.changedConcept));
assert(candidate.alignment.contexts.every((c) => c.source.derivation && c.question.derivation));
assert.equal(
  JSON.stringify({ question, bases }),
  snapshot,
  'Discovery does not edit or assert either reading',
);

const accepted = { ...candidate.rule, id: 'accepted', baseOnly: true, sources: [] };
const answer = (query, rules = [], evidence = source) =>
  evaluateAnswer(
    {
      inquiry: { text: 'Independent question', graphId: query.id },
      graphs: [query, evidence],
      project: { placementId: 'root' },
      sources: [{ id: 'source', nodeId: 'root', text: 'Retained evidence', graphId: evidence.id }],
    },
    { rules },
  );
assert.equal(answer(question).status, 'open', 'A proposal alone is not evidence');
assert.equal(answer(question, [accepted]).status, 'supported');
assert.equal(answer(question, [accepted]).answers[0].text, 'Sam');
const yes = graph('yes', 'r', { r: 'repair-01', p: 'person', b: 'bike' }, [
  ['r', ':ARG0', 'p'],
  ['r', ':ARG1', 'b'],
]);
assert.equal(
  answer(yes, [accepted]).status,
  'supported',
  'One accepted interface supports a different question focus',
);
const what = graph('what', 'r', { r: 'repair-01', p: 'person', b: 'amr-unknown' }, [
  ['r', ':ARG0', 'p'],
  ['r', ':ARG1', 'b'],
]);
assert.equal(
  answer(what, [accepted]).status,
  'supported',
  'Renamed participants do not become competing occurrences',
);
assert(
  answer(what, [accepted]).answers.every(
    (a) => a.bindings[0].id === answer(what).answers[0].bindings[0].id,
  ),
);
const reversed = graph('reversed', 'r', { r: 'repair-01', p: 'person', b: 'bike' }, [
  ['r', ':ARG0', 'b'],
  ['r', ':ARG1', 'p'],
]);
assert.equal(answer(reversed, [accepted]).status, 'open');

assert.deepEqual(proposeCorrespondences(question, []), []);
assert.deepEqual(proposeCorrespondences(question, [{ ...bases[0], asserted: false }]), []);
assert.deepEqual(proposeCorrespondences(question, [{ ...bases[0], withdrawn: true }]), []);
assert.deepEqual(proposeCorrespondences(question, [{ ...bases[0], graph: question }]), []);

// A participant described by a different action in the same role is a different
// participant: the registrar's keeping is not answered by the conservator's.
const keeping = (descriptor, kept) =>
  graph(`keep-${descriptor}-${kept}`, 'k', { k: 'keep-01', p: 'person', d: descriptor, m: kept }, [
    ['k', ':ARG0', 'p'],
    ['d', ':ARG0', 'p'],
    ['k', ':ARG1', 'm'],
  ]);
const kept = (graph) => [{ id: 'kept', graph, text: 'Retained keeping.' }];
assert.equal(
  proposeCorrespondences(
    keeping('register-02', 'amr-unknown'),
    kept(keeping('conserve-01', 'meter')),
  ).length,
  0,
);
assert.equal(
  proposeCorrespondences(
    keeping('register-02', 'amr-unknown'),
    kept(keeping('register-02', 'meter')),
  ).length,
  1,
);
// The same words read with a different structure remain a proposal: “crates
// scheduled for freezing” as freeze-01 :ARG1-of schedule-01, or as
// schedule-01 :ARG3 freeze-01.
const signs = graph(
  'signs',
  's',
  {
    s: 'sign-01',
    p: 'person',
    c: 'conserve-01',
    l: 'slip',
    r: 'release-01',
    k: 'crate',
    h: 'schedule-01',
    f: 'freeze-01',
  },
  [
    ['s', ':ARG0', 'p'],
    ['c', ':ARG0', 'p'],
    ['s', ':ARG1', 'l'],
    ['l', ':purpose', 'r'],
    ['r', ':ARG1', 'k'],
    ['h', ':ARG1', 'k'],
    ['h', ':ARG3', 'f'],
    ['f', ':ARG1', 'k'],
  ],
);
const whoSigns = graph(
  'who-signs',
  's',
  {
    s: 'sign-01',
    u: 'amr-unknown',
    l: 'slip',
    r: 'release-01',
    k: 'crate',
    f: 'freeze-01',
    h: 'schedule-01',
  },
  [
    ['s', ':ARG0', 'u'],
    ['s', ':ARG1', 'l'],
    ['l', ':purpose', 'r'],
    ['r', ':ARG1', 'k'],
    ['f', ':ARG1', 'k'],
    ['h', ':ARG1', 'f'],
  ],
);
assert.deepEqual(
  proposeCorrespondences(whoSigns, [{ id: 'signs', graph: signs, text: 'Retained signing.' }]).map(
    (c) => c.answerNodeId,
  ),
  ['p'],
);
// The person confirming sees which shared words were read differently.
const asked = {
  text: 'Who signs release slips for crates scheduled for freezing?',
  graph: whoSigns,
};
const said = {
  text: 'The collections conservator signs release slips for crates scheduled for freezing.',
  graph: signs,
};
assert.equal(sharedWording(asked, said), 'crates scheduled for freezing');
assert.equal(sharedWording(said, said), null, 'One reading has no difference');
// A shared-wording proposal stays a proposal: the engine does not read the
// question as in the source by itself (review 2026-10-25, #3).
const signRecording = {
  inquiry: { text: asked.text, graphId: whoSigns.id },
  project: { placementId: 'root' },
  graphs: [whoSigns, signs],
  sources: [{ id: 'signs', nodeId: 'root', text: said.text, graphId: signs.id }],
};
assert.equal(evaluateAnswer(signRecording, { rules: [] }).status, 'open');
const [signProposal] = proposeCorrespondences(whoSigns, [
  { id: 'signs', graph: signs, text: said.text },
]);
assert.equal(signProposal.answerNodeId, 'p', 'The connection is offered for a person to confirm');
assert.equal(
  sharedWording(
    { text: 'What does the registrar keep?', graph: keeping('register-02', 'amr-unknown') },
    { text: 'The conservator keeps the meter.', graph: keeping('conserve-01', 'meter') },
  ),
  null,
  'Different words are not a shared wording',
);
// Shared words do not settle roles. The question names the inspector as the
// proposer; the source makes the inspector the one who may reject. Asked
// without naming a proposer, the same wording settles.
const mayReject = {
  text: 'The inspector may reject a proposed repair with a reason.',
  graph: graph(
    'may-reject',
    'm',
    {
      m: 'possible-01',
      r: 'reject-01',
      i: 'inspector',
      c: 'repair-01',
      p: 'propose-01',
      k: 'cause-01',
      w: 'reason',
    },
    [
      ['m', ':ARG1', 'r'],
      ['r', ':ARG0', 'i'],
      ['r', ':ARG1', 'c'],
      ['p', ':ARG1', 'c'],
      ['k', ':ARG1', 'r'],
      ['k', ':ARG0', 'w'],
    ],
  ),
};
const whoRejects = (text, proposer) => ({
  text,
  graph: graph(
    'who-rejects',
    'm',
    {
      m: 'possible-01',
      r: 'reject-01',
      u: 'amr-unknown',
      t: 'thing',
      p: 'propose-01',
      ...(proposer ? { i: 'inspector' } : {}),
    },
    [
      ['m', ':ARG1', 'r'],
      ['r', ':ARG0', 'u'],
      ['r', ':ARG1', 't'],
      ['p', ':ARG1', 't'],
      ...(proposer ? [['p', ':ARG0', 'i']] : []),
    ],
  ),
});
const proposedFor = (asked) =>
  proposeCorrespondences(asked.graph, [
    { id: 'reject', graph: mayReject.graph, text: mayReject.text },
  ]).filter((proposal) => proposal.answerNodeIds?.u === 'i');
const plain = whoRejects('Who may reject a proposal?', false);
assert(proposedFor(plain).length, 'The rejector is offered when the question names no proposer');
assert.equal(
  swapsNamedParticipant(plain.graph, mayReject.graph, { u: 'i' }),
  false,
  'Answering with a participant the question does not name swaps nothing',
);
const ofInspector = whoRejects('Who may reject a proposal of the inspector?', true);
assert.equal(
  swapsNamedParticipant(ofInspector.graph, mayReject.graph, { u: 'i' }),
  true,
  'The question names the inspector as the proposer: answering inspector swaps roles',
);
// By name too: a person is named by its :name, not its concept.
const withName = (id, top, nodes, edges) =>
  graph(id, top, { ...nodes, n: 'name', l: { concept: 'Ana', literal: '"Ana"' } }, [
    ...edges,
    ['p', ':name', 'n'],
    ['n', ':op1', 'l'],
  ]);
const anaRejects = withName(
  'ana-rejects',
  'r',
  { r: 'reject-01', p: 'person', t: 'thing', q: 'propose-01', i: 'intelligence' },
  [
    ['r', ':ARG0', 'p'],
    ['r', ':ARG1', 't'],
    ['q', ':ARG1', 't'],
    ['q', ':ARG0', 'i'],
  ],
);
const ofAna = withName(
  'of-ana',
  'r',
  { r: 'reject-01', u: 'amr-unknown', t: 'thing', q: 'propose-01', p: 'person' },
  [
    ['r', ':ARG0', 'u'],
    ['r', ':ARG1', 't'],
    ['q', ':ARG1', 't'],
    ['q', ':ARG0', 'p'],
  ],
);
assert.equal(
  swapsNamedParticipant(ofAna, anaRejects, { u: 'p' }),
  true,
  'A named proposer keeps its role',
);
assert.equal(
  swapsNamedParticipant(ofAna, anaRejects, { u: 'i' }),
  false,
  'Another participant is not the named one',
);
const unrelated = structuredClone(source);
unrelated.nodes[0].concept = 'sell-01';
assert.deepEqual(proposeCorrespondences(question, [{ ...bases[0], graph: unrelated }]), []);
assert.deepEqual(proposeCorrespondences(question, bases, { limit: 0 }), []);
assert.throws(() => proposeCorrespondences(question, bases, { limit: Infinity }), /limit/u);
const shuffled = [
  { ...bases[0], id: 'z' },
  { ...bases[0], id: 'a' },
];
assert.equal(proposeCorrespondences(question, shuffled, { limit: 1 })[0].basisId, 'a');
// Only 64 bases are tried. Ranked by relevance, the one that answers is among
// them even when 70 others come first by identifier.
const unrelatedBases = Array.from({ length: 70 }, (_, i) => ({
  ...bases[0],
  id: `a${String(i).padStart(2, '0')}`,
  graph: unrelated,
  relevance: 0,
}));
assert.deepEqual(
  proposeCorrespondences(question, [...unrelatedBases, { ...bases[0], id: 'z' }]),
  [],
);
assert.equal(
  proposeCorrespondences(question, [...unrelatedBases, { ...bases[0], id: 'z', relevance: 1 }], {
    limit: 1,
  })[0].basisId,
  'z',
);
assert.deepEqual(
  proposeCorrespondences(question, shuffled),
  proposeCorrespondences(question, [...shuffled].reverse()),
);

const negative = structuredClone(question);
negative.nodes.push({ id: 'n', concept: '-', literal: '-' });
negative.edges.push({ id: 'neg', from: 'r', role: ':polarity', to: 'n' });
assert.deepEqual(
  proposeCorrespondences(negative, bases),
  [],
  'Clarification cannot introduce negation',
);
const modal = graph(
  'modal',
  'm',
  { m: 'possible-01', r: 'repair-01', p: 'amr-unknown', b: 'bike' },
  [
    ['m', ':ARG1', 'r'],
    ['r', ':ARG0', 'p'],
    ['r', ':ARG1', 'b'],
  ],
);
assert.deepEqual(
  proposeCorrespondences(modal, bases),
  [],
  'Clarification cannot introduce possibility',
);
const named = (id, name) =>
  graph(
    id,
    'r',
    {
      r: 'repair-01',
      p: 'person',
      n: 'name',
      text: { concept: name, literal: `"${name}"` },
      b: 'bike',
    },
    [
      ['r', ':ARG0', 'p'],
      ['r', ':ARG1', 'b'],
      ['p', ':name', 'n'],
      ['n', ':op1', 'text'],
    ],
  );
assert.deepEqual(
  proposeCorrespondences(named('query-name', 'Riley'), [
    { id: 'named', graph: named('source-name', 'Sam'), text: 'Sam repairs bikes.' },
  ]),
  [],
  'Matching grammar cannot change a named participant',
);

const negativeSource = structuredClone(source);
negativeSource.nodes.push({ id: 'n', concept: '-', literal: '-' });
negativeSource.edges.push({ id: 'neg', from: 'r', role: ':polarity', to: 'n' });
const negativeAlternative = structuredClone(yes);
negativeAlternative.nodes.push({ id: 'n', concept: '-', literal: '-' });
negativeAlternative.edges.push({ id: 'neg', from: 'r', role: ':polarity', to: 'n' });
const negativeRule = {
  ...compileWording(negativeSource, negativeAlternative, { perspective: true, isolated: true }),
  id: 'negative',
  baseOnly: true,
  sources: [],
};
const negativeAnswer = answer(yes, [negativeRule], negativeSource);
assert.notEqual(negativeAnswer.status, 'conflict');
assert(
  negativeAnswer.answers.every((a) => a.text === 'No'),
  'A fresh negative frame cannot support Yes',
);
assert(negativeRule.guards.length, 'An isolated negative frame retains explicit output guards');
const movedNegation = structuredClone(negativeAlternative);
movedNegation.edges.find((e) => e.id === 'neg').from = 'b';
assert.throws(
  () => compileWording(negativeSource, movedNegation, { perspective: true, isolated: true }),
  /move a negation/u,
);

const help = graph(
  'policy',
  'h',
  {
    h: 'help-01',
    s: 'simulate-01',
    p: { concept: 'person', surfaceLabel: 'programmer' },
    prog: 'program-01',
    support: 'support-01',
    explore: 'explore-01',
  },
  [
    ['h', ':ARG0', 's'],
    ['h', ':ARG2', 'p'],
    ['prog', ':ARG0', 'p'],
    ['h', ':condition', 'support'],
    ['support', ':ARG0', 's'],
    ['support', ':ARG1', 'explore'],
  ],
);
const passive = graph('passive', 'h', { h: 'help-01', s: 'simulate-01', p: 'amr-unknown' }, [
  ['h', ':ARG0', 's'],
  ['h', ':ARG1', 'p'],
]);
const conditional = proposeCorrespondences(passive, [{ id: 'policy', graph: help }]);
assert.equal(conditional.length, 1);
assert.equal(conditional[0].answerLabel, 'programmer');
assert.equal(conditional[0].answerNodeId, 'p');
assert.equal(conditional[0].alignment.conditional, true);
assert.equal(conditional[0].alignment.exactAnswerRole, false);
assert(
  conditional[0].rule.when.some((t) => t[1] === '@asserted'),
  'A policy interpretation requires its grounded asserted consequence',
);
assert.equal(
  answer(passive, [{ ...conditional[0].rule, id: 'conditional-view', baseOnly: true }], help)
    .status,
  'open',
);

// Automatic frame isolation must preserve coherence without manufacturing a
// second occurrence for an unchanged frame. Output negation guards apply in
// the default compiler mode as well as explicitly isolated proposals.
const defaultNegative = {
  ...compileWording(negativeSource, negativeAlternative, { perspective: true }),
  id: 'default-negative',
  baseOnly: true,
};
assert(answer(yes, [defaultNegative], negativeSource).answers.every((a) => a.text === 'No'));

// An accepted frame conversion licenses the named conversion, not mixed roles.
const trading = (id, predicate, actor, other) =>
  graph(
    id,
    'e',
    {
      e: predicate,
      p: 'person',
      c: 'company',
      v: 'car',
    },
    [
      ['e', ':ARG0', actor],
      ['e', ':ARG1', 'v'],
      ['e', ':ARG2', other],
    ],
  );
const buying = trading('buy', 'buy-01', 'p', 'c'),
  selling = trading('sell', 'sell-01', 'c', 'p'),
  reverseBuying = trading('reverse-buy', 'buy-01', 'c', 'p');
const tradingRule = {
  ...compileWording(buying, selling, { isolated: true }),
  id: 'trading',
  baseOnly: true,
};
assert.equal(answer(selling, [tradingRule], buying).status, 'supported');
assert.equal(answer(reverseBuying, [tradingRule], buying).status, 'open');
const automaticTrading = { ...compileWording(buying, selling), id: 'auto-trading', baseOnly: true };
assert.equal(answer(selling, [automaticTrading], buying).status, 'supported');
assert.equal(answer(reverseBuying, [automaticTrading], buying).status, 'open');
assert(tradingRule.then.find((t) => t[1] === '@asserted')[0].startsWith('$'));
console.log(
  'ok bounded correspondence proposals, explicit acceptance, participant identity, conditional interfaces, negative/modal/literal guards and coherent frame reuse',
);

// Frozen compositional readings and explicit boundary controls.
{
  const graph = (id, top, nodes, edges) => ({
    id,
    top,
    nodes: Object.entries(nodes).map(([id, concept]) => ({ id, concept })),
    edges: edges.map(([from, role, to], i) => ({ id: `e${i}`, from, role, to })),
  });
  const answer = (query, evidence, rules = []) =>
    evaluateAnswer(
      {
        inquiry: { graphId: query.id, text: 'Frozen independent question' },
        graphs: [query, ...evidence],
        sources: evidence.map((g) => ({ id: g.id, graphId: g.id, nodeId: 'root', text: g.id })),
      },
      { rules: rules.map((rule, i) => ({ ...rule, id: `view${i}`, baseOnly: true })) },
    );
  const proposal = (query, source) =>
    proposeCorrespondences(query, [{ id: source.id, graph: source }]);
  const selected = (result) => result.answers.flatMap((a) => a.bindings.map((b) => b.text)).sort();

  // Semantic gain: both nested ports survive a wording change and an independent
  // refocusing of the question, without choosing the first slot in node order.
  const source = graph(
    'delivery',
    'd',
    {
      d: 'deliver-01',
      p: 'courier',
      t: 'ticket',
      u: 'urgent',
      h: 'harbour',
    },
    [
      ['d', ':ARG0', 'p'],
      ['d', ':ARG1', 't'],
      ['t', ':mod', 'u'],
      ['t', ':topic', 'h'],
    ],
  );
  const query = graph(
    'nested',
    'd',
    {
      h: 'amr-unknown',
      t: 'request',
      d: 'deliver-01',
      u: 'amr-unknown',
      p: 'courier',
    },
    source.edges.map(({ from, role, to }) => [from, role, to]),
  );
  const proposals = proposal(query, source);
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].answerNodeIds, { h: 'h', u: 'u' });
  assert(proposals[0].rule.correspondence.derivation, 'Alignment has an HRG chart witness');
  assert.equal(answer(query, [source]).status, 'open');
  assert.equal(answer(query, [source], [proposals[0].rule]).status, 'supported');
  assert.deepEqual(selected(answer(query, [source], [proposals[0].rule])), ['harbour', 'urgent']);
  const revisit = structuredClone(query);
  revisit.id = 'revisit';
  revisit.nodes.find((n) => n.id === 'h').concept = 'harbour';
  assert.deepEqual(selected(answer(revisit, [source], [proposals[0].rule])), ['urgent']);
  assert.equal(answer(revisit, [source]).status, 'open', 'Rule ablation removes the gain');

  const wording = structuredClone(query);
  wording.id = 'wording';
  wording.nodes.find((n) => n.id === 't').concept = 'parcel';
  wording.nodes.reverse();
  const equivalent = compileWording(query, wording, { isolated: true });
  const queryEvidence = structuredClone(source);
  queryEvidence.id = 'request-source';
  queryEvidence.nodes.find((n) => n.id === 't').concept = 'request';
  assert.deepEqual(selected(answer(wording, [queryEvidence], [equivalent])), ['harbour', 'urgent']);

  // A path deeper than the old four-edge search reaches its actual answer port.
  const deepSource = graph(
    'deep',
    'r',
    { r: 'inspect-01', a: 'report', b: 'topic', c: 'design', d: 'part', e: 'surface', f: 'rough' },
    [
      ['r', ':ARG1', 'a'],
      ['a', ':topic', 'b'],
      ['b', ':topic', 'c'],
      ['c', ':mod', 'd'],
      ['d', ':mod', 'e'],
      ['e', ':mod', 'f'],
    ],
  );
  const deepQuery = structuredClone(deepSource);
  deepQuery.id = 'deep-query';
  deepQuery.nodes.find((n) => n.id === 'f').concept = 'amr-unknown';
  deepQuery.nodes.find((n) => n.id === 'a').concept = 'account';
  assert.equal(proposal(deepQuery, deepSource)[0].answerNodeId, 'f');
  assert.deepEqual(
    selected(answer(deepQuery, [deepSource], [proposal(deepQuery, deepSource)[0].rule])),
    ['rough'],
  );

  // Compound branches retain independent occurrences even with repeated labels.
  const compound = graph(
    'compound',
    'and',
    {
      and: 'and',
      r: 'repair-01',
      s: 'inspect-01',
      p: 'amr-unknown',
      q: 'amr-unknown',
      b: 'bike',
      t: 'ticket',
    },
    [
      ['and', ':op1', 'r'],
      ['and', ':op2', 's'],
      ['r', ':ARG0', 'p'],
      ['r', ':ARG1', 'b'],
      ['s', ':ARG0', 'q'],
      ['s', ':ARG1', 't'],
    ],
  );
  const compoundSource = structuredClone(compound);
  compoundSource.id = 'compound-source';
  for (const n of compoundSource.nodes) {
    if (n.concept === 'amr-unknown') n.concept = 'person';
    if (n.id === 'b') n.concept = 'bicycle';
    if (n.id === 't') n.concept = 'request';
  }
  const parts = proposal(compound, compoundSource);
  assert.equal(parts.length, 2);
  assert.notEqual(parts[0].answerNodeId, parts[1].answerNodeId);
  assert.equal(
    answer(
      compound,
      [compoundSource],
      parts.map((p) => p.rule),
    ).status,
    'supported',
  );
  const bindings = answer(
    compound,
    [compoundSource],
    parts.map((p) => p.rule),
  ).answers[0].bindings;
  assert.equal(
    new Set(bindings.map((b) => b.id)).size,
    2,
    'Equal person labels do not merge occurrences',
  );
  assert.equal(answer(compound, [compoundSource], [parts[0].rule]).status, 'open');
  const whole = compileWording(compoundSource, compound, { perspective: true, isolated: true });
  assert.equal(whole.when.filter((t) => t[1] === '@asserted').length, 2);
  assert.equal(whole.then.filter((t) => t[1] === '@asserted').length, 2);
  assert.equal(answer(compound, [compoundSource], [whole]).status, 'supported');

  const repairOnly = questionBranches(compoundSource).find((b) => b.root === 'r').graph;
  repairOnly.id = 'repair-only';
  const exactCompound = structuredClone(compound);
  exactCompound.nodes.find((n) => n.id === 'b').concept = 'bicycle';
  const partial = connectQuestion(exactCompound, repairOnly);
  assert.equal(partial.matches.length, 0, 'One branch does not affirm the whole compound');
  assert.equal(partial.branches.filter((b) => b.matches.length).length, 1);
  assert(partial.branches[0].matches[0].derivation);
  const composed = composeAnswer(exactCompound, repairOnly);
  assert.equal(composed.operation, 'supporting-partial-assertion');
  assert.equal(composed.branches.length, 1);
  assert.deepEqual(composed.graph, repairOnly, 'Retain only the authored supporting observation');

  // The same source port can occur in both independent clauses without creating
  // two participants. Separate source people cannot satisfy the shared query.
  const sharedQuery = structuredClone(compound);
  sharedQuery.id = 'shared-query';
  sharedQuery.nodes = sharedQuery.nodes.filter((n) => n.id !== 'q');
  sharedQuery.edges.find((e) => e.from === 's' && e.role === ':ARG0').to = 'p';
  const sharedSource = structuredClone(compoundSource);
  sharedSource.id = 'shared-source';
  sharedSource.nodes = sharedSource.nodes.filter((n) => n.id !== 'q');
  sharedSource.edges.find((e) => e.from === 's' && e.role === ':ARG0').to = 'p';
  const sharedParts = proposal(sharedQuery, sharedSource);
  assert.equal(sharedParts.length, 2);
  assert.notEqual(
    sharedParts[0].answerNodeId,
    sharedParts[1].answerNodeId,
    'Confirmation selectors distinguish branches sharing an answer',
  );
  assert.equal(
    answer(
      sharedQuery,
      [sharedSource],
      sharedParts.map((p) => p.rule),
    ).status,
    'supported',
  );
  assert.equal(
    answer(
      sharedQuery,
      [compoundSource],
      parts.map((p) => p.rule),
    ).status,
    'open',
  );
  assert.throws(
    () =>
      compileWording(compoundSource, compound, {
        perspective: true,
        isolated: true,
        answerNodeIds: { p: 'p', q: 'p' },
      }),
    /merges independent/u,
  );

  // Repeated roles are disambiguated by branch-local descriptions, not node order.
  const localSource = graph(
    'local',
    'r',
    { r: 'compare-01', a: 'item', b: 'item', x: 'red', y: 'blue', p: 'person', q: 'person' },
    [
      ['r', ':topic', 'a'],
      ['r', ':topic', 'b'],
      ['a', ':mod', 'x'],
      ['b', ':mod', 'y'],
      ['a', ':poss', 'p'],
      ['b', ':poss', 'q'],
    ],
  );
  const localQuery = structuredClone(localSource);
  localQuery.id = 'local-query';
  for (const n of localQuery.nodes) if (['p', 'q'].includes(n.id)) n.concept = 'amr-unknown';
  const localRule = compileWording(localSource, localQuery, { perspective: true, isolated: true });
  assert.equal(localRule.correspondence.ports.p, 'p');
  assert.equal(localRule.correspondence.ports.q, 'q');
  localQuery.nodes.reverse();
  localQuery.edges.reverse();
  assert.deepEqual(
    compileWording(localSource, localQuery, { perspective: true, isolated: true }).correspondence
      .ports,
    localRule.correspondence.ports,
  );
  const ambiguous = structuredClone(localSource);
  ambiguous.nodes.find((n) => n.id === 'y').concept = 'red';
  const ambiguousQuery = structuredClone(ambiguous);
  for (const n of ambiguousQuery.nodes) if (['p', 'q'].includes(n.id)) n.concept = 'amr-unknown';
  assert.throws(
    () => compileWording(ambiguous, ambiguousQuery, { perspective: true, isolated: true }),
    /participant|connection/u,
  );

  // Preserved boundaries: an embedded conjunction is not independent evidence;
  // polarity, modality, directed roles, and unknown source graphs stay protected.
  const embedded = structuredClone(compound);
  embedded.nodes.push({ id: 'm', concept: 'believe-01' });
  embedded.edges.push({ id: 'embedded', from: 'm', role: ':ARG1', to: embedded.top });
  embedded.top = 'm';
  assert.equal(questionBranches(embedded).length, 1);
  assert.equal(proposal(embedded, compoundSource).length, 0);
  assert.equal(connectQuestion(exactCompound, compound).matches.length, 0);
  const negative = structuredClone(repairOnly);
  negative.nodes.push({ id: 'neg', concept: '-', literal: '-' });
  negative.edges.push({ id: 'neg', from: negative.top, role: ':polarity', to: 'neg' });
  assert.equal(
    connectQuestion(exactCompound, negative).branches.filter((b) => b.matches.length).length,
    0,
  );
  const guarded = structuredClone(localSource);
  guarded.nodes.push({ id: 'neg', concept: '-', literal: '-' });
  guarded.edges.push({ id: 'neg', from: 'a', role: ':polarity', to: 'neg' });
  const moved = structuredClone(guarded);
  moved.edges.find((e) => e.id === 'neg').from = 'b';
  // Same shortest role path, different branch: scope comparison alone cannot see
  // the move. The full correspondence must preserve this located qualification.
  assert.throws(
    () => compileWording(guarded, moved, { perspective: true, isolated: true }),
    /negation|scope|qualification/u,
  );

  // Nested condition roles remain queryable within their asserted enclosing
  // relationship; this does not assert that the condition actually holds.
  const report = graph(
    'report',
    'r',
    { r: 'describe-01', h: 'handle-01', t: 'ticket', c: 'fail-01', d: 'device' },
    [
      ['r', ':topic', 'h'],
      ['h', ':ARG1', 't'],
      ['h', ':condition', 'c'],
      ['c', ':ARG1', 'd'],
    ],
  );
  const reportQuery = structuredClone(report);
  reportQuery.id = 'report-query';
  reportQuery.nodes.find((n) => n.id === 'd').concept = 'amr-unknown';
  reportQuery.nodes.find((n) => n.id === 't').concept = 'request';
  const reportProposals = proposal(reportQuery, report);
  assert.equal(reportProposals.length, 1);
  assert.equal(reportProposals[0].answerNodeId, 'd');
  assert.deepEqual(selected(answer(reportQuery, [report], [reportProposals[0].rule])), ['device']);
  const conditionAlone = graph('condition-alone', 'c', { c: 'fail-01', d: 'amr-unknown' }, [
    ['c', ':ARG1', 'd'],
  ]);
  assert.equal(answer(conditionAlone, [report], [reportProposals[0].rule]).status, 'open');

  // A constrained answer retains an unchanged nested description and its shared
  // source port instead of fabricating an answer with the same display label.
  const constrained = structuredClone(reportQuery);
  constrained.id = 'constrained';
  constrained.nodes.find((n) => n.id === 'd').concept = 'device';
  constrained.nodes.find((n) => n.id === 'h').concept = 'amr-unknown';
  assert.equal(proposal(constrained, report).length, 1);
  assert.equal(
    answer(constrained, [report], [proposal(constrained, report)[0].rule]).status,
    'supported',
  );

  const forcedShared = structuredClone(sharedQuery);
  assert.throws(
    () =>
      compileWording(compoundSource, forcedShared, {
        perspective: true,
        isolated: true,
        answerNodeId: 'p',
      }),
    /shared port|independent participants/u,
  );

  const separatePeople = graph('separate-people', 'r', { r: 'see-01', p: 'person', q: 'person' }, [
    ['r', ':ARG0', 'p'],
    ['r', ':ARG1', 'q'],
  ]);
  const selfReference = graph('self-reference', 'r', { r: 'see-01', p: 'person' }, [
    ['r', ':ARG0', 'p'],
    ['r', ':ARG1', 'p'],
  ]);
  assert.throws(
    () => compileWording(separatePeople, selfReference),
    /shared reference|independent participants/u,
  );

  // Explicit remaining blocker: a root conditional's antecedent is not an
  // asserted consequence and cannot be queried through a conclusion perspective.
  const policy = graph(
    'policy',
    'h',
    { h: 'handle-01', p: 'team', t: 'ticket', c: 'fail-01', m: 'device' },
    [
      ['h', ':ARG0', 'p'],
      ['h', ':ARG1', 't'],
      ['h', ':condition', 'c'],
      ['c', ':ARG1', 'm'],
    ],
  );
  const conditionQuery = structuredClone(policy);
  conditionQuery.id = 'condition-query';
  conditionQuery.nodes.find((n) => n.id === 'm').concept = 'amr-unknown';
  assert.equal(proposal(conditionQuery, policy).length, 0);
  assert.throws(
    () => compileWording(policy, conditionQuery, { perspective: true, isolated: true }),
    /condition|negation/u,
  );
  console.log(
    'ok compositional correspondence: nested and multiple slots, branch-local occurrences, partial clauses, shared ports; conditional-policy introspection remains blocked',
  );
}
