/** Account for supplied counterfactual observations and external check evidence.
 * Importance, repetition, source grounding and graph degree are deliberately
 * not inputs to candidacy. They belong, if anywhere, to traceability evidence.
 */
import assert from 'node:assert/strict';

export const loadBearingProfile = 'situated-load-bearing-v2';
export const loadBearingComparison = 'canonical-json-equality-v1';
export const loadBearingExclusions = [
  'importance',
  'repetition',
  'source-grounding',
  'graph-degree',
];
const requiredChecks = [
  'direction',
  'presentationInvariance',
  'noHiddenFallback',
  'traceability',
  'materialization',
];

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function stable(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') {
    assert(Number.isFinite(value), 'Observations must contain finite JSON numbers');
    return value;
  }
  assert(
    Array.isArray(value) ||
      (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))),
    'Observations must contain only JSON values',
  );
  assert(!ancestors.has(value), 'Observations must be acyclic JSON values');
  ancestors.add(value);
  const keys = Object.keys(value);
  assert(!Object.getOwnPropertySymbols(value).length, 'Observations must use JSON keys');
  let result;
  if (Array.isArray(value)) {
    assert(
      keys.length === value.length && keys.every((key, i) => key === String(i)),
      'Observations must use dense JSON arrays',
    );
    result = value.map((item) => stable(item, ancestors));
  } else {
    result = Object.fromEntries(keys.sort().map((key) => [key, stable(value[key], ancestors)]));
  }
  ancestors.delete(value);
  return result;
}
export const observationSignature = (value) => JSON.stringify(stable(value));

function requireText(value, name) {
  assert.equal(typeof value, 'string', `${name} must be a string`);
  assert(value.trim(), `${name} must be nonempty`);
}
function check(value, name) {
  if (value === undefined) value = { status: 'blocked' };
  assert(object(value), `${name} must be an object`);
  const evidence =
    Array.isArray(value.evidence) &&
    value.evidence.length > 0 &&
    value.evidence.every((ref) => typeof ref === 'string' && ref.trim())
      ? [...value.evidence]
      : [];
  const reportedStatus = ['pass', 'fail', 'blocked'].includes(value.status)
    ? value.status
    : 'blocked';
  return {
    status: reportedStatus === 'pass' && !evidence.length ? 'blocked' : reportedStatus,
    interventionId: value.interventionId ?? null,
    detail: value.detail ?? '',
    evidence,
  };
}

