/** Recompute the bundled demo's answers offline and publish compact, portable stores. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProject } from '../src/project/authoring/project.mjs';
import { listInvestigations } from '../src/project/inquiries/investigation.mjs';
import { captureProjectInquiry } from '../src/project/inquiries/inquiry.mjs';
import { compactEngineStorage } from '../src/project/inquiries/engine-storage.mjs';
import {
  listEngineRuns,
  readEngineRun,
  saveEngineRun,
} from '../src/project/storage/engine-runs.mjs';
import {
  compactDataFiles,
  readDataFile,
  withDataDatabase,
} from '../src/project/storage/data-files.mjs';
import { discardRoleVectorIndex } from '../src/project/storage/role-vectors.mjs';
import { openArtifactDatabase, loadArtifact } from '../src/project/storage/engine-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundled = join(root, '.proj/payments-on-call');
await mkdir(join(root, 'tmp'), { recursive: true });
const directory = await mkdtemp(join(root, 'tmp/payments-refresh-'));
const before = new Map();
const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url) => {
  requests.push(String(url));
  throw new Error('Demo refresh must stay offline: ' + url);
};
try {
  for (const name of ['project.json', 'material.sqlite'])
    await cp(join(bundled, name), join(directory, name));
  const files = withDataDatabase(directory, (db) =>
    db.prepare('SELECT path FROM files WHERE block IS NOT NULL').all(),
  );
  for (const { path } of files)
    before.set(path, await readDataFile(directory, join(directory, path)));
  const project = await openProject(directory);
  const questions = (await listInvestigations(project)).flatMap(({ data }) => data.asks);
  assert(questions.length, 'The demo needs saved questions');
  for (const question of questions) {
    const { recording, path } = await captureProjectInquiry(
      project,
      question.scopePlacementId,
      question.question,
      undefined,
      undefined,
      { acquireMissing: false, caseSelection: question.caseSelection },
    );
    const run = await readEngineRun(project, recording.reasoning.runId);
    assert(
      !['failed', 'cancelled', 'needs-amr', 'needs-reading', 'invalid-amr'].includes(run.status),
    );
    assert(!run.calls.some((call) => ['AMR', 'embedding'].includes(call.client)));
    // The UI reconstructs its traversal from the retained result at the new location.
    // Do not bundle recording handles tied to the generation directory.
    delete run.recording;
    await saveEngineRun(project, run);
    await rm(path);
    console.log(`${run.status}: ${question.question}`);
  }
  assert.deepEqual(requests, []);
  await compactEngineStorage(project, { force: true, budget: 64 * 1024 * 1024 });
  const runs = await listEngineRuns(project);
  assert.equal(runs.length, questions.length);
  assert(runs.every((run) => run.cache === 'retained' && run.answer && run.resultRef));
  assert(!JSON.stringify(runs).includes(directory), 'Run metadata must be portable');
  const database = openArtifactDatabase(join(directory, 'engine/artifacts.sqlite'));
  try {
    for (const { hash } of database.prepare('SELECT hash FROM artifacts').all()) {
      const artifact = loadArtifact(database, hash);
      assert(!JSON.stringify(artifact).includes(directory), 'Artifacts must be portable');
    }
  } finally {
    database.close();
  }
  discardRoleVectorIndex(directory);
  await compactDataFiles(directory);
  for (const [path, bytes] of before)
    assert.equal(await readDataFile(directory, join(directory, path)), bytes, path);
  assert.equal(
    await readFile(join(directory, 'project.json'), 'utf8'),
    await readFile(join(bundled, 'project.json'), 'utf8'),
  );
  await mkdir(join(bundled, 'engine'), { recursive: true });
  for (const name of ['material.sqlite', 'engine/artifacts.sqlite']) {
    const temporary = join(bundled, name + '.tmp');
    await cp(join(directory, name), temporary);
    await rename(temporary, join(bundled, name));
  }
  console.log(`Saved ${runs.length} offline results with their evidence.`);
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
