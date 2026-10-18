/** Offline harness contracts: structural placeholders only, no acquisition or editor process. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBlindHoldout } from '../../tools/capture-blind-holdout.mjs';
import { evaluateBlindHoldout } from '../../tools/evaluate-blind-holdout.mjs';
import {
  artifactHash,
  displayedAnswers,
  displayedValues,
  evaluateAccounting,
  freezeRun,
  json,
  parseOptions,
  selectedSidebarRow,
  validatePacket,
  verifyFrozenRun,
} from '../../tools/support/blind-holdout.mjs';

const packet = () => ({
  title: 'Harness fixture',
  roles: [
    { id: 'r0', name: 'Role', parent: null, statements: [{ id: 's0', text: 'Text.' }] },
    { id: 'r1', name: 'Child Role', parent: 'r0', statements: [] },
  ],
  cases: [{ id: 'c0', text: 'Case text.' }],
  questions: [{ id: 'q0', text: 'Question?', caseId: 'c0' }],
});
assert.deepEqual(validatePacket(packet()), packet());
const exact = packet();
exact.roles[0].statements[0].text = '  Exact punctuation—kept.\nSecond line.  ';
assert.equal(validatePacket(exact).roles[0].statements[0].text, exact.roles[0].statements[0].text);
for (const mutate of [
  (p) => {
    p.answer = null;
  },
  (p) => {
    p.oracle = {};
  },
  (p) => {
    p.notes = '';
  },
  (p) => {
    p.roles[0].expected = true;
  },
  (p) => {
    p.roles[0].statements[0].answer = '';
  },
  (p) => {
    p.roles[0].statements[0].text = '  ';
  },
  (p) => {
    p.roles[1].name = '';
  },
  (p) => {
    p.roles[1].name = 'Two\nlines';
  },
  (p) => {
    p.roles[1].name = p.roles[0].name;
  },
  (p) => {
    p.roles[1].parent = null;
  },
  (p) => {
    p.roles[0].parent = 'r1';
  },
  (p) => {
    p.roles[1].parent = 'missing';
  },
  (p) => {
    p.roles[1].parent = 'r1';
  },
  (p) => {
    p.roles.push({ id: 'r2', name: 'Role', parent: 'r1', statements: [] });
    p.roles[1].parent = 'r2';
  },
  (p) => {
    p.questions[0].id = 's0';
  },
  (p) => {
    p.questions[0].caseId = 'missing';
  },
  (p) => {
    p.questions[0].text = '\u001b[31m';
  },
  (p) => {
    p.cases = {};
  },
  (p) => {
    delete p.title;
  },
]) {
  const value = packet();
  mutate(value);
  assert.throws(() => validatePacket(value));
}
const optional = packet();
delete optional.questions[0].caseId;
validatePacket(optional);
assert.deepEqual(
  parseOptions(
    ['--packet', 'p', '--output', 'o', '--author-only'],
    ['--packet', '--output'],
    ['--author-only'],
  ),
  { '--packet': 'p', '--output': 'o', '--author-only': true },
);
for (const args of [[], ['--packet'], ['--oracle', 'x'], ['--packet', 'p', '--packet', 'p']])
  assert.throws(() => parseOptions(args, ['--packet']));

const screen = [
  'Header',
  '╭────────────╮ ╭────────────────────────────────────╮',
  '│ Roles      │ │ Role heading                       │',
  '│            │ │                                    │',
  '│   Role     │ │ Question: Question?                │',
  '│   ● Role   │ │ Answer: Rendered                   │',
  '│            │ │ continuation                       │',
  '│            │ │                                    │',
  '╰────────────╯ ╰────────────────────────────────────╯',
  '│ Development│ │                                    │',
  '│ ● Question │ │                                    │',
].join('\n');
assert.deepEqual(selectedSidebarRow(screen), { x: 3, y: 6 });
assert.deepEqual(selectedSidebarRow('\n\n' + screen), { x: 3, y: 8 });
assert.throws(() => selectedSidebarRow(screen.replace('● Role', '  Role')), /sidebar role/u);
assert.deepEqual(displayedAnswers(screen), ['Rendered continuation']);
assert.deepEqual(
  displayedValues(screen.replace('│ Question: Question?', '│ › Question: Question?'), 'Question'),
  ['Question?'],
);
assert.deepEqual(displayedAnswers(screen.replace('Answer:', 'Problem:')), []);

const directory = await mkdtemp(join(tmpdir(), 'blind-holdout-test-'));
try {
  const invalid = join(directory, 'invalid-public.json');
  await writeFile(invalid, json({ ...packet(), oracle: {} }));
  const absentOutput = join(directory, 'must-not-exist');
  await assert.rejects(
    captureBlindHoldout({ packet: invalid, output: absentOutput }),
    /Unknown fields/u,
  );
  await assert.rejects(readFile(join(absentOutput, 'public.json')), { code: 'ENOENT' });

  const run = join(directory, 'run');
  await mkdir(run);
  await assert.rejects(
    evaluateBlindHoldout({ run, oracle: join(directory, 'never-read') }),
    /freeze.json/u,
  );
  await writeFile(join(run, 'public.json'), json(packet()));
  // JSONL frames are single lines, as in the real PTY trace.
  await writeFile(
    join(run, 'editor.capture.jsonl'),
    JSON.stringify({ screen }) + '\n' + JSON.stringify({ exitCode: 0 }) + '\n',
  );
  await writeFile(join(run, 'captures.html'), '<pre>structural test fixture</pre>');
  const integration = {
    version: 1,
    status: 'complete',
    mode: 'questions',
    packet: await artifactHash(run, 'public.json'),
    captures: await Promise.all(
      ['editor.capture.jsonl', 'captures.html'].map((path) => artifactHash(run, path)),
    ),
    questions: [
      {
        ...packet().questions[0],
        state: 'captured',
        display: {
          capture: 'editor.capture.jsonl',
          frame: 0,
          screen,
          answers: displayedAnswers(screen),
        },
        run: {
          id: 'run0',
          status: 'supported',
          questions: [{ text: 'Question?' }],
          answer: {
            answers: [{ text: 'Rendered continuation', sourceIds: ['s0'] }],
            partial: {
              parts: [{ sourceIds: ['s0'] }],
              openings: [{ id: 'o0', anchor: { kind: 'edge' }, state: 'open' }],
            },
          },
        },
        input: { question: { text: 'Question?' } },
        result: { inputs: [{ id: 'i0', kind: 'question', acquisition: { status: 'retained' } }] },
      },
    ],
  };
  await freezeRun(run, integration);
  assert.deepEqual((await verifyFrozenRun(run)).integration, integration);
  const malformed = async (mutate, pattern) => {
    const original = await readFile(join(run, 'integration.json'));
    const frozen = await readFile(join(run, 'freeze.json'));
    const value = structuredClone(integration);
    mutate(value);
    await writeFile(join(run, 'integration.json'), json(value));
    const manifest = JSON.parse(frozen);
    manifest.integration = await artifactHash(run, 'integration.json');
    await writeFile(join(run, 'freeze.json'), json(manifest));
    await assert.rejects(verifyFrozenRun(run), pattern);
    await writeFile(join(run, 'integration.json'), original);
    await writeFile(join(run, 'freeze.json'), frozen);
  };
  await malformed((value) => {
    value.status = 'failed';
  }, /Incomplete/u);
  await malformed((value) => {
    value.questions = [];
  }, /inventory/u);
  await malformed((value) => {
    value.captures = [];
  }, /inventory/u);
  await malformed((value) => {
    value.questions[0].display.frame = 99;
  }, /frame mismatch/u);
  await malformed((value) => {
    value.questions[0].display.answers = [];
  }, /answers mismatch/u);
  await malformed((value) => {
    value.questions[0].run.questions[0].text = 'Different?';
  }, /question mismatch/u);
  await malformed((value) => {
    value.questions[0].result = null;
  }, /artifacts missing/u);
  const authorOnly = join(directory, 'author-only');
  await mkdir(authorOnly);
  for (const path of ['public.json', 'editor.capture.jsonl', 'captures.html'])
    await writeFile(join(authorOnly, path), await readFile(join(run, path)));
  const authored = {
    ...integration,
    mode: 'author-only',
    questions: packet().questions.map((q) => ({ ...q, state: 'not-asked' })),
  };
  await freezeRun(authorOnly, authored);
  assert.equal((await verifyFrozenRun(authorOnly)).integration.questions[0].state, 'not-asked');
  assert.equal(evaluateAccounting(authored, { questions: [{ id: 'q0' }] }).counts.notAsked, 1);
  for (const path of ['public.json', 'editor.capture.jsonl', 'captures.html', 'integration.json']) {
    const original = await readFile(join(run, path));
    await writeFile(join(run, path), Buffer.concat([original, Buffer.from(' ')]));
    await assert.rejects(
      evaluateBlindHoldout({ run, oracle: join(directory, 'never-read') }),
      /Frozen hash mismatch/u,
    );
    await writeFile(join(run, path), original);
  }
  const originalFreeze = await readFile(join(run, 'freeze.json'));
  const changedFreeze = JSON.parse(originalFreeze);
  changedFreeze.captures[0].path = '../outside';
  await writeFile(join(run, 'freeze.json'), json(changedFreeze));
  await assert.rejects(verifyFrozenRun(run), /Invalid artifact path/u);
  await writeFile(join(run, 'freeze.json'), originalFreeze);
  const originalCapture = await readFile(join(run, 'editor.capture.jsonl'));
  await writeFile(join(directory, 'outside.capture.jsonl'), originalCapture);
  await rm(join(run, 'editor.capture.jsonl'));
  await symlink(join(directory, 'outside.capture.jsonl'), join(run, 'editor.capture.jsonl'));
  await assert.rejects(verifyFrozenRun(run), /regular file/u);
  await rm(join(run, 'editor.capture.jsonl'));
  await writeFile(join(run, 'editor.capture.jsonl'), originalCapture);
  await writeFile(join(directory, 'malformed-oracle.json'), '{');
  await assert.rejects(
    evaluateBlindHoldout({ run, oracle: join(directory, 'malformed-oracle.json') }),
    /^Error: Oracle must be valid JSON$/u,
  );

  // No oracle answers are authored, loaded, or reproduced: fixtures contain IDs and labels only.
  const oracle = {
    questions: [
      { id: 'q0', resolution: 'supported' },
      { id: 'absent', resolution: 'open' },
    ],
  };
  const labels = join(directory, 'oracle-labels.json');
  await writeFile(labels, json(oracle));
  const frozenBefore = await Promise.all(
    ['public.json', 'integration.json', 'editor.capture.jsonl', 'captures.html', 'freeze.json'].map(
      (path) => artifactHash(run, path),
    ),
  );
  const { counts } = await evaluateBlindHoldout({ run, oracle: labels });
  assert.equal(counts.oracle, 2);
  assert.equal(counts.captured, 1);
  assert.equal(counts.missing, 1);
  assert.equal(counts.supported, 1);
  assert.equal(counts.partial, 1);
  const evaluation = JSON.parse(await readFile(join(run, 'evaluation.json')));
  assert.equal(evaluation.questions[0].retainedAnswersVisible[0].visible, true);
  assert.equal(evaluation.questions[0].acquisition.inputs[0].acquisition.status, 'retained');
  assert.equal(evaluation.questions[0].semanticJudgment, 'requires-human-review');
  assert.deepEqual(
    await Promise.all(frozenBefore.map(({ path }) => artifactHash(run, path))),
    frozenBefore,
  );
  await assert.rejects(evaluateBlindHoldout({ run, oracle: labels }), { code: 'EEXIST' });

  const mixed = structuredClone(integration);
  mixed.questions.push(
    { id: 'ambiguous', state: 'captured', run: { status: 'ambiguous' } },
    { id: 'open', state: 'captured', run: { status: 'open' } },
    { id: 'limited', state: 'captured', run: { status: 'limited' } },
    {
      id: 'partial',
      state: 'captured',
      run: { status: 'open', answer: { partial: { parts: [{}], openings: [] } } },
    },
    { id: 'skipped', state: 'not-asked' },
    { id: 'unscored', state: 'not-asked' },
  );
  const accounting = evaluateAccounting(mixed, {
    questions: [
      { id: 'ambiguous', resolution: 'ambiguous' },
      { id: 'open', label: 'open' },
      { id: 'limited', expectedStatus: 'open' },
      { id: 'partial', label: 'partial' },
      { id: 'skipped' },
      { id: 'absent' },
    ],
  });
  assert.equal(accounting.counts.ambiguous, 1);
  assert.equal(accounting.counts.openPreserved, 1);
  assert.equal(accounting.counts.partial, 1);
  assert.equal(accounting.counts.resolutionLabelMismatches, 1);
  assert.equal(
    accounting.questions.find((question) => question.id === 'partial').resolutionLabelMatches,
    true,
  );
  assert.equal(accounting.counts.notAsked, 1);
  assert.equal(accounting.counts.missing, 1);
  assert.deepEqual(accounting.unscoredQuestionIds, ['q0', 'unscored']);
  assert.throws(
    () => evaluateAccounting(mixed, { questions: [{ id: 'x' }, { id: 'x' }] }),
    /Duplicate oracle/u,
  );
  assert.throws(
    () => evaluateAccounting(mixed, { questions: [{ id: 'x', resolution: 'unknown-label' }] }),
    /resolution/u,
  );
  assert.throws(() => evaluateAccounting(mixed, {}), /questions array/u);
  console.log(
    'ok blind holdout packet validation, frozen artifacts, oracle ordering and evaluator accounting (offline)',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
