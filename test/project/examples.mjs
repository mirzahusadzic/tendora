/** Tracked examples stay loadable and retain their demonstrated question states. */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProject } from '../../src/project/authoring/project.mjs';
import { sourceCatalog } from '../../src/project/authoring/sources.mjs';
import { listInvestigations } from '../../src/project/inquiries/investigation.mjs';
import { captureProjectInquiry } from '../../src/project/inquiries/inquiry.mjs';
import { listEngineRuns, readEngineArtifact } from '../../src/project/storage/engine-runs.mjs';

const questions = async (project) =>
  (await listInvestigations(project)).flatMap((entry) =>
    entry.data.asks.map((ask) => ask.question),
  );

const scratch = await mkdtemp(join(tmpdir(), 'tracked-examples-'));
assert.deepEqual(
  (await readdir('.proj/payments-on-call')).sort(),
  ['engine', 'material.sqlite', 'project.json'],
  'The bundled demo contains its manifest, packed material and computed results',
);
assert.deepEqual(await readdir('.proj/payments-on-call/engine'), ['artifacts.sqlite']);
const copySource = async (name) => {
  const target = join(scratch, name);
  await cp(join('.proj', name), target, {
    recursive: true,
    filter: (path) => !path.includes('/recordings'),
  });
  return openProject(target);
};

