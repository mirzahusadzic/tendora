/** Offline contract for local counterfactual load-bearing measurement. */
import assert from 'node:assert/strict';
import {
  loadBearingExclusions,
  measureLoadBearing,
  measureLoadBearingCase,
  observationSignature,
} from '../../tools/support/load-bearing.mjs';

const checks = (status = 'pass') =>
  Object.fromEntries(
    [
      'direction',
      'presentationInvariance',
      'noHiddenFallback',
      'traceability',
      'materialization',
    ].map((name) => [
      name,
      {
        status,
        interventionId: 'change-r1',
        detail: `${name} fixture`,
        evidence: [`fixture:${name}`],
      },
    ]),
  );
const base = () => ({
  id: 'synthetic-relation',
  relation: {
    id: 'r1',
    description: 'synthetic relation',
    role: 'fixture role',
    locus: 'declared test locus',
    grain: 'one relation occurrence',
  },
  purpose: 'preserve the declared observable',
  crossing: 'source relation -> attributed answer',
  trajectory: ['question', 'source', 'attributed answer'],
  domain: { id: 'fixture-domain', encounters: ['encounter-1'] },
  promise: {
    id: 'p1',
    owner: 'fixture owner',
    statement: 'the observable changes only when the relation changes',
    observable: 'status and relation presence',
    comparison: 'canonical-json-equality-v1',
    direction: 'removal removes the relation',
  },
  baseline: {
    encounter: 'encounter-1',
    available: true,
    observation: { status: 'open', relation: 'present' },
  },
  interventions: [
    {
      id: 'change-r1',
      relationId: 'r1',
      kind: 'change',
      encounter: 'encounter-1',
      available: true,
      observation: { status: 'open', relation: 'absent' },
    },
  ],
  checks: checks(),
});

const earned = measureLoadBearingCase(base());
assert.equal(earned.outcome, 'earned');
assert.equal(earned.earned, true);
assert.equal(earned.candidate.status, 'candidate');
assert.deepEqual(earned.excludedEvidence, loadBearingExclusions);

const unchanged = base();
unchanged.id = 'synthetic-no-difference';
unchanged.interventions[0].observation = { status: 'open', relation: 'present' };
const noDifference = measureLoadBearingCase({
  ...unchanged,
  important: true,
  repeated: 99,
  sourceGrounding: 'strong',
  graphDegree: 42,
});
assert.equal(noDifference.outcome, 'not-load-bearing');
assert.equal(noDifference.candidate.status, 'not-candidate');

const candidateOnly = measureLoadBearingCase({
  ...base(),
  checks: { ...checks(), materialization: { status: 'fail', detail: 'not visible' } },
});
assert.equal(candidateOnly.outcome, 'candidate-only');
assert.equal(candidateOnly.earned, false);

const noEvidence = base();
for (const check of Object.values(noEvidence.checks)) delete check.evidence;
assert.equal(
  measureLoadBearingCase(noEvidence).outcome,
  'candidate-only',
  'Pass flags without recorded evidence cannot earn the designation',
);

const otherTrial = base();
otherTrial.interventions.push({
  ...otherTrial.interventions[0],
  id: 'unchanged',
  observation: otherTrial.baseline.observation,
});
for (const check of Object.values(otherTrial.checks)) check.interventionId = 'unchanged';
assert.equal(
  measureLoadBearingCase(otherTrial).outcome,
  'candidate-only',
  'External checks must belong to the intervention that made the difference',
);
const mixedTrials = base();
mixedTrials.interventions.push({ ...mixedTrials.interventions[0], id: 'other-change' });
mixedTrials.checks.direction.interventionId = 'other-change';
assert.equal(measureLoadBearingCase(mixedTrials).outcome, 'candidate-only');

const unchecked = base();
delete unchecked.checks;
assert.equal(measureLoadBearingCase(unchecked).outcome, 'candidate-only');

const customComparison = base();
customComparison.promise.comparison = 'numeric tolerance';
assert.throws(() => measureLoadBearingCase(customComparison), /comparison/u);
const duplicateTrial = base();
duplicateTrial.interventions.push({ ...duplicateTrial.interventions[0] });
assert.throws(() => measureLoadBearingCase(duplicateTrial), /Duplicate intervention/u);
for (const value of [NaN, Infinity, { field: undefined }, new Date(), new Map(), [1, , 3]])
  assert.throws(() => observationSignature(value), /JSON/u);
assert.notEqual(observationSignature(null), observationSignature({}));

const stale = base();
stale.interventions[0].stale = true;
assert.equal(measureLoadBearingCase(stale).outcome, 'invalid');
assert.equal(
  measureLoadBearing({ cases: [measureLoadBearingCase(stale)] }).counts.invalid,
  1,
  'Aggregating a report cannot make stale observations current again',
);
const staleBaseline = base();
staleBaseline.baseline.stale = true;
assert.equal(
  measureLoadBearing({ cases: [measureLoadBearingCase(staleBaseline)] }).counts.invalid,
  1,
);

const wrongEncounter = base();
wrongEncounter.interventions[0].encounter = 'other-encounter';
assert.equal(measureLoadBearingCase(wrongEncounter).outcome, 'invalid');

const wrongRelation = base();
wrongRelation.interventions[0].relationId = 'different-relation';
assert.equal(measureLoadBearingCase(wrongRelation).outcome, 'invalid');

const missingBaseline = base();
missingBaseline.baseline.available = false;
assert.equal(measureLoadBearingCase(missingBaseline).outcome, 'invalid');

const missingObservation = base();
delete missingObservation.interventions[0].observation;
assert.equal(measureLoadBearingCase(missingObservation).outcome, 'invalid');

const suite = measureLoadBearing({ cases: [base(), noDifference] });
assert.equal(suite.profile, 'situated-load-bearing-v2');
assert.equal(suite.counts.earned, 1);
assert.equal(suite.counts['not-load-bearing'], 1);
assert.equal(
  observationSignature({ b: 1, a: { d: 2, c: 3 } }),
  observationSignature({ a: { c: 3, d: 2 }, b: 1 }),
);
assert.throws(() => measureLoadBearing({ cases: [] }), /At least one/u);
assert.throws(
  () => measureLoadBearing({ cases: [base(), base()] }),
  /Duplicate load-bearing case/u,
);
console.log(
  'ok load-bearing report accounting: observation validity, intervention-bound evidence and earned/candidate separation (offline)',
);
