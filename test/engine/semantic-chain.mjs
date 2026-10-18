/** General roles and connected reuse: independent domain, order and ablation. */
import assert from 'node:assert/strict';
import { traceInquiry } from '../../src/engine/semantic-chain.mjs';
import { prepareGraphs, normalizedRoleProfile } from '../../src/models/graph-preparation.mjs';
import { compareGraphs } from '../../src/models/semantic-comparison.mjs';
import { expandRelation, verifyEnvelope } from '../../src/amr/fragment-composition.mjs';

const entries = [
  {
    id: 'calibration',
    text: 'Mira calibrates the spectral instrument.',
    penman:
      '(c / calibrate-01 :ARG0 (t / technician :name (n / name :op1 "Mira")) :ARG1 (i / instrument :mod (s / spectral)))',
  },
  {
    id: 'maintenance',
    text: 'Mira maintains the instrument.',
    penman:
      '(m / maintain-01 :ARG0 (t / technician :name (n / name :op1 "Mira")) :ARG1 (i / instrument))',
  },
  {
    id: 'case',
    text: 'The spectral instrument is defective.',
    penman: '(i / instrument :mod (s / spectral) :mod (d / defective))',
  },
  {
    id: 'question',
    text: 'Which technician calibrates the instrument?',
    penman:
      '(c / calibrate-01 :ARG0 (t / technician :mod (u / amr-unknown)) :ARG1 (i / instrument))',
  },
  {
    id: 'delivery',
    text: 'Mira sends a parcel to Rafi.',
    penman:
      '(s / send-01 :ARG0 (m / person :name (n / name :op1 "Mira")) :ARG1 (p / parcel) :ARG2 (r / person :name (n2 / name :op1 "Rafi")))',
  },
  {
    id: 'recipient',
    text: 'To whom does Mira send the parcel?',
    penman:
      '(s / send-01 :ARG0 (m / person :name (n / name :op1 "Mira")) :ARG1 (p / parcel) :ARG2 (u / amr-unknown))',
  },
  {
    id: 'quantity',
    text: 'The parcel weighs three units.',
    penman: '(w / weigh-01 :ARG1 (p / parcel) :ARG2 3)',
  },
  {
    id: 'quantity-question',
    text: 'How much does the parcel weigh?',
    penman: '(w / weigh-01 :ARG1 (p / parcel) :ARG2 (u / amr-unknown))',
  },
];
const prepared = await prepareGraphs(
  entries.map(({ penman }) => ({ penman })),
  { profile: normalizedRoleProfile },
);
const inputs = entries.map((entry, i) => ({ ...entry, ...prepared.results[i] }));
const input = {
  sources: inputs.slice(0, 2),
  cases: [inputs[2]],
  question: inputs[3],
  openings: [],
};
// Memoize exact client requests within this test; each first result uses the real
// implementation. Reordering must leave maps and independently checked reuse intact.
const cache = new Map();
const clients = {
  prepare: prepareGraphs,
  async compare(pairs, options) {
    const absent = pairs.filter((pair) => !cache.has(JSON.stringify(pair)));
    if (absent.length) {
      const batch = await compareGraphs(absent, options);
      absent.forEach((pair, i) => cache.set(JSON.stringify(pair), batch.results[i]));
    }
    return { results: pairs.map((pair) => cache.get(JSON.stringify(pair))) };
  },
};
const result = await traceInquiry(input, { clients });
assert.equal(result.candidates[0].text, 'Mira');
assert.equal(result.candidates[0].role, ':ARG0');
assert(result.applications.some((application) => application.sourceId === 'calibration'));
assert(result.chains.some((chain) => chain.otherSourceId === 'maintenance'));
for (const definition of result.definitions) {
  const source = inputs.find((source) => source.id === definition.sourceId);
  const expanded = expandRelation(definition);
  assert.equal(expanded.top, source.graph.top);
  assert.deepEqual(
    expanded.nodes.sort((a, b) => a.id.localeCompare(b.id)),
    structuredClone(source.graph.nodes).sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.deepEqual(
    expanded.edges.sort((a, b) => a.id.localeCompare(b.id)),
    structuredClone(source.graph.edges).sort((a, b) => a.id.localeCompare(b.id)),
  );
}
for (const application of result.applications) {
  assert(
    verifyEnvelope(
      inputs.find((source) => source.id === application.sourceId).graph,
      application.composition,
      0,
    ),
  );
  assert(verifyEnvelope(inputs[2].graph, application.composition, 1));
}
const reordered = await traceInquiry(
  { ...input, sources: [...input.sources].reverse() },
  { clients },
);
assert.deepEqual(
  reordered.candidates.map((candidate) => candidate.text),
  result.candidates.map((candidate) => candidate.text),
);
assert.deepEqual(
  reordered.openings.map((opening) => opening.label).sort(),
  result.openings.map((opening) => opening.label).sort(),
);
const disabled = await traceInquiry(input, {
  clients: {
    prepare: prepareGraphs,
    compare: async (pairs) => ({
      results: pairs.map(() => ({ complete: true, score: 1, local: { correspondence: [] } })),
    }),
  },
});
assert.equal(disabled.candidates.length, 0);
assert.equal(disabled.applications.length, 0);
assert.equal(disabled.chains.length, 0);
const recipient = await traceInquiry(
  { sources: [inputs[4]], cases: [], question: inputs[5], openings: [] },
  { clients },
);
assert.equal(recipient.candidates[0].text, 'Rafi');
assert.equal(recipient.candidates[0].role, ':ARG2');
const changedRole = structuredClone(inputs[5]);
changedRole.graph.edges.find((edge) => edge.to === 'u').role = ':ARG1';
delete changedRole.penman;
const changed = await traceInquiry(
  { sources: [inputs[4]], cases: [], question: changedRole, openings: [] },
  { clients },
);
assert.equal(changed.candidates[0].text, 'parcel', 'A changed role changes the requested binding');
const quantity = await traceInquiry(
  { sources: [inputs[6]], cases: [], question: inputs[7], openings: [] },
  { clients },
);
assert.equal(
  quantity.candidates[0].text,
  '3',
  'Literal values bind through their actual incoming AMR role',
);
const ambiguous = await traceInquiry(
  { ...input, sources: [inputs[0], { ...inputs[0], id: 'another-source' }] },
  { clients },
);
assert.equal(ambiguous.candidates.length, 2, 'Independent support occurrences remain inspectable');
const absent = await traceInquiry({ ...input, sources: [] }, { clients });
assert.equal(absent.candidates.length, 0);
assert(absent.openings.some((opening) => opening.kind === 'support'));
await assert.rejects(traceInquiry(input, { clients, bounds: { maximumPairs: 1 } }), /pair bound/);
const abort = new AbortController();
abort.abort(new Error('Cancelled'));
await assert.rejects(traceInquiry(input, { clients, signal: abort.signal }), /Cancelled/);
const limited = await traceInquiry(input, {
  clients: {
    prepare: prepareGraphs,
    compare: async (pairs) => ({
      results: pairs.map(() => ({ complete: false, reason: 'Bound reached' })),
    }),
  },
});
assert.equal(limited.status, 'limited');
assert.equal(limited.candidates.length, 0);
console.log(
  'ok real SEMCAT in a second domain, ARG0/ARG2 bindings, order, expansion/envelopes, ablation, ambiguity and limits',
);
