/** Fresh projects build their evidence; caches are optional and history is separate. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProject,
  saveProject,
  editConcept,
  addConcept,
} from '../../src/project/authoring/project.mjs';
import { selectCase, listInvestigations } from '../../src/project/inquiries/investigation.mjs';
import { inputFromProject } from '../../src/engine/input.mjs';
import { runEngine } from '../../src/engine/run.mjs';
import { acquiredTexts, readAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import { readEngineArtifact, readEngineRun } from '../../src/project/storage/engine-runs.mjs';
import { clientSections } from '../../src/tui/engine/view.mjs';
import { expandRelation } from '../../src/amr/fragment-composition.mjs';
import { removeDataArea } from '../../src/project/storage/data-files.mjs';

const directory = await mkdtemp(join(tmpdir(), 'engine-build-')),
  fetch = globalThis.fetch;
const source = 'Technician Mira calibrates the spectral instrument.';
const other = 'Technician Mira maintains the spectral instrument.';
const ticket = 'The spectral instrument is defective.';
const question = 'Who calibrates the spectral instrument?';
const graphs = new Map([
  [
    source,
    '(c / calibrate-01 :ARG0 (t / technician :name (n / name :op1 "Mira")) :ARG1 (i / instrument :mod (s / spectral)))',
  ],
  [
    other,
    '(m / maintain-01 :ARG0 (t / technician :name (n / name :op1 "Mira")) :ARG1 (i / instrument :mod (s / spectral)))',
  ],
  [ticket, '(i / instrument :mod (s / spectral) :mod (d / defective))'],
  [
    question,
    '(c / calibrate-01 :ARG0 (u / amr-unknown) :ARG1 (i / instrument :mod (s / spectral)))',
  ],
]);
let requested = [],
  decodeFailure = false;
const parser = async (url, options) => {
  assert(url.endsWith('/amr/parse-batch'), 'No embeddings or answer model are called');
  const { texts } = JSON.parse(options.body);
  requested.push(texts);
  return {
    ok: true,
    json: async () =>
      texts.map((text) => {
        assert(graphs.has(text), `Only authored inputs are parsed: ${text}`);
        return {
          model: 'test-AMR-ingress',
          revision: 'v1',
          decode_status: decodeFailure && text === question ? 'invalid' : 'ok',
          decode_error:
            decodeFailure && text === question ? 'Decoder could not construct this question' : null,
          penman: decodeFailure && text === question ? null : graphs.get(text),
        };
      }),
  };
};
try {
  globalThis.fetch = parser;
  let project = await createProject(directory, 'Fresh workshop', 'Workshop');
  assert.equal(await readAcquisitions(project), null);
  const root = project.data.placements[0].id,
    concept = project.data.concepts[0];
  const authored = editConcept(project.data, concept.id, concept.name, [source, other]);
  const added = addConcept(authored, null, 'Instrument case');
  const caseConcept = added.data.placements.find((item) => item.id === added.placementId).conceptId;
  project = await saveProject(
    project,
    editConcept(added.data, caseConcept, 'Instrument case', [ticket]),
  );
  const execute = async (options = {}) =>
    runEngine(project, {
      input: await inputFromProject(project, {
        scopePlacementId: root,
        question,
        caseSelection: selectCase(project, added.placementId),
      }),
      acquireMissing: true,
      semantic: false,
      ...options,
    });
  const run = await execute();
  assert(['supported', 'conditional'].includes(run.status), run.error ?? run.status);
  assert.equal(run.answer.answers[0].text, 'Mira');
  assert.equal(run.status, 'supported', 'A name describing the answer is not an unmet condition');
  assert(run.answer.sources.some((item) => item.text === source));
  assert.deepEqual(requested, [[source, other, ticket, question]]);
  assert.deepEqual(
    run.stages.map((stage) => stage.id),
    [
      'inputs',
      'acquisition',
      'prepare',
      'vocabulary',
      'fragments',
      'compose',
      'unknown',
      'boundaries',
      'relations',
      'answer',
    ],
  );
  assert(run.stages.every((stage) => stage.status === 'complete'));
  assert(run.calls.some((call) => call.client === 'SEMCAT'));
  assert(run.calls.every((call) => call.requestRef && call.responseRef));
  assert.equal(run.policy.reasoning, 'deterministic');
  assert.equal(run.policy.embeddings, false);
  const result = await readEngineArtifact(project, run.resultRef),
    input = await readEngineArtifact(project, run.inputRef);
  const calibratingSource = result.inputs.find((item) => item.text === source);
  const namedTechnician = calibratingSource.graph.nodes.find(
    (node) => node.concept === 'technician',
  );
  assert.deepEqual(run.answer.answers[0].bindings, [
    { id: `${calibratingSource.id}#${namedTechnician.id}`, text: 'Mira' },
  ]);
  assert.deepEqual(run.answer.answers[0].sourceIds, [calibratingSource.id]);
  assert(run.answer.answers[0].derivation?.tree, 'The named participant retains its chart proof');
  assert(result.definitions.length && result.applications.length && result.chains.length);
  const sorted = (values) => [...values].sort((a, b) => a.id.localeCompare(b.id));
  for (const definition of result.definitions) {
    const expanded = expandRelation(definition),
      source = result.inputs.find((item) => item.id === definition.sourceId);
    assert.deepEqual(sorted(expanded.nodes), sorted(source.graph.nodes));
    assert.deepEqual(sorted(expanded.edges), sorted(source.graph.edges));
  }
  assert(
    input.sources.every(
      (item) => item.acquisition.ref && item.acquisition.origin.kind === 'runtime-acquisition',
    ),
  );
  assert(
    (await readEngineArtifact(project, run.sourceInputRef)).question.acquisition.status ===
      'missing',
  );
  const call = run.calls.find((call) => call.client === 'AMR');
  const sections = clientSections(
    call,
    await readEngineArtifact(project, call.requestRef),
    await readEngineArtifact(project, call.responseRef),
  );
  assert.deepEqual(sections[0].table.headers, ['Input text']);
  assert.equal(sections[1].table.entries[0].cells[1], 'Decoded');
  assert.deepEqual(
    await listInvestigations(project),
    [],
    'Core execution does not author an investigation',
  );
  await assert.rejects(access(join(directory, 'recordings')), { code: 'ENOENT' });

  requested = [];
  await rm(join(directory, 'engine'), { recursive: true });
  const rebuilt = await execute();
  assert.equal(rebuilt.status, run.status, rebuilt.error);
  assert.deepEqual(requested, [], 'Exact AMRs are reused while derived artifacts are rebuilt');
  assert(!rebuilt.calls.some((call) => call.client === 'AMR'));

  const offline = await execute({ acquireMissing: false, trace: false });
  assert.equal(offline.answer.status, run.answer.status);
  assert.equal(offline.traceStatus, 'skipped');
  assert.deepEqual(offline.answer.answers[0].sourceIds, run.answer.answers[0].sourceIds);
  assert(offline.answer.answers[0].bindings[0].id);
  assert(!offline.calls.some((call) => ['SEMCAT', 'AMR'].includes(call.client)));
  const bounded = await execute({ bounds: { maximumPairs: 0 } });
  assert.equal(
    bounded.status,
    run.status,
    'Optional correspondence limits cannot suppress an answer',
  );
  assert.equal(bounded.traceStatus, 'limited');
  assert(bounded.openings.some((opening) => opening.kind === 'correspondence'));
  const unavailable = await execute({
    clients: {
      compare: async () => {
        throw new Error('Correspondence unavailable');
      },
    },
  });
  assert.equal(unavailable.status, run.status);
  assert.equal(unavailable.traceStatus, 'failed');
  assert(unavailable.calls.some((call) => call.client === 'SEMCAT' && call.errorRef));
  const partialInput = await inputFromProject(project, { scopePlacementId: root, question });
  const omitted = partialInput.sources.find((entry) => entry.text === other);
  omitted.acquisition = { status: 'missing', reason: 'Deliberately withheld' };
  partialInput.openings.push({
    kind: 'acquisition',
    inputId: omitted.id,
    reason: 'Deliberately withheld',
  });
  const partial = await runEngine(project, { input: partialInput, trace: false });
  // A statement in scope without a reading could deny the answer: it is not
  // given as supported, but kept, incomplete (final review, #2).
  assert.equal(partial.status, 'needs-reading', 'A missing reading is never a supported answer');
  assert.deepEqual(
    partial.answer.answers.map((answer) => answer.text),
    run.answer.answers.map((answer) => answer.text),
    'The answer from the statements that were read stays visible',
  );
  assert.equal(partial.coverage.complete, false);
  assert.deepEqual(partial.coverage.sources, { total: 2, prepared: 1 });
  assert(
    partial.openings.some((opening) => opening.kind === 'acquisition'),
    'Missing AMRs remain visible beside the incomplete answer',
  );
  omitted.acquisition = { status: 'retained', penman: '(' };
  partialInput.openings = [];
  const malformed = await runEngine(project, { input: partialInput, trace: false });
  assert.equal(malformed.status, 'needs-reading', 'An unusable reading is a missing one');
  assert.equal(malformed.coverage.complete, false);
  assert(malformed.openings.some((opening) => opening.kind === 'normalization'));

  const missingQuestion = await inputFromProject(project, {
    scopePlacementId: root,
    question: 'Who tests the instrument?',
  });
  const waiting = await runEngine(project, { input: missingQuestion });
  assert.equal(waiting.status, 'needs-amr');
  assert.equal(waiting.answer, undefined);
  assert(!waiting.stages.some((stage) => stage.id === 'answer'));
  assert(!waiting.calls.some((call) => ['AMR', 'SEMCAT'].includes(call.client)));
  assert.equal(waiting.coverage.question, false);
  missingQuestion.question.acquisition = { status: 'retained', penman: '(' };
  missingQuestion.openings = [];
  const invalidQuestion = await runEngine(project, { input: missingQuestion });
  assert.equal(invalidQuestion.status, 'invalid-amr');
  assert.equal(invalidQuestion.answer, undefined);
  assert(invalidQuestion.openings.some((opening) => opening.kind === 'normalization'));

  const edited = source.replace('instrument.', 'instrument carefully.');
  graphs.set(edited, graphs.get(source).replace(/\)$/u, ' :manner (c2 / careful))'));
  project = await saveProject(
    project,
    editConcept(project.data, concept.id, concept.name, [edited, other]),
  );
  await execute();
  assert.deepEqual(requested, [[edited]], 'A text revision reparses only the changed input');

  await removeDataArea(directory, 'acquisitions');
  requested = [];
  decodeFailure = true;
  const invalid = await execute();
  assert.equal(invalid.status, 'needs-amr', invalid.error);
  assert(
    invalid.openings.some((item) => item.reason === 'Decoder could not construct this question'),
  );
  assert.equal(
    (await acquiredTexts(project, [question]))[0].status,
    'missing',
    'Failed decoding is never cached as valid',
  );
  requested = [];
  decodeFailure = false;
  const retry = await execute();
  assert(['supported', 'conditional'].includes(retry.status), retry.error ?? retry.status);
  assert.deepEqual(requested, [[question]], 'Successful inputs survive a partial decoder failure');

  await removeDataArea(directory, 'acquisitions');
  globalThis.fetch = async () => {
    throw new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  };
  const failed = await execute();
  assert.equal(failed.status, 'failed');
  assert.match(failed.calls[0].error, /AMR parsing.*ECONNREFUSED/u);
  assert.equal((await readEngineRun(project, failed.id)).status, 'failed');
  assert((await readEngineArtifact(project, failed.calls[0].errorRef)).stack);
  assert.equal(await readAcquisitions(project), null);
  globalThis.fetch = parser;
  requested = [];
  const controller = new AbortController();
  const cancelled = await execute({
    signal: controller.signal,
    onUpdate(run) {
      if (run.calls.some((call) => call.status === 'running'))
        controller.abort(new Error('Cancel acquisition'));
    },
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(
    await readAcquisitions(project),
    null,
    'Cancelled acquisition leaves no valid cache entry',
  );
  assert.deepEqual(await listInvestigations(project), []);
  console.log(
    'ok fresh engine acquisition, real PENMAN/SEMCAT, lossless fragment reuse, qualified answer, cache rebuild, revisions, failure and cancellation; no investigation',
  );
} finally {
  globalThis.fetch = fetch;
  await rm(directory, { recursive: true, force: true });
}