const payments = await copySource('payments-on-call');
assert.equal(payments.data.name, 'Payments On-Call');
assert.equal(payments.data.placements.length, 6);
assert.equal(sourceCatalog(payments.data).length, 19);
assert.deepEqual(
  (await questions(payments)).sort(),
  [
    'Who approves the database vendor invoice?',
    'What does the on-call engineer check after acknowledging a page?',
    'What does the security engineer report?',
    'What does the database administrator keep in the password vault?',
    'Which key must the security engineer rotate?',
    'What does the release manager freeze during a major incident?',
    'What does the support lead post after the incident commander declares a major incident?',
    'When does the release manager freeze deployments?',
    'Where does the database administrator keep break-glass credentials?',
    'Where does the support lead collect affected customer reports?',
    'Which engineer acknowledges every page within five minutes?',
    'Which engineer must rotate a leaked payment key?',
    'Which manager freezes deployments during a major incident?',
    'Who confirms that payments are healthy?',
    'Who freezes deployments during a major incident?',
    'Who freezes deployments during a major incident, and who approves the database vendor invoice?',
    'Who reports a leaked payment key to the incident commander?',
    // Asked later in the workbench, worded independently of the statements.
    'What does Sam collects?',
    'What Sam collects?',
    'Why does Sam collects customer reports?',
    'Why Sam collects customer reports?',
  ].sort(),
);
// No statement gives a reason, so these stay open.
const unanswered = new Set([
  'Why does Sam collects customer reports?',
  'Why Sam collects customer reports?',
]);
const runs = await listEngineRuns(payments);
assert.equal(runs.length, 21, 'Every demo question has a computed result');
const savedResults = new Map(runs.map((run) => [run.questions[0].text, run]));
assert.equal(savedResults.size, 21);
for (const run of runs) {
  assert.equal(run.projectDigest, payments.digest);
  assert.equal(run.cache, 'retained');
  assert.equal(run.recording, undefined, 'Bundled results have no machine-specific recording path');
  assert(run.answer, run.questions[0].text);
  assert.equal(
    run.answer.answers.length > 0,
    !unanswered.has(run.questions[0].text),
    run.questions[0].text,
  );
  const input = await readEngineArtifact(payments, run.inputRef);
  const result = await readEngineArtifact(payments, run.resultRef);
  assert.equal(input.question.text, run.questions[0].text);
  assert(result.inputs.length, 'Computed evidence remains loadable after copying the project');
}
for (const { data } of await listInvestigations(payments)) {
  for (const saved of data.asks) {
    assert(savedResults.has(saved.question));
    assert.deepEqual(
      saved.runs,
      [],
      'Question identities contain no machine-specific recording paths',
    );
  }
}
const ask = async (question) => {
  const { recording } = await captureProjectInquiry(
    payments,
    payments.data.placements[0].id,
    question,
    () => {},
    undefined,
    { acquireMissing: false, engineTrace: false },
  );
  const result = recording.reasoning;
  const saved = savedResults.get(question);
  assert.equal(result.status, saved.status, question);
  assert.deepEqual(
    result.answer.answers.map((answer) => answer.text).sort(),
    saved.answer.answers.map((answer) => answer.text).sort(),
    'Bundled answers agree with a fresh offline check: ' + question,
  );
  return result;
};
const status = async (question) => (await ask(question)).status;
// A participant's name in the source qualifies nothing: the question need not repeat it.
assert.equal(
  await status('What does the database administrator keep in the password vault?'),
  'supported',
);
const run = await ask('What does the database administrator keep in the password vault?');
assert.equal(run.answer.answers[0].text, 'break-glass credentials');
assert.equal(
  (await ask('Where does the database administrator keep break-glass credentials?')).answer
    .answers[0].text,
  'password vault',
);
assert.equal(
  (await ask('What does the on-call engineer check after acknowledging a page?')).answer.answers[0]
    .text,
  'payment error rate',
);
assert.equal(await status('Who freezes deployments during a major incident?'), 'supported');
assert.equal(
  await status('Which engineer acknowledges every page within five minutes?'),
  'supported',
);
assert.equal(await status('Who approves the database vendor invoice?'), 'supported');
assert.equal(
  await status(
    'Who freezes deployments during a major incident, and who approves the database vendor invoice?',
  ),
  'supported',
);
assert.equal(await status('What does the security engineer report?'), 'conditional');
assert.equal(await status('Which key must the security engineer rotate?'), 'conditional');
// A conditional answer names the clause it depends on, in its source's words;
// without such a clause it keeps the whole sentence.
for (const [question, dependsOn] of [
  ['What does the security engineer report?', ['to the incident commander']],
  [
    'Which key must the security engineer rotate?',
    ['before the incident commander closes the incident'],
  ],
  [
    'Who confirms that payments are healthy?',
    ['before the incident commander closes a major incident'],
  ],
]) {
  const [answer] = (await ask(question)).answer.answers;
  assert.deepEqual(answer.dependsOn, dependsOn, question);
  assert.equal(answer.qualifications.length, 1, 'The source sentence stays its qualification');
}
assert.equal(
  (await ask('Which manager freezes deployments during a major incident?')).answer.answers[0]
    .dependsOn,
  undefined,
  'A participant description is not a clause the answer depends on',
);

for (const [question, expectedStatus, answer] of [
  ['What does the release manager freeze during a major incident?', 'supported', 'deployments'],
  [
    'Where does the support lead collect affected customer reports?',
    'supported',
    'incident channel',
  ],
  [
    'What does the support lead post after the incident commander declares a major incident?',
    'supported',
    'customer updates',
  ],
  ['Who confirms that payments are healthy?', 'conditional', 'Morgan'],
  ['Who reports a leaked payment key to the incident commander?', 'supported', 'Priya'],
  ['Which engineer must rotate a leaked payment key?', 'conditional', 'Priya'],
  ['When does the release manager freeze deployments?', 'supported', 'major incident'],
  ['Which manager freezes deployments during a major incident?', 'conditional', 'Morgan'],
  ['What does Sam collects?', 'conditional', 'affected customer reports'],
  ['What Sam collects?', 'conditional', 'affected customer reports'],
]) {
  const result = await ask(question);
  assert.equal(result.status, expectedStatus, question);
  assert.equal(result.answer.answers[0].text, answer, question);
}

for (const question of unanswered) assert.equal(await status(question), 'open', question);

await rm(scratch, { recursive: true, force: true });

console.log(
  'ok all 21 bundled answers and evidence survive relocation and agree with fresh offline checks',
);
