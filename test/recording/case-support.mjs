import {
  continuationContext,
  continuationOpenings,
  validateContinuation,
} from '../../src/recording/continuation.mjs';
import { createContent } from '../../src/tui/shell/content.mjs';
import { createText } from '../../src/tui/shell/text.mjs';
import assert from 'node:assert/strict';
import {
  compareContextEvents,
  unmatchedContextDifferences,
} from '../../src/amr/context-comparison.mjs';
import { caseReference, caseSupport, carriedSupport } from '../../src/recording/case-support.mjs';
import { compareGraphs } from '../../src/amr/comparison.mjs';
import { inquiryContextLinks, rankedFindings } from '../../src/tui/recordings/view.mjs';

const graph = (top, concepts, edges) => ({
  top,
  nodes: Object.entries(concepts).map(([id, concept]) => ({ id, concept })),
  edges: edges.map(([from, role, to], i) => ({ id: `e${i}`, from, role, to })),
});
const runtime = (g) => ({
  top: g.top,
  labels: new Map(g.nodes.map((n) => [n.id, n.concept])),
  edges: g.edges,
});
function fixture() {
  const query = graph(
    'recommend',
    {
      recommend: 'recommend-01',
      action: 'process-01',
      unit: 'unit',
      unknown: 'amr-unknown',
      case: 'sample',
    },
    [
      ['recommend', ':ARG1', 'action'],
      ['action', ':ARG0', 'unit'],
      ['unit', ':mod', 'unknown'],
      ['action', ':ARG1', 'case'],
    ],
  );
  const carried = graph('event', { event: 'leak-01', object: 'container' }, [
    ['event', ':ARG1', 'object'],
  ]);
  const local = graph(
    'action',
    { action: 'process-01', unit: 'unit', event: 'leak-01', object: 'container' },
    [
      ['action', ':ARG0', 'unit'],
      ['action', ':ARG1', 'event'],
      ['event', ':ARG1', 'object'],
    ],
  );
  const other = graph(
    'action',
    { action: 'process-01', unit: 'unit', name: 'other', event: 'issue' },
    [
      ['action', ':ARG0', 'unit'],
      ['unit', ':mod', 'name'],
      ['action', ':ARG1', 'event'],
    ],
  );
  const occurrences = ['local', 'other'].map((id) => ({
    id,
    nodeId: id,
    sourceId: id,
    concept: 'unit',
    sourceEventNodeId: 'unit',
    requiredRefs: [{ eventNode: 'unit' }],
    bindings: id === 'other' ? [{ queryNodeId: 'unknown', sourceNodeId: 'name' }] : [],
  }));
  const visits = [
    { id: 'root', nodeId: 'case', parentVisitId: null, occurrenceIds: [], contextChecks: [] },
    ...occurrences.map((o) => ({
      id: o.id,
      nodeId: o.nodeId,
      parentVisitId: 'root',
      occurrenceIds: [o.id],
      contextChecks: [
        {
          inheritedSourceId: 'carried',
          localSourceId: o.sourceId,
          anchors: compareContextEvents(
            runtime(carried),
            runtime(o.id === 'local' ? local : other),
          ),
        },
      ],
    })),
  ];
  const ix = {
    recording: {
      inquiry: { graphId: 'query' },
      caseState: { rootNodeId: 'case' },
      occurrences,
      visits,
    },
    graphs: new Map(Object.entries({ query, carried, local, other })),
    sources: new Map(
      ['carried', 'local', 'other'].map((id) => [id, { id, graphId: id, affinity: 0.5 }]),
    ),
    nodes: new Map([
      ['case', { id: 'case', label: 'Sample', sourceIds: ['carried'] }],
      ...['local', 'other'].map((id) => [id, { id, label: id, sourceIds: [id] }]),
    ]),
    visits: new Map(visits.map((v) => [v.id, v])),
  };
  return { ix, query, carried, local, occurrence: occurrences[0] };
}
const support = ({ ix, query, local, occurrence }) =>
  caseSupport(
    ix,
    occurrence,
    compareGraphs(query, local, { queryEvent: 'unit', sourceEvent: 'unit' }),
  );
