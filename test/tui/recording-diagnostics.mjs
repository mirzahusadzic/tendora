/** The explicitly selected legacy recording mode is diagnostic, not authoring UI.
 * Cover its read-only spine; this does not approve legacy interpretation editing.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import { questionStatusFixture } from '../support/question-status-fixtures.mjs';
import { diagnosticRecordingFixture } from '../support/diagnostic-recording-fixture.mjs';
import { authoredContinuation, evidenceOpenings } from '../../src/recording/continuation.mjs';
import { validateRecording } from '../../src/recording/format.mjs';
import { JourneyTerminal } from '../support/journey-workbench.mjs';
import { matchQuestionRoles } from '../../src/project/inquiries/role-matching.mjs';
import {
  captureProjectInquiry,
  projectInquiryAsset,
} from '../../src/project/inquiries/inquiry.mjs';
import { createWorkbench } from '../../src/tui/shell/app.mjs';
import { createState } from '../../src/tui/shell/state.mjs';
import { indexRecording, initialSelection } from '../../src/tui/recordings/view.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/recording-diagnostics-'));
const oldFetch = globalThis.fetch;
globalThis.fetch = () => assert.fail('Recording diagnostics must use retained evidence');
let app;
const frames = [],
  transitions = [];
try {
  const fixture = await questionStatusFixture(directory, 'ambiguous');
  const captured = await captureProjectInquiry(
    fixture.project,
    fixture.project.data.placements[0].id,
    fixture.question,
    () => {},
    undefined,
    { acquireMissing: false },
  );
  const config = {
    projectsHome: directory,
    preferencesPath: join(directory, '.layout'),
    noColor: false,
    preserveRecordingSelection: true,
    readOnlyRecording: true,
  };
  const ix = indexRecording(captured.recording);
  const selection = initialSelection(ix);
  const state = createState(
    { mode: 'recording', ix, selection, activeRecordingPath: captured.path },
    config,
  );
  const term = new JourneyTerminal();
  app = createWorkbench({ state, config, term, onExit: () => assert.fail('Unexpected exit') });
  app.start();
  await app.idle();
  const key = async (key) => {
    term.emit('key', key, [], {});
    await app.idle();
    assert(!state.failure, state.failure);
  };
  const frame = async (name, actions, expect) => {
    const plain = stripVTControlCharacters(term.frame);
    assert.doesNotMatch(plain, /Shift-D|Develop:|Routing model: undefined/u);
    for (const text of expect) assert(plain.includes(text), `${name}: ${text}\n${plain}`);
    const ansi = join(directory, name + '.ansi');
    await writeFile(ansi, term.frame);
    frames.push({
      name,
      ansi,
      width: term.width,
      height: term.height,
      actions,
      expect,
      test: 'test/tui/recording-diagnostics.mjs',
      limit:
        'Explicit legacy recording inspection only. No normal authoring workflow or legacy interpretation editor approval.',
    });
  };
  assert.equal(state.mode, 'recording');
  assert.equal(state.workflow.active(), false);
  await key('TAB');
  assert.equal(state.focus, 'reading');
  await frame('diagnostic-findings', ['explicit recording entry', 'Tab'], ['Findings']);
  await key('a');
  assert.equal(state.page, 'source');
  await frame('diagnostic-source', ['a'], ['AMR & source']);
  await key('v');
  assert.equal(state.page, 'provenance');
  await frame('diagnostic-provenance', ['v'], ['Provenance']);
  await key('i');
  assert.equal(state.page, 'setup');
  await frame('diagnostic-inputs', ['i'], ['Recorded inputs']);
  for (const page of ['provenance', 'source', 'overview']) {
    await key('ESCAPE');
    assert.equal(state.page, page);
  }
  transitions.push(
    'Findings -> a Source -> v Provenance -> i Recorded inputs -> Escape reverses each page',
  );
  const before = structuredClone(state.selection);
  await key('RIGHT');
  assert.notEqual(state.selection.occurrenceId, before.occurrenceId);
  await key('LEFT');
  assert.deepEqual(state.selection, before);
  transitions.push('Right/Left cycles recorded source occurrences and returns exact selection');
  await key('?');
  assert(state.help);
  await frame('diagnostic-help', ['?'], ['Shortcuts after closing help']);
  await key('ESCAPE');
  assert(!state.help);
  assert.deepEqual(state.selection, before);
  transitions.push('Help -> Escape returns exact selected occurrence');
  const routing = await matchQuestionRoles(
    fixture.project,
    projectInquiryAsset(fixture.project, fixture.project.data.placements[0].id, fixture.question),
    {
      embed: async (texts) => ({
        model: 'diagnostic-render-fixture@1',
        vectors: texts.map(() => [1, ...Array(127).fill(0)]),
      }),
    },
  );
  assert.equal(routing.status, 'matched');
  state.ix.recording.routing = routing;
  for (const keyName of ['a', 'v', 'i']) await key(keyName);
  assert.equal(state.page, 'setup');
  await frame(
    'diagnostic-matched-inputs',
    ['a', 'v', 'i'],
    ['Role matching', 'Closest text', '1.000'],
  );
  transitions.push(
    'Recorded inputs renders both unavailable role matching and current native cosine results; controlled fixture vectors do not claim retrieval quality',
  );
  const conditional = await diagnosticRecordingFixture(directory, captured.recording.project);
  const conditionalIndex = indexRecording(conditional.recording);
  const selectedVisit = conditional.recording.visits.find((visit) => visit.nodeId === 'unit');
  const conditionalSelection = {
    nodeId: 'unit',
    visitId: selectedVisit.id,
    occurrenceId: selectedVisit.occurrenceIds[0],
  };
  Object.assign(state, {
    ix: conditionalIndex,
    selection: conditionalSelection,
    page: 'overview',
    pageTrail: [],
    offset: 0,
    activeRecordingPath: conditional.path,
  });
  app.draw();
  await key('c');
  assert.equal(state.page, 'context');
  await frame('diagnostic-carried-context', ['c'], ['Carried context', 'container', 'leak']);
  await key('ESCAPE');
  assert.equal(state.page, 'overview');
  assert.deepEqual(state.selection, conditionalSelection);
  await key('p');
  assert.equal(state.page, 'proposal');
  await frame('diagnostic-proposed-reading', ['p'], ['Proposals', 'unadopted: sample → leak']);
  for (const keyName of ['ENTER', 't', 'd']) {
    await key(keyName);
    assert.equal(state.page, 'proposal');
    assert.equal(state.form, null);
  }
  await key('ESCAPE');
  assert.equal(state.page, 'overview');
  assert.deepEqual(state.selection, conditionalSelection);
  transitions.push(
    'Declared symbolic traversal: c inspects inherited context checks; p inspects the retained alternative without accepting it; Escape restores the exact occurrence and authoring keys remain inert',
  );
  const context = authoredContinuation(
    conditionalIndex,
    conditionalSelection,
    conditional.path,
    evidenceOpenings(conditionalIndex, conditionalSelection)[0],
  );
  const linked = validateRecording({
    ...structuredClone(captured.recording),
    continuation: {
      ...context,
      question: captured.recording.inquiry.text,
      scopePlacementId: captured.recording.project.placementId,
    },
  });
  const linkedPath = join(directory, 'linked-recording.json');
  await writeFile(linkedPath, JSON.stringify(linked, null, 2) + '\n');
  Object.assign(state, {
    ix: indexRecording(linked),
    selection: initialSelection(indexRecording(linked)),
    page: 'overview',
    pageTrail: [],
    offset: 0,
    activeRecordingPath: linkedPath,
  });
  const childSelection = structuredClone(state.selection);
  app.draw();
  await frame('diagnostic-linked-question', ['open declared saved link'], ['parent opening']);
  await key('B');
  assert.equal(state.activeRecordingPath, conditional.path);
  assert.equal(state.page, 'scope');
  assert.equal(state.selection.nodeId, 'unit');
  assert.equal(state.selection.occurrenceId, conditionalSelection.occurrenceId);
  assert(!state.project, 'Parent inspection never attaches an authoring project');
  await frame('diagnostic-parent-opening', ['B'], ['Source openings', 'back to linked question']);
  await key('ESCAPE');
  assert.equal(state.activeRecordingPath, linkedPath);
  assert.equal(state.page, 'overview');
  assert.deepEqual(state.selection, childSelection);
  await frame('diagnostic-linked-return', ['Escape'], [linked.inquiry.text]);
  transitions.push(
    'Saved linked question -> B exact parent opening -> Escape restores child recording, page and occurrence; neither project attachment nor authoring occurs',
  );
  app.dispose();
  app = null;

  const entry = fileURLToPath(new URL('../../src/tui/workbench.mjs', import.meta.url));
  const launch = (...args) =>
    spawnSync(process.execPath, [entry, '--recording', captured.path, ...args], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10000,
    });
  for (const args of [
    [],
    ['--detail', 'scope'],
    ['--detail', 'proposal'],
    ['--detail', 'source'],
    ['--detail', 'provenance'],
    ['--node', ix.recording.nodes[0].id],
    ['--visit', ix.recording.visits[0].id],
    ['--occurrence', before.occurrenceId],
  ]) {
    const output = launch(...args);
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stderr, '');
    assert(output.stdout.includes(fixture.question));
    assert(!output.stdout.includes('\x1b'), 'Piped diagnostic snapshots contain no escape codes');
  }
  for (const args of [
    ['--node', 'absent'],
    ['--visit', 'absent'],
    ['--occurrence', 'absent'],
  ]) {
    const output = launch(...args);
    assert.equal(output.status, 1);
    assert.equal(output.stdout, '');
    assert.match(output.stderr, /unknown|absent/u);
    assert(!output.stderr.includes('    at '));
  }
  transitions.push(
    'Explicit recording CLI selectors produce plain snapshots; absent selections fail without Node stacks',
  );
  // Exercise the PUBLIC launcher, including project-attachment initialization.
  // The source gap guarantees Enter would previously enter a continuation form.
  const openQuestion = 'Who repairs cars?';
  await retainAcquisitions(fixture.project, [
    {
      text: openQuestion,
      penman: '(r / repair-01 :ARG0 (u / amr-unknown) :ARG1 (c / car))',
      origin: { kind: 'diagnostic-open-fixture' },
    },
  ]);
  const open = await captureProjectInquiry(
    fixture.project,
    fixture.project.data.placements[0].id,
    openQuestion,
    () => {},
    undefined,
    { acquireMissing: false },
  );
  const hashes = async (directory, prefix = '') => {
    const result = {};
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name),
        key = prefix + item.name;
      if (item.isDirectory()) Object.assign(result, await hashes(path, key + '/'));
      else
        result[key] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
    }
    return result;
  };
  const projectRoot = join(directory, 'ambiguous');
  const original = await hashes(projectRoot);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const trace = join(directory, 'public-recording.capture.jsonl');
  const child = spawn(
    'python3',
    [
      join(root, 'test/support/terminal-driver.py'),
      '--check',
      '--trace',
      trace,
      '--width',
      '180',
      '--height',
      '54',
      '--',
      process.execPath,
      '--import',
      join(root, 'tools/support/offline-terminal.mjs'),
      entry,
      '--recording',
      open.path,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        NO_COLOR: '',
        TERM: 'xterm-256color',
        TENDORA_CAPTURE_NETWORK_LOG: join(directory, 'network-attempts.jsonl'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (bytes) => (stderr += bytes));
  const exit = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    assert(!line.done, stderr);
    const frame = JSON.parse(line.value);
    assert(!frame.error, JSON.stringify(frame));
    return frame;
  };
  const step = async (command) => {
    child.stdin.write(JSON.stringify({ timeout: 5, ...command }) + '\n');
    return next();
  };
  try {
    await next();
    const reject = [
      'History',
      'Material',
      'Development',
      'interpret',
      'ask from opening',
      'bind case',
      'save mapping',
      'Shift-D',
      'Develop:',
      'Routing model: undefined',
    ];
    await step({ keys: ['TAB', 'a'], expect: ['AMR & source'], reject });
    for (const key of [
      't',
      'd',
      'n',
      'e',
      'o',
      'u',
      'x',
      'b',
      'R',
      'r',
      'CTRL_Z',
      'CTRL_Y',
      'ENTER',
    ])
      await step({ keys: [key], expect: ['AMR & source'], reject: [...reject, 'Question:'] });
    await step({ keys: ['?', 'HOME'], expect: ['Recording diagnostics (read-only)'], reject });
    await step({ keys: ['ESC', 'ESC', 's'], expect: ['Source openings'], reject });
    for (const key of ['ENTER', 't', 'C', 'd'])
      await step({
        keys: [key],
        expect: ['Source openings'],
        reject: [...reject, 'Ask', 'Interpretation -'],
      });
    await step({ keys: ['ESC', 'a', 'v', 'i'], expect: ['Recorded inputs'], reject });
    await step({
      keys: ['ESC', 'ESC', 'ESC', 'TAB', 'w'],
      expect: ['New project'],
      reject: ['History', 'Material'],
    });
    await step({ keys: ['ESC'], expect: ['Findings'], reject });
    await step({ keys: ['CTRL_C'], expectExit: true, quit: true });
    child.stdin.end();
    assert.equal(await exit, 0, stderr);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  assert.deepEqual(
    await hashes(projectRoot),
    original,
    'Read-only diagnostic launch/navigation creates no evaluation, project or recording writes',
  );
  await assert.rejects(readFile(join(directory, 'network-attempts.jsonl')), { code: 'ENOENT' });
  transitions.push(
    'Public --recording launch: authoring shortcuts inactive on Source and Opening pages, no project tabs, read-only Help, Home/back preserved, and every project file hash unchanged',
  );
  const conditionalCommands = [
    { keys: ['TAB', 'B'], expect: ['Source openings', 'back to linked question'] },
    { keys: ['s', 'c'], expect: ['Carried context', 'leak', 'container'] },
    { keys: ['ESC', 'p'], expect: ['Proposals', 'unadopted: sample → leak'] },
    {
      keys: ['ENTER', 't', 'd'],
      expect: ['unadopted: sample → leak'],
      reject: ['Interpretation -'],
    },
    {
      keys: ['ESC', 'ESC'],
      expect: [linked.inquiry.text, 'Findings'],
      reject: ['Source openings'],
    },
    { keys: ['CTRL_C'], expectExit: true, quit: true },
  ];
  const immutableRecordings = await Promise.all(
    [conditional.path, linkedPath].map((path) => readFile(path, 'utf8')),
  );
  const conditionalCapture = spawnSync(
    'python3',
    [
      join(root, 'test/support/terminal-driver.py'),
      '--check',
      '--trace',
      join(directory, 'public-conditional.capture.jsonl'),
      '--width',
      '180',
      '--height',
      '54',
      '--',
      process.execPath,
      '--import',
      join(root, 'tools/support/offline-terminal.mjs'),
      entry,
      '--recording',
      linkedPath,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        NO_COLOR: '',
        TERM: 'xterm-256color',
        TENDORA_CAPTURE_NETWORK_LOG: join(directory, 'network-attempts.jsonl'),
      },
      input:
        conditionalCommands
          .map((command) => JSON.stringify({ timeout: 5, ...command }))
          .join('\n') + '\n',
      encoding: 'utf8',
      timeout: 40000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.equal(
    conditionalCapture.status,
    0,
    conditionalCapture.stderr || conditionalCapture.stdout,
  );
  for (const line of conditionalCapture.stdout.trim().split('\n')) {
    const capturedFrame = JSON.parse(line);
    assert(!capturedFrame.error, line);
    assert.doesNotMatch(capturedFrame.screen, /Shift-D|Develop:|Routing model: undefined/u);
  }
  assert.deepEqual(
    await Promise.all([conditional.path, linkedPath].map((path) => readFile(path, 'utf8'))),
    immutableRecordings,
  );
  assert.deepEqual(await hashes(projectRoot), original);
  await assert.rejects(readFile(join(directory, 'network-attempts.jsonl')), { code: 'ENOENT' });
  transitions.push(
    'Public linked-recording PTY: parent opening -> context -> unadopted proposal -> exact child return, with all recording/project bytes unchanged',
  );
  await writeFile(
    join(directory, 'state-frames.json'),
    JSON.stringify(
      {
        provenance:
          'Actual renderer output after asserted read-only diagnostic keyboard actions. This is explicit --recording tooling, not the normal project surface.',
        frames,
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    join(directory, 'coverage.json'),
    JSON.stringify(
      {
        transitions,
        boundary: 'Legacy authoring code is not exposed by the read-only --recording entry',
        fixtureLimits: [
          'Context/proposal readings are declared symbolic fixture inputs, not model acquisition or accepted interpretations',
          'Continuation metadata is assembled with the existing authoredContinuation helper solely to exercise saved-link inspection',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`ok recording diagnostic spine and CLI selectors: ${directory}`);
} finally {
  app?.dispose();
  globalThis.fetch = oldFetch;
}
