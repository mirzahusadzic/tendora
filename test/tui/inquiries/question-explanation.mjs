/** Retained gaps must explain an open answer without declaring matches to be proofs. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { questionExplanation } from '../../../src/tui/inquiries/question-explanation.mjs';
import { journeySection, sourceStatements } from '../../../src/tui/inquiries/journey-view.mjs';
import { relationMeaning } from '../../../src/tui/concepts/meaning.mjs';

const fixture = JSON.parse(
  await readFile(new URL('../../support/open-question-diagnostics.json', import.meta.url)),
);
const relations = new Map(
  relationMeaning(fixture.graph, { question: true }).relations.map((row) => [row.edgeId, row]),
);
const run = {
  status: 'open',
  scopePlacementId: 'root',
  answer: { answers: [], partial: { parts: [] }, openings: fixture.openings },
};
const before = structuredClone(run);
const explanation = questionExplanation(run, relations);
const needs = explanation.table.entries.map((entry) => entry.cells[0]);
assert.equal(needs.length, 3, 'One missing assertion, one relationship and one reference');
assert(needs.includes('“recommend”'));
assert(needs.includes('handle / thing handled: ticket'));
assert(needs.includes('“this ticket”'));
assert.doesNotMatch(
  needs.join('\n'),
  /team|answer sought/u,
  'Matched parts are not reported absent',
);
assert.equal(needs.filter((need) => need.includes('recommend')).length, 1, 'No duplicate gap');
assert.deepEqual(run, before, 'Rendering cannot change the saved assessment');

// A relation whose words a source shares, read differently, is not missing.
const restructured = {
  kind: 'relation',
  state: 'unmatched',
  from: 'schedule-01',
  role: ':ARG1',
  to: 'freeze-01',
};
const sameWordsReason = (wording) =>
  questionExplanation(
    {
      answer: {
        openings: [restructured],
        clarifications: [{ sharedWording: wording }],
      },
    },
    new Map(),
  ).table.entries[0].cells[1];
assert.equal(
  sameWordsReason('crates scheduled for freezing'),
  'A source says “crates scheduled for freezing” too, but each was read differently. Confirm the connection to use it.',
);
assert.equal(
  sameWordsReason('intake registrar'),
  'No source connects these participants in this relationship.',
  'Shared words elsewhere do not explain this relation',
);
const describe = (opening) =>
  questionExplanation({ answer: { openings: [opening] } }, new Map()).table.entries[0].cells;
assert.match(
  describe({ kind: 'assertion', state: 'unasserted', concept: 'approve-01' })[1],
  /Mentioned.*not established as a fact/u,
  'A conditional or nested mention is not an asserted fact',
);
assert.match(
  describe({ kind: 'relation', state: 'unjoined' })[1],
  /Matching relationships occur.*do not join/u,
  'Matching all the individual relations still need not give one consistent answer',
);
assert.match(
  describe({ kind: 'relation', state: 'unresolved' })[1],
  /not established as missing/u,
  'An incomplete search cannot assert that evidence is absent',
);
assert.match(
  describe({
    kind: 'condition',
    state: 'unmatched',
    from: 'inspect-01',
    role: ':ARG1',
    to: 'rig',
  })[1],
  /condition is not established for the same participants/u,
);
assert.match(describe({ kind: 'scope' })[1], /polarity or conditions/u);
assert.match(describe({ kind: 'connection' })[1], /participants that have not been joined/u);
assert.match(
  describe({ kind: 'question', state: 'unresolved' })[1],
  /retained reading has no relationship/u,
);
for (const [status, reason] of [
  ['conflict', /conflicting answers/u],
  ['ambiguous', /Several answers fit/u],
  ['limited', /reached its limit/u],
])
  assert.match(questionExplanation({ status }, new Map()).table.entries[0].cells[1], reason);

// The explanation belongs to the whole question, even when the selected role
// has no relevant source. Related sources stay inspectable and are not answers.
const source = {
  id: 'team-source-0',
  kind: 'source',
  placementId: 'teams',
  sentenceId: 's1',
  text: 'The billing team handles payout failures.',
  graph: { nodes: [], edges: [] },
};
const data = {
  concepts: [
    { id: 'c', name: 'Company' },
    { id: 't', name: 'Teams' },
  ],
  placements: [
    { id: 'root', conceptId: 'c' },
    { id: 'teams', conceptId: 't', parentId: 'root' },
  ],
};
const result = {
  inputs: [{ kind: 'question', graph: fixture.graph }, source],
  exploration: { visits: [{ nodeId: 'root' }], checks: [] },
};
const recording = {
  graphs: [],
  visits: [{ id: 'v', nodeId: 'root', return: { childVisitIds: [] } }],
  nodes: [
    { id: 'root', label: 'Company' },
    { id: 'teams', label: 'Teams' },
  ],
  routing: { status: 'unavailable', reason: 'Old saved message: press r to retry.' },
};
const context = {
  project: { data },
  run,
  input: { question: { text: fixture.question } },
  result,
  recording,
};
const section = journeySection(context, 'root');
assert.equal(section.groups[0].heading, 'Why no answer');
assert.deepEqual(
  section.rows.find(([label]) => label === 'Checked'),
  ['Checked', '1 role, 1 source statement.'],
);
const related = section.groups.find((group) => group.heading === 'Related statements');
assert.equal(related.table.entries[0].source, source, 'The exact related source can be opened');
assert(related.table.entries[0].choiceIndex < 0);
assert.match(related.rows[0][1], /do not establish a complete answer/u);
assert.doesNotMatch(JSON.stringify(section), /press r|Next|Used in the answer proof/u);
// The role the question was asked at shows every proposal in its scope, with
// where it was found and the words read differently.
const scopedProposal = {
  question: { text: fixture.question },
  source: { nodeId: 'teams', text: 'The billing team handles payout failures.' },
  answerNodeId: 'p',
  answerLabel: 'billing team',
  sharedWording: 'payout failures',
};
const proposed = journeySection(
  { ...context, run: { ...run, answer: { ...run.answer, clarifications: [scopedProposal] } } },
  'root',
).groups.find((group) => group.heading === 'A connection needs your interpretation');
assert.deepEqual(
  proposed.rows.filter(([label]) => ['At', 'Read differently'].includes(label)),
  [
    ['At', 'Company → Teams'],
    ['Read differently', 'Both say “payout failures”.', 'warning'],
  ],
);
const elsewhere = journeySection(context, 'outside');
assert.equal(elsewhere.groups[0].heading, 'Why no answer');
assert(elsewhere.groups.some((group) => group.heading === 'Outside this question'));

// Archive's retained person match does not prove the query's curator modifier.
// A partial may carry that label even though the curate relation was omitted.
const archiveQuestion = {
  top: 'repair',
  nodes: [
    { id: 'repair', concept: 'repair-01', surfaceLabel: 'repair' },
    { id: 'person', concept: 'person', surfaceLabel: 'curator', authoredLabel: 'the curator' },
    { id: 'curate', concept: 'curate-01', surfaceLabel: 'curator' },
  ],
  edges: [
    { id: 'agent', from: 'repair', role: ':ARG0', to: 'person' },
    { id: 'curator', from: 'curate', role: ':ARG0', to: 'person' },
  ],
};
const conservator = {
  id: 'archive/source',
  kind: 'source',
  placementId: 'root',
  text: 'The conservator repairs damaged bindings.',
  graph: {
    top: 'r',
    nodes: [
      { id: 'r', concept: 'repair-01', surfaceLabel: 'repairs' },
      { id: 'p', concept: 'person' },
      { id: 'c', concept: 'conserve-01', surfaceLabel: 'conservator' },
    ],
    edges: [
      { id: 'agent', from: 'r', role: ':ARG0', to: 'p' },
      { id: 'occupation', from: 'c', role: ':ARG0', to: 'p' },
    ],
  },
};
const partial = {
  graph: {
    ...archiveQuestion,
    nodes: archiveQuestion.nodes.slice(0, 2),
    edges: archiveQuestion.edges.slice(0, 1),
  },
  sourceIds: [conservator.id],
  bindings: [
    { nodeId: 'repair', id: `${conservator.id}#r` },
    { nodeId: 'person', id: `${conservator.id}#p` },
  ],
  witnesses: [
    JSON.stringify([`${conservator.id}#r`, ':instance', 'repair-01']),
    JSON.stringify([`${conservator.id}#p`, ':instance', 'person']),
    JSON.stringify([`${conservator.id}#r`, ':ARG0', `${conservator.id}#p`]),
  ],
};
const archiveContext = {
  ...context,
  run: {
    ...run,
    answer: {
      answers: [],
      partial: { parts: [partial] },
      openings: [
        {
          kind: 'relation',
          edgeId: 'curator',
          from: 'curate-01',
          role: ':ARG0',
          to: 'person',
          state: 'unmatched',
        },
      ],
    },
  },
  input: { question: { text: 'Does the curator repair damaged bindings?' } },
  result: {
    inputs: [{ kind: 'question', graph: archiveQuestion }, conservator],
    exploration: { visits: [{ nodeId: 'root' }], checks: [] },
  },
};
const partialBefore = structuredClone(partial);
const archiveSection = journeySection(archiveContext, 'root');
assert.equal(archiveSection.groups[0].heading, 'Supported part at Company');
assert.deepEqual(archiveSection.groups[0].rows, [
  ['Source', 'The conservator repairs damaged bindings.', 'input'],
  ['State', 'Supported part; question remains open.', 'warning'],
]);
assert.equal(archiveSection.groups[0].rowChoices[0].source, conservator);
assert(archiveSection.groups[0].rowChoices[0].choiceIndex < 0);
const supported = archiveSection.groups.find((group) => group.heading === 'Supported relationship');
assert.deepEqual(supported.table.entries[0].cells, ['repairs', 'repairer, agent', 'person']);
assert.doesNotMatch(JSON.stringify(supported), /curator|curate/u);
assert.match(
  JSON.stringify(archiveSection.groups.find((group) => group.heading === 'Why no answer')),
  /curator/u,
  'Unproved query description remains a visible gap',
);
assert.deepEqual(
  partial,
  partialBefore,
  'Display must not mutate partial graphs or their evidence',
);

const resolvedWithParts = {
  ...archiveContext,
  run: {
    ...archiveContext.run,
    status: 'supported',
    answer: {
      answers: [
        {
          text: 'Yes',
          sourceIds: [conservator.id],
          ruleIds: [],
          qualifications: [],
        },
      ],
      partial: { parts: [partial] },
      openings: [],
    },
  },
};
assert.deepEqual(
  journeySection(resolvedWithParts, 'root').rows.find(([label]) => label === 'Answer'),
  ['Answer', 'Yes', 'located'],
  'The resolved answer remains the substantive result',
);
assert(
  !journeySection(resolvedWithParts, 'root').groups.some(
    (group) => group.heading === 'Why no answer' || group.heading.startsWith('Supported part'),
  ),
  'Resolved answers do not render open diagnostics or internal partial summaries',
);

// A descendant's part is materialized at its source role, while an ancestor
// role says only that the support lies below. It must not claim the part itself.
const nestedData = {
  concepts: [
    { id: 'c', name: 'Company' },
    { id: 'm', name: 'Operations' },
    { id: 't', name: 'Teams' },
  ],
  placements: [
    { id: 'root', conceptId: 'c' },
    { id: 'operations', conceptId: 'm', parentId: 'root' },
    { id: 'teams', conceptId: 't', parentId: 'operations' },
  ],
};
const nestedSource = { ...conservator, id: 'teams/source', placementId: 'teams' };
const nestedPartial = structuredClone(partial);
nestedPartial.sourceIds = [nestedSource.id];
nestedPartial.bindings = nestedPartial.bindings.map((binding) => ({
  ...binding,
  id: binding.id.replace(conservator.id, nestedSource.id),
}));
nestedPartial.witnesses = nestedPartial.witnesses.map((witness) =>
  witness.replaceAll(`${conservator.id}#`, `${nestedSource.id}#`),
);
const nestedContext = {
  ...archiveContext,
  project: { data: nestedData },
  run: {
    ...archiveContext.run,
    answer: { answers: [], partial: { parts: [nestedPartial] }, openings: [] },
  },
  result: {
    inputs: [{ kind: 'question', graph: archiveQuestion }, nestedSource],
    exploration: { visits: [{ nodeId: 'root' }], checks: [] },
  },
  recording: {
    graphs: [],
    visits: [
      { id: 'v1', nodeId: 'root', return: { childVisitIds: ['v2'] } },
      { id: 'v2', nodeId: 'operations', parentVisitId: 'v1', return: { childVisitIds: ['v3'] } },
      { id: 'v3', nodeId: 'teams', parentVisitId: 'v2', return: { childVisitIds: [] } },
    ],
    nodes: [
      { id: 'root', label: 'Company' },
      { id: 'operations', label: 'Operations' },
      { id: 'teams', label: 'Teams' },
    ],
    routing: { status: 'unavailable' },
  },
};
const nestedSection = journeySection(nestedContext, 'root');
assert.equal(nestedSection.groups[0].heading, 'Supported part at Teams');
const rolesTable = nestedSection.groups.find(
  (group) => group.heading === 'Continue through the roles',
).table;
assert.equal(
  rolesTable.entries.find((entry) => entry.cells[0] === 'Operations').cells[1],
  'Supported part in a child role',
);

// Source labels require both an attributed binding and its instance witness.
conservator.graph.nodes[1].surfaceLabel = 'conservator';
const named = journeySection(archiveContext, 'root').groups.find(
  (group) => group.heading === 'Supported relationship',
);
assert.equal(named.table.entries[0].cells[2], 'conservator');
partial.witnesses = partial.witnesses.filter(
  (fact) => !fact.includes(':instance') || !fact.includes('#p'),
);
const unwitnessed = journeySection(archiveContext, 'root').groups.find(
  (group) => group.heading === 'Supported relationship',
);
assert.equal(unwitnessed.table.entries[0].cells[2], 'person');

// A polar connection is a source/question interpretation, never an answer participant.
const proposalContext = structuredClone(context);
proposalContext.run.answer.clarifications = [
  {
    question: { text: 'Does the steward repair bindings?' },
    source: { nodeId: 'root', text: 'The conservator repairs bindings.' },
    answerNodeId: null,
    answerLabel: 'This relationship',
  },
];
const proposal = journeySection(proposalContext, 'root').groups.find(
  (group) => group.heading === 'A connection needs your interpretation',
);
assert.deepEqual(proposal.rows, [
  ['Question', 'Does the steward repair bindings?', 'input'],
  ['Source', 'The conservator repairs bindings.', 'input'],
]);
proposalContext.run.answer.clarifications[0].answerNodeId = 'person';
proposalContext.run.answer.clarifications[0].answerLabel = 'the conservator';
assert.deepEqual(
  journeySection(proposalContext, 'root')
    .groups.find((group) => group.heading === 'A connection needs your interpretation')
    .rows.at(-1),
  ['Possible participant', 'the conservator', 'warning'],
);

// A used confirmation shows what was connected, including the supporting text.
proposalContext.project.data.contributions = [
  {
    id: 'contribution-1',
    wordings: [
      {
        id: 'wording-1',
        kind: 'clarification',
        text: 'Does the steward repair bindings?',
        basisSources: [{ text: 'The conservator repairs bindings.' }],
      },
    ],
  },
];
proposalContext.run.answer.answers = [
  {
    text: 'Yes',
    sourceIds: [],
    ruleIds: ['contribution-1/wording-1'],
  },
];
assert.deepEqual(
  journeySection(proposalContext, 'root').groups.find(
    (group) => group.heading === 'Uses your confirmed connection',
  ).rows,
  [
    ['Confirmed question', 'Does the steward repair bindings?', 'input'],
    ['Source', 'The conservator repairs bindings.', 'input'],
  ],
);
// Selecting a statement presents why its reading is flagged, or how it was read.
const repairs = {
  top: 'r',
  nodes: [
    { id: 'r', concept: 'repair-01' },
    { id: 's', concept: 'steward' },
  ],
  edges: [{ id: 'e', from: 'r', role: ':ARG0', to: 's' }],
};
const [plain, flagged, unread, timed] = sourceStatements(
  [
    { id: 'a', text: 'The steward repairs.', graph: repairs },
    {
      id: 'b',
      text: 'The steward marks the binding.',
      graph: repairs,
      lexicalAudit: {
        findings: [
          {
            predicate: 'tattoo-01',
            status: 'unverified',
            description: 'to mark the skin with permanent colors and patterns',
          },
        ],
      },
    },
    { id: 'c', text: 'Not yet read.' },
    {
      id: 'd',
      text: 'The van collects crates at four in the afternoon.',
      graph: repairs,
      lexicalAudit: {
        findings: [
          {
            predicate: '14:00',
            status: 'unattested',
            description: 'A clock time',
            reason: 'The reading has 14:00, but the text gives no such time.',
          },
        ],
      },
    },
  ],
  {},
).entries.map((entry) => entry.preview);
assert.match(plain[0], /^Read as repair: .*steward$/u);
assert.deepEqual(flagged, [
  'Read as “to mark the skin with permanent colors and patterns” (tattoo), but no word in the text says so.',
]);
assert.deepEqual(unread, ['No reading retained for this text yet.']);
assert.deepEqual(timed, ['The reading has 14:00, but the text gives no such time.']);
console.log(
  'ok open questions explain global evidence gaps, preserve diagnostic states and expose related sources without claiming an answer; selected statements preview their reading',
);