export function measureLoadBearingCase(input) {
  assert(object(input), 'A load-bearing case must be an object');
  requireText(input.id, 'case id');
  requireText(input.purpose, 'purpose');
  requireText(input.crossing, 'semantic-to-operative crossing');
  assert(object(input.relation), 'relation must be declared');
  requireText(input.relation.id, 'relation id');
  requireText(input.relation.description, 'relation description');
  requireText(input.relation.role, 'relation role');
  requireText(input.relation.locus, 'relation locus');
  requireText(input.relation.grain, 'relation grain');
  assert(object(input.domain), 'test domain must be declared');
  assert(
    Array.isArray(input.domain.encounters) && input.domain.encounters.length,
    'test domain must contain an encounter',
  );
  assert(object(input.promise), 'receiving promise must be declared');
  for (const key of ['id', 'owner', 'statement', 'observable', 'comparison', 'direction'])
    requireText(input.promise[key], `promise.${key}`);
  assert.equal(
    input.promise.comparison,
    loadBearingComparison,
    'Unsupported observation comparison',
  );
  assert(object(input.baseline), 'baseline observation must be declared');
  requireText(input.baseline.encounter, 'baseline encounter');
  assert(
    input.domain.encounters.includes(input.baseline.encounter),
    'baseline encounter must belong to the declared test domain',
  );
  assert(
    Array.isArray(input.interventions) && input.interventions.length,
    'at least one controlled intervention is required',
  );
  assert(Array.isArray(input.trajectory) && input.trajectory.length, 'trajectory must be declared');

  const baselineObserved = input.baseline.observation !== undefined;
  const baselineAvailable = input.baseline.available !== false && baselineObserved;
  const baselineCurrent =
    input.baseline.current !== false &&
    input.baseline.stale !== true &&
    input.baseline.compatible !== false;
  const baselineSignature = baselineObserved
    ? observationSignature(input.baseline.observation)
    : null;
  const interventionIds = new Set();
  const interventions = input.interventions.map((trial, index) => {
    assert(object(trial), `intervention ${index} must be an object`);
    requireText(trial.id, `intervention ${index} id`);
    assert(!interventionIds.has(trial.id), `Duplicate intervention id: ${trial.id}`);
    interventionIds.add(trial.id);
    requireText(trial.relationId, `intervention ${index} relation id`);
    requireText(trial.encounter, `intervention ${index} encounter`);
    const observed = trial.observation !== undefined;
    const sameEncounter = trial.encounter === input.baseline.encounter;
    const relationMatches = trial.relationId === input.relation.id;
    const available = trial.available !== false;
    const current = trial.current !== false && trial.stale !== true && trial.compatible !== false;
    const valid =
      sameEncounter &&
      relationMatches &&
      observed &&
      available &&
      current &&
      baselineAvailable &&
      baselineCurrent;
    const signature = observed ? observationSignature(trial.observation) : null;
    return {
      id: trial.id,
      kind: trial.kind ?? 'change',
      relationId: trial.relationId,
      description: trial.description ?? '',
      encounter: trial.encounter,
      available,
      observed,
      current,
      sameEncounter,
      relationMatches,
      valid,
      signature,
      differsFromBaseline: signature !== baselineSignature,
      observation: trial.observation,
    };
  });
  const validInterventions = interventions.filter((trial) => trial.valid);
  const candidateInterventions = validInterventions.filter((trial) => trial.differsFromBaseline);
  const invalid = !baselineAvailable || !baselineCurrent || !validInterventions.length;
  const candidate = !invalid && candidateInterventions.length > 0;
  const checks = Object.fromEntries(
    requiredChecks.map((name) => [name, check(input.checks?.[name], `check.${name}`)]),
  );
  const earnedInterventions = candidateInterventions.filter((trial) =>
    requiredChecks.every(
      (name) => checks[name].status === 'pass' && checks[name].interventionId === trial.id,
    ),
  );
  const outcome = invalid
    ? 'invalid'
    : !candidate
      ? 'not-load-bearing'
      : earnedInterventions.length
        ? 'earned'
        : 'candidate-only';

  return {
    id: input.id,
    relation: input.relation,
    purpose: input.purpose,
    crossing: input.crossing,
    trajectory: input.trajectory,
    domain: input.domain,
    promise: input.promise,
    baseline: {
      encounter: input.baseline.encounter,
      available: baselineAvailable,
      observed: baselineObserved,
      current: baselineCurrent,
      signature: baselineSignature,
      observation: input.baseline.observation,
    },
    interventions,
    candidate: {
      status: invalid ? 'invalid' : candidate ? 'candidate' : 'not-candidate',
      evidence: candidateInterventions.map((trial) => trial.id),
      validInterventions: validInterventions.map((trial) => trial.id),
    },
    checks,
    earnedInterventions: earnedInterventions.map((trial) => trial.id),
    earned: outcome === 'earned',
    outcome,
    excludedEvidence: loadBearingExclusions,
  };
}

export function measureLoadBearing({ cases, generatedAt = new Date().toISOString() } = {}) {
  assert(Array.isArray(cases) && cases.length, 'At least one load-bearing case is required');
  const measured = cases.map(measureLoadBearingCase);
  const ids = new Set();
  for (const item of measured) {
    assert(!ids.has(item.id), `Duplicate load-bearing case id: ${item.id}`);
    ids.add(item.id);
  }
  const counts = Object.fromEntries(
    ['earned', 'candidate-only', 'not-load-bearing', 'invalid'].map((outcome) => [
      outcome,
      measured.filter((item) => item.outcome === outcome).length,
    ]),
  );
  return {
    version: 2,
    profile: loadBearingProfile,
    generatedAt,
    excludedEvidence: loadBearingExclusions,
    counts,
    cases: measured,
  };
}