const carried = ({ ix, query, local, occurrence }) =>
  carriedSupport(
    ix,
    occurrence,
    compareGraphs(query, local, { queryEvent: 'unit', sourceEvent: 'unit' }),
  );
{
  const f = fixture();
  f.ix.recording.version = 2;
  assert.equal(caseReference(f.ix).status, 'unresolved');
  assert.equal(support(f).connections.length, 0);
  assert.equal(carried(f).linked, 1);
  assert.deepEqual(
    rankedFindings(f.ix).map((item) => [item.id, item.carried, item.caseLinked]),
    [
      ['local', 1, 0],
      ['other', 0, 0],
    ],
  );
  const anchors = f.ix.visits.get('local').contextChecks[0].anchors;
  anchors.push(structuredClone(anchors[0]));
  assert.equal(carried(f).linked, 1, 'repeated anchors cannot multiply ranking evidence');
}
{
  const f = fixture(),
    original = JSON.stringify(f.ix.recording);
  const proof = support(f);
  assert.equal(proof.reference.status, 'bound');
  assert.equal(proof.connections.length, 1);
  assert.equal(proof.connections[0].queryEdgeId, 'e3');
  assert.deepEqual(proof.connections[0].path, [{ queryEdgeId: 'e1', sourceEdgeId: 'e0' }]);
  assert.deepEqual(proof.connections[0].witnesses, [{ fromEdgeId: 'e0', sourceEdgeId: 'e2' }]);
  const ranked = rankedFindings(f.ix);
  assert.deepEqual(
    ranked.map((r) => [r.id, r.caseLinked, r.direct]),
    [
      ['local', 1, 1],
      ['other', 0, 2],
    ],
  );
  const links = inquiryContextLinks(f.ix, f.occurrence);
  assert(links.forSourceEdge('local', 'e2').some((r) => r.ref === 'Q4' && r.basis === 'case'));
  assert.deepEqual(links.forSourceEdge('other', 'e2'), []);
  assert.equal(links.relations.find((r) => r.ref === 'Q4').status, 'case-supported');
  assert.equal(links.assessment.unsupported, 2);
  assert.equal(ranked[0].unresolved, 2);
  assert.equal(ranked[0].matched, 1);
  assert.equal(JSON.stringify(f.ix.recording), original);
  // Repeated fixed-event checks cannot multiply a connection.
  const anchors = f.ix.visits.get('local').contextChecks[0].anchors;
  anchors.push(structuredClone(anchors[0]));
  assert.equal(support(f).connections.length, 1);
}
{
  const f = fixture();
  f.local.edges.find((e) => e.id === 'e1').role = ':ARG2';
  assert.equal(support(f).connections.length, 0, 'wrong argument does not support the case');
  assert.equal(carried(f).linked, 0, 'wrong argument cannot improve carried ranking');
}
{
  const f = fixture();
  f.local.nodes.push({ id: 'second', concept: 'process-01' });
  f.local.edges.find((e) => e.id === 'e1').from = 'second';
  assert.equal(
    support(f).connections.length,
    0,
    'a different processing event cannot lend its object',
  );
  assert.equal(carried(f).linked, 0, 'a different source event cannot improve carried ranking');
}
{
  const f = fixture();
  f.query.nodes.push({ id: 'second', concept: 'sample' });
  assert.equal(caseReference(f.ix).status, 'ambiguous');
  assert.equal(support(f).connections.length, 0);
}
{
  const f = fixture();
  f.ix.recording.caseState = null;
  assert.equal(support(f).connections.length, 0);
  assert.equal(carried(f).linked, 0);
}
{
  const f = fixture();
  f.carried.nodes.push({ id: 'minus', concept: '-' });
  f.carried.edges.push({ id: 'negative', from: 'event', role: ':polarity', to: 'minus' });
  const proof = support(f);
  assert.equal(proof.connections[0].status, 'polarity');
  assert.deepEqual(proof.connections[0].polarities.carried, ['negative']);
  assert.equal(rankedFindings(f.ix).find((r) => r.id === 'local').caseLinked, 0);
  assert.equal(carried(f).linked, 0, 'polarity remains an opening');
}
{
  const f = fixture();
  f.ix.visits.get('local').contextChecks[0].anchors[0].complete = false;
  assert.equal(support(f).connections.length, 0);
  assert.equal(carried(f).linked, 0, 'partial searches cannot improve carried ranking');
}
{
  const f = fixture();
  const inherited = graph(
    'possible',
    {
      possible: 'possible-01',
      require: 'require-01',
      event: 'leak-01',
      frequent: 'frequent-02',
      attention: 'attend-02',
    },
    [
      ['possible', ':ARG1', 'require'],
      ['require', ':ARG0', 'event'],
      ['require', ':ARG1', 'attention'],
      ['attention', ':ARG1', 'event'],
      ['frequent', ':ARG1', 'event'],
    ],
  );
  f.local.nodes.push({ id: 'frequent', concept: 'frequent-02' });
  f.local.edges.push({ id: 'frequency', from: 'frequent', role: ':ARG1', to: 'event' });
  f.ix.graphs.set('inherited', inherited);
  f.ix.sources.set('inherited', { id: 'inherited', graphId: 'inherited' });
  f.ix.nodes.set('ancestor', { id: 'ancestor', label: 'Ancestor', sourceIds: ['inherited'] });
  const visit = { id: 'ancestor', nodeId: 'ancestor', parentVisitId: 'root', occurrenceIds: [] };
  f.ix.visits.set('ancestor', visit);
  f.ix.recording.visits.push(visit);
  f.ix.visits.get('local').parentVisitId = 'ancestor';
  const anchors = compareContextEvents(runtime(inherited), runtime(f.local));
  f.ix.visits
    .get('local')
    .contextChecks.push({ inheritedSourceId: 'inherited', localSourceId: 'local', anchors });
  const proof = support(f);
  assert.equal(proof.connections.length, 2);
  const inheritedProof = proof.connections.find((item) => !item.rootCase);
  assert.equal(inheritedProof.status, 'scoped');
  assert.deepEqual(inheritedProof.contextRoute, ['case', 'ancestor']);
  assert.deepEqual(inheritedProof.scopePath, ['e0', 'e1']);
  assert.equal(rankedFindings(f.ix).find((r) => r.id === 'local').caseLinked, 1);
  const eventAnchor = anchors.find((item) => item.concept === 'leak-01');
  assert.deepEqual(eventAnchor.differences, [{ fromEdgeId: 'e3', sourceEdgeId: 'e1' }]);
  const legacy = {
    ...eventAnchor,
    differences: [
      ...eventAnchor.differences,
      { fromEdgeId: 'e4', sourceEdgeId: 'e1' },
      { fromEdgeId: 'e3', sourceEdgeId: 'frequency' },
    ],
  };
  assert.deepEqual(unmatchedContextDifferences(legacy), eventAnchor.differences);
  // Continuation carries only the selected opening's attributed evidence.
  f.ix.recording.project = { id: 'project', path: '/example/project.json', placementId: 'case' };
  f.ix.recording.inquiry.text = 'Which unit should process this sample?';
  for (const [id, graph] of f.ix.graphs) graph.id = id;
  for (const [id, source] of f.ix.sources) source.text = `Source ${id}`;
  const openings = continuationOpenings(f.ix, f.occurrence);
  assert.deepEqual(
    openings.map((item) => item.status),
    ['open', 'open', 'case-supported'],
  );
  assert.equal(openings.at(-1).scoped, true);
  const context = continuationContext(
    f.ix,
    f.occurrence,
    [],
    '/example/parent.json',
    openings.findIndex((item) => item.edge.id === 'e3'),
  );
  const restored = validateContinuation(JSON.parse(JSON.stringify(context)));
  assert.equal(restored.caseEvidence.ref, 'Q4');
  assert.equal(restored.opening.status, 'case-supported');
  assert.equal(restored.opening.scoped, true);
  assert.equal(restored.caseEvidence.contexts.length, 2);
  assert.deepEqual(restored.caseEvidence.connections.find((item) => !item.rootCase).scopePath, [
    'e0',
    'e1',
  ]);
  const broken = structuredClone(restored);
  broken.caseEvidence.connections[0].scopePath = ['missing'];
  assert.throws(() => validateContinuation(broken), /Invalid continuation case evidence/);
  const otherOpening = continuationContext(
    f.ix,
    f.occurrence,
    [],
    '/example/parent.json',
    openings.findIndex((item) => item.edge.id === 'e0'),
  );
  assert.equal(otherOpening.caseEvidence, undefined);
  const state = {
    form: {
      continuation: restored,
      fields: [],
      inquiry: true,
      caseState: true,
      caseLabel: 'Sample',
    },
  };
  const text = createText({ noColor: true });
  const content = createContent({ state, text, recordingContent: {}, selectedConcept: () => null });
  const rows = content.contentRows(null);
  assert(!rows.some((item) => item.text === 'Case connections'));
  assert(!rows.some((item) => item.text === 'Previous questions · read only'));
  for (const width of [50, 100, 140])
    assert(
      rows.flatMap((item) => text.wrap(item, width)).every((item) => item.text.length <= width),
    );
  // Sibling context cannot borrow the connection from another branch.
  f.ix.visits.get('local').parentVisitId = 'root';
  assert.equal(support(f).connections.length, 1);
  // Inherited overlap cannot create case support without a root witness.
  f.ix.visits.get('local').parentVisitId = 'ancestor';
  f.ix.visits.get('local').contextChecks.shift();
  assert.equal(support(f).connections.length, 0);
  assert.equal(carried(f).linked, 0, 'inherited overlap cannot replace selected-case evidence');
}
console.log(
  'ok case connections retain exact event, argument, source and path witnesses without closing inquiry relations',
);
