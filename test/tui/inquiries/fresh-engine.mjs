/** Drive New project through the real Ask controller and local PENMAN client. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createWorkbench } from '../../../src/tui/shell/app.mjs';
import { createState } from '../../../src/tui/shell/state.mjs';
import { inputFromProject } from '../../../src/engine/input.mjs';
import { readAcquisitions, acquiredTexts } from '../../../src/project/storage/acquisitions.mjs';
import {
  readEngineRun,
  readEngineArtifact,
  listEngineRuns,
} from '../../../src/project/storage/engine-runs.mjs';
import {
  currentAsk,
  readInvestigation,
  listInvestigations,
} from '../../../src/project/inquiries/investigation.mjs';
import { listProjectRecordings } from '../../../src/project/inquiries/recordings.mjs';
import { interpretationRevision } from '../../../src/recording/revisions.mjs';
import { deleteEngineRuns } from '../../../src/project/inquiries/delete-engine-runs.mjs';

class Terminal extends EventEmitter {
  width = 150;
  height = 42;
  frames = [];
  fullscreen() {}
  hideCursor() {}
  grabInput() {}
  styleReset() {}
  raw(frame) {
    this.frames.push(frame);
  }
}

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/fresh-ui-engine-'));
const originalFetch = globalThis.fetch;
const source = 'The robot calibrates the instrument.';
const caseText = 'The instrument is damaged.';
const question = 'Who calibrates the instrument?';
const openQuestion = 'Who maintains the instrument?';
const cancelledQuestion = 'Who repairs the instrument?';
// Only parser ingress is mocked. All acquisition, normalization and reasoning code runs.
const graphs = new Map([
  [source, '(c / calibrate-01 :ARG0 (r / robot) :ARG1 (i / instrument))'],
  [caseText, '(i / instrument :mod (d / damaged))'],
  [question, '(c / calibrate-01 :ARG0 (u / amr-unknown) :ARG1 (i / instrument))'],
  [openQuestion, '(m / maintain-01 :ARG0 (u / amr-unknown) :ARG1 (i / instrument))'],
  [cancelledQuestion, '(r / repair-01 :ARG0 (u / amr-unknown) :ARG1 (i / instrument))'],
]);
const requests = [];
let behavior = 'hold';
let started = deferred();
let release = deferred();
let app;
try {
  globalThis.fetch = async (url, options) => {
    assert(url.endsWith('/amr/parse-batch'), 'UI never falls back to embeddings or another model');
    const { texts } = JSON.parse(options.body);
    assert(
      texts.every((text) => graphs.has(text)),
      'Only authored text is sent to acquisition',
    );
    requests.push(texts);
    started.resolve();
    if (behavior === 'hold') {
      await new Promise((resolve, reject) => {
        release.promise.then(resolve);
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
      });
    }
    if (behavior === 'fail') throw new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    options.signal.throwIfAborted();
    return {
      ok: true,
      json: async () =>
        texts.map((text) => ({
          penman: graphs.get(text),
          decode_status: 'ok',
          model: 'test-parser-ingress',
          revision: 'v1',
        })),
    };
  };
  const term = new Terminal();
  const config = {
    projectsHome: directory,
    preferencesPath: join(directory, '.layout'),
    noColor: true,
  };
  const state = createState({ mode: 'home' }, config);
  const exits = [];
  app = createWorkbench({ state, config, term, onExit: (code) => exits.push(code) });
  app.start();
  const key = async (value, isCharacter = false) => {
    term.emit('key', value, [], { isCharacter });
    await app.idle();
    assert.equal(state.failure, '');
    assert.deepEqual(exits, []);
  };
  const submit = async () => {
    const form = state.form;
    await key('ENTER');
    assert(form.execution, 'Ask owns an actual engine execution');
    return form;
  };

  await key('ENTER');
  await key('Engine workshop', true);
  await key('ENTER');
  await key('ENTER');
  await key('Lab', true);
  await key('ENTER');
  assert.equal(state.mode, 'project');
  assert.equal(state.project.data.concepts[0].passages.length, 0);
  assert.equal(await readAcquisitions(state.project), null);
  assert.deepEqual(requests, []);
  assert(
    state.viewport.actionHits.some((hit) => hit.pane === 'nodes' && hit.inputKey === 'a'),
    'An empty project offers Ask without requiring artifacts',
  );
  const root = state.placementId;

  behavior = 'normal';
  const statements = async (text) => {
    await key('n');
    await key(text, true);
    const form = state.form;
    await key('CTRL_S');
    await form.execution;
    assert.equal(state.form, null, form.error);
  };
  await statements(source);
  while (state.focus !== 'nodes') await key('TAB');
  await key('c');
  await key('Instrument', true);
  await key('ENTER');
  const casePlacement = state.placementId;
  await statements(caseText);
  assert.deepEqual(
    requests,
    [[source], [caseText]],
    'Statement authoring retains each exact language reading',
  );
  behavior = 'hold';
  started = deferred();
  release = deferred();
  const authoredDigest = state.project.digest;
  assert(term.frames.at(-1).includes(caseText));
  assert.equal(state.project.digest, authoredDigest, 'Corpus review preserves legacy authoring');
  assert(state.viewport.developmentHeight > 0);

  await key('a');
  assert.equal(state.focus, 'reading', 'Ask starts at the question');
  await key('ALT_C');
  await key('END');
  await key('ENTER');
  await key(question, true);
  await key('ALT_S');
  await key('HOME');
  await key('ENTER');
  assert.equal(state.placementId, root);
  assert.equal(state.form.caseSelection.placementId, casePlacement);
  const first = await submit();
  await started.promise;
  assert.equal(state.serviceStatus.egemma, 'running');
  assert(term.frames.at(-1).includes('AMR - running'));
  await assert.rejects(deleteEngineRuns(state.project, { all: true }), /running engine/u);
  release.resolve();
  await first.execution;
  assert.equal(state.mode, 'project', first.error);
  assert.equal(state.form, null);
  assert.deepEqual(requests, [[source], [caseText], [question]]);
  const recording = state.ix.recording;
  assert.equal(recording.reasoning.status, 'supported');
  assert.equal(recording.reasoning.answer.answers[0].text, 'robot');
  assert.equal(recording.models.embedding, null);
  assert(!recording.reasoning.calls.some((call) => call.client === 'SEMCAT'));
  assert.equal(recording.reasoning.stages.filter((stage) => stage.id === 'answer').length, 1);
  assert(term.frames.some((frame) => frame.includes('robot')));
  assert(state.projectEngineRuns.some((run) => run.id === recording.reasoning.runId));
  const run = await readEngineRun(state.project, recording.reasoning.runId);
  assert.equal(run.ask.askId, recording.ask.askId);
  const savedInput = await readEngineArtifact(state.project, run.inputRef);
  const cliInput = await inputFromProject(state.project, {
    scopePlacementId: root,
    question,
    caseSelection: savedInput.caseSelection,
  });
  assert.deepEqual(
    savedInput.sources.map(({ text, id }) => ({ text, id })),
    cliInput.sources.map(({ text, id }) => ({ text, id })),
  );
  assert.deepEqual(
    savedInput.cases.map(({ text, id }) => ({ text, id })),
    cliInput.cases.map(({ text, id }) => ({ text, id })),
  );
  assert(
    savedInput.sources.every((input) => recording.sources.some((source) => source.id === input.id)),
    'Engine source IDs link to the existing Reading evidence',
  );
  const ask = currentAsk(
    (await readInvestigation(state.project, recording.ask.investigationId)).data,
  );
  assert.equal(ask.runs[0].engineRunId, run.id);
  assert.equal(JSON.parse(await readFile(run.recording.path, 'utf8')).reasoning.runId, run.id);

  behavior = 'normal';
  await key('a');
  await key(question, true);
  const repeat = await submit();
  await repeat.execution;
  assert.equal(state.mode, 'project', repeat.error);
  assert.equal(requests.length, 3, 'Replay uses acquired AMRs without another parser call');
  assert(!state.ix.recording.reasoning.calls.some((call) => call.client === 'AMR'));

  await key('a');
  await key('ALT_U');
  await key(openQuestion, true);
  behavior = 'fail';
  const failed = await submit();
  await failed.execution;
  assert.equal(state.form, failed);
  assert.match(failed.error, /AMR parsing.*ECONNREFUSED/u);
  assert.equal(state.serviceStatus.egemma, 'failed');
  assert.equal((await readEngineRun(state.project, failed.engineRunId)).status, 'failed');
  assert(!state.viewport.actionHits.some((hit) => hit.inputKey === 'ALT_L'));
  await key('ALT_L');
  assert.equal(state.form, failed, 'Removed execution shortcut has no action');
  assert.equal(state.form.fields[0].value, openQuestion);
  behavior = 'normal';
  const recovered = await submit();
  await recovered.execution;
  assert.equal(state.mode, 'project', recovered.error);
  assert.equal(state.ix.recording.reasoning.status, 'open');
  assert(state.ix.recording.reasoning.openings.length);
  assert.deepEqual(
    requests.slice(3),
    [[openQuestion], [openQuestion]],
    'Failure and retry acquire only the changed question',
  );

  await key('a');
  await key('ALT_U');
  await key(cancelledQuestion, true);
  behavior = 'hold';
  started = deferred();
  release = deferred();
  const cancelled = await submit();
  await started.promise;
  await key('ESCAPE');
  await cancelled.execution;
  assert.equal(state.form, cancelled);
  assert.equal(cancelled.busy, false);
  assert.equal(cancelled.fields[0].value, cancelledQuestion);
  assert.equal(state.serviceStatus.egemma, 'cancelled');
  assert.equal((await readEngineRun(state.project, cancelled.engineRunId)).status, 'cancelled');
  assert.equal((await acquiredTexts(state.project, [cancelledQuestion]))[0].status, 'missing');
  await key('ESCAPE');
  while (state.focus !== 'nodes') await key('TAB');
  await key('HOME');
  await key('o');
  const chosen = state.workflow.developmentItems().findIndex((choice) => choice.label === question);
  assert(chosen >= 0);
  await key('HOME');
  for (let i = 0; i < chosen; i++) await key('DOWN');
  await key('ENTER');
  assert.equal(state.workflow.current().input.question.text, question);
  assert.equal(state.viewport.recordingsHeight, 0);
  assert(state.viewport.developmentHeight > 0);
  assert(!term.frames.at(-1).includes('alt+q'));

  const authored = await readFile(state.project.path, 'utf8');
  const recordingsBefore = await listProjectRecordings(state.project);
  const projectDirectory = dirname(state.project.path);
  const interpretation = join(
    projectDirectory,
    'recordings',
    '.interpretations',
    interpretationRevision(recording),
  );
  const evaluation = join(projectDirectory, 'recordings', '.evaluations', 'review.json');
  const continuation = join(projectDirectory, '.continuations', 'draft.json');
  await mkdir(interpretation, { recursive: true });
  await writeFile(join(interpretation, 'decision.json'), '{}');
  for (const path of [evaluation, continuation]) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ recordingPath: run.recording.path }));
  }

  // Run maintenance is a storage contract; it is no longer an authoring menu.
  assert.equal((await readEngineRun(state.project, run.id)).id, run.id);
  await deleteEngineRuns(state.project, { ids: [run.id] });
  await assert.rejects(readEngineRun(state.project, run.id), { code: 'ENOENT' });
  for (const path of [run.recording.path, interpretation, evaluation, continuation])
    await assert.rejects(access(path), { code: 'ENOENT' });
  assert.equal((await listProjectRecordings(state.project)).length, recordingsBefore.length - 1);
  const remainingAsk = currentAsk(
    (await readInvestigation(state.project, recording.ask.investigationId)).data,
  );
  assert(!remainingAsk.runs.some((item) => item.engineRunId === run.id));
  assert(
    (await listEngineRuns(state.project)).some((r) => r.status === 'supported'),
    'Other outcomes remain in the question history',
  );
  assert.equal(await readFile(state.project.path, 'utf8'), authored);
  assert(
    (await acquiredTexts(state.project, [source, caseText, question])).every(
      (item) => item.status === 'retained',
    ),
    'Shared AMRs remain available to the replay',
  );
  const retainedRefs = (item) => [
    item.inputRef,
    item.sourceInputRef,
    item.resultRef,
    item.errorRef,
    ...item.calls.flatMap((call) => [call.requestRef, call.responseRef, call.errorRef]),
  ];
  for (const remaining of await listEngineRuns(state.project))
    for (const ref of retainedRefs(remaining).filter(Boolean))
      await assert.doesNotReject(readEngineArtifact(state.project, ref));
  await assert.rejects(readEngineArtifact(state.project, run.sourceInputRef), { code: 'ENOENT' });

  await deleteEngineRuns(state.project, { all: true });
  assert(
    (await acquiredTexts(state.project, [source, caseText])).every(
      (item) => item.status === 'retained',
    ),
    'Reset preserves authored source readings',
  );
  assert.equal((await acquiredTexts(state.project, [question]))[0].status, 'missing');
  assert.deepEqual(await listEngineRuns(state.project), []);
  assert.deepEqual(await listInvestigations(state.project), []);
  assert.deepEqual((await readdir(projectDirectory)).sort(), ['material.sqlite', 'project.json']);
  assert.equal(await readFile(state.project.path, 'utf8'), authored);
  assert(term.frames.some((frame) => frame.includes(source)));
  assert(!term.frames.at(-1).includes('Engine runs'));
  await key('q', true);
  assert(state.quitPrompt);
  term.emit('key', 'y', [], { isCharacter: true });
  await app.idle();
  assert.deepEqual(exits, [0]);
  console.log(
    'ok New project → author → Ask → hierarchy; reuse, retry, cancellation, storage deletion/reset contracts and q',
  );
} finally {
  app?.dispose();
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
