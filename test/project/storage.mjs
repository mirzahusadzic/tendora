/** Projects retain source identity while saving only changed concept objects. */
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  writeFile,
  rm,
  unlink,
  utimes,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createProject,
  openProject,
  saveProject,
  listProjects,
} from '../../src/project/authoring/project.mjs';
import { conceptSources } from '../../src/project/authoring/sources.mjs';
import { readObject, writeObject } from '../../src/project/storage/objects.mjs';
import {
  compactDataFiles,
  listDataFiles,
  writeDataFile,
} from '../../src/project/storage/data-files.mjs';
import { readAcquisitions, retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import {
  acquireEngineRunLease,
  engineDeletionLockPath,
} from '../../src/project/storage/engine-runs.mjs';
import { deleteEngineRuns } from '../../src/project/inquiries/delete-engine-runs.mjs';
import {
  fileLeaseActive,
  malformedLeaseStaleMs,
  withFileLease,
} from '../../src/project/storage/locks.mjs';
import {
  projectOutlineIndex,
  conceptOutline,
  developmentOutline,
} from '../../src/tui/concepts/project-outline.mjs';
const directory = await mkdtemp(join(tmpdir(), 'corpus-storage-'));
try {
  const count = 10_000,
    started = performance.now();
  const data = {
    version: 1,
    id: 'large-project',
    name: 'Large corpus',
    concepts: Array.from({ length: count }, (_, i) => ({
      id: `c${i}`,
      name: `Concept ${i}`,
      passages: [`Source material ${i}.`],
    })),
    placements: Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      conceptId: `c${i}`,
      parentId: i ? 'p0' : null,
    })),
  };
  await writeFile(join(directory, 'project.json'), JSON.stringify(data));
  const legacy = await openProject(directory);
  const saved = await saveProject(legacy, legacy.data);
  const index = JSON.parse(await readFile(saved.path, 'utf8'));
  assert.equal(index.version, 2);
  assert.equal(index.corpora.length, count);
  assert(!index.concepts);
  assert(!JSON.stringify(index).includes('Source material'));
  assert.equal((await listDataFiles(directory, 'corpora')).length, count);
  assert(
    saved.data.concepts.every((concept) => !concept.sourceRecords),
    'Derived identities do not duplicate every sentence',
  );
  assert.deepEqual((await openProject(directory)).data, data);
  await compactDataFiles(directory);
  const before = conceptSources(saved.data.concepts[21])[0];
  const changed = structuredClone(saved.data);
  changed.concepts[21].passages[0] = 'Revised source material.';
  const edited = await saveProject(saved, changed),
    reopened = await openProject(directory);
  assert.equal(edited.storage.corpora.filter((ref, i) => ref !== index.corpora[i]).length, 1);
  assert.equal((await listDataFiles(directory, 'corpora')).length, count + 1);
  assert.equal(conceptSources(reopened.data.concepts[21])[0].id, before.id);
  assert.notEqual(conceptSources(reopened.data.concepts[21])[0].revision, before.revision);
  await assert.rejects(saveProject(saved, saved.data), { code: 'PROJECT_CHANGED' });
  assert.equal((await listProjects(directory))[0].count, count);
  const buildStart = performance.now();
  const tree = projectOutlineIndex(reopened.data);
  assert.equal(conceptOutline(tree, new Set(['p0'])).length, count);
  assert.equal(developmentOutline(tree, 'p21').length, 0);
  assert.equal(projectOutlineIndex(reopened.data), tree);
  const deep = {
    ...data,
    placements: data.placements.map((placement, i) => ({
      ...placement,
      parentId: i ? `p${i - 1}` : null,
    })),
  };
  assert.equal(
    projectOutlineIndex(deep).all.length,
    count,
    'Deep concept trees do not recurse on the JS stack',
  );
  const treeMs = Math.round(performance.now() - buildStart);
  const shared = { text: 'Concurrent immutable record '.repeat(1000) };
  const refs = await Promise.all(
    Array.from({ length: 32 }, () => writeObject(directory, 'records', shared)),
  );
  assert.equal(new Set(refs).size, 1);
  assert.deepEqual(await readObject(directory, 'records', refs[0]), shared);

  const concurrent = await createProject(join(directory, 'concurrent'), 'Concurrent project');
  // Creating where a project exists stops before writing into its store
  // (final review #11).
  const store = await readFile(join(directory, 'concurrent', 'material.sqlite'));
  await assert.rejects(createProject(join(directory, 'concurrent'), 'Again'), {
    code: 'EEXIST',
    message: /A project already exists/u,
  });
  assert.deepEqual(await readFile(join(directory, 'concurrent', 'material.sqlite')), store);
  await Promise.all(
    ['first retained text', 'second retained text'].map((text) =>
      retainAcquisitions(concurrent, [
        {
          text,
          penman: `(t / text :value "${text}")`,
          origin: { kind: 'concurrency-test' },
        },
      ]),
    ),
  );
  assert.equal(
    Object.keys((await readAcquisitions(concurrent)).entries).length,
    2,
    'Concurrent retained-language updates merge instead of losing one writer',
  );
  await writeFile(
    join(directory, 'concurrent', '.acquisitions-index.lock'),
    `${JSON.stringify({ pid: 1_073_741_824 })}\n`,
  );
  await retainAcquisitions(concurrent, [
    {
      text: 'retained after an interrupted writer',
      penman: '(r / retain-01)',
      origin: { kind: 'stale-lease-test' },
    },
  ]);
  assert.equal(Object.keys((await readAcquisitions(concurrent)).entries).length, 3);

  // A crashed saver's lease is recovered: a dead owner at once, an unreadable one once stale.
  const projectLease = `${concurrent.path}.lock`;
  await writeFile(projectLease, `${JSON.stringify({ pid: 1_073_741_824 })}\n`);
  let recovered = await saveProject(concurrent, structuredClone(concurrent.data));
  await assert.rejects(readFile(projectLease), { code: 'ENOENT' });
  await writeFile(projectLease, '');
  assert.equal(await fileLeaseActive(projectLease), true, 'A just-created lease may be publishing');
  const old = new Date(Date.now() - 2 * malformedLeaseStaleMs);
  await utimes(projectLease, old, old);
  recovered = await saveProject(recovered, structuredClone(recovered.data));
  await assert.rejects(readFile(projectLease), { code: 'ENOENT' });
  const investigationLease = join(directory, 'concurrent', 'investigations', 'stale.json.lock');
  await mkdir(join(directory, 'concurrent', 'investigations'), { recursive: true });
  await writeFile(investigationLease, '{"pid":');
  await utimes(investigationLease, old, old);
  assert.equal(await fileLeaseActive(investigationLease), false);
  await assert.rejects(readFile(investigationLease), { code: 'ENOENT' });
  const failure = new Error('operation failed');
  await assert.rejects(
    withFileLease(projectLease, async () => {
      // Make the lease unremovable; root may still remove it, which is equally correct.
      await chmod(dirname(projectLease), 0o555);
      throw failure;
    }).finally(() => chmod(dirname(projectLease), 0o755)),
    (error) => error === failure,
    'Lease cleanup never replaces the operation failure',
  );
  await rm(projectLease, { force: true });
  await withFileLease(projectLease, () =>
    assert.rejects(
      withFileLease(projectLease, async () => {}, { timeoutMs: 20, busyMessage: 'busy' }),
      /busy/u,
      'A live owner still excludes other writers',
    ),
  );
  await assert.rejects(readFile(projectLease), { code: 'ENOENT' });
  concurrent.digest = recovered.digest;

  const deletionPath = engineDeletionLockPath(concurrent),
    deletion = await open(deletionPath, 'wx');
  let runAcquired = false;
  const waitingRun = acquireEngineRunLease(concurrent, randomUUID()).then((release) => {
    runAcquired = true;
    return release;
  });
  await delay(25);
  assert.equal(runAcquired, false, 'A new run waits while an engine reset owns the project');
  await deletion.close();
  await unlink(deletionPath);
  const releaseRun = await waitingRun;
  await assert.rejects(
    deleteEngineRuns(concurrent, { all: true }),
    /running engine/u,
    'An engine reset cannot pass a newly started run',
  );
  await releaseRun();
  const staleRunId = randomUUID(),
    activeDirectory = join(directory, 'concurrent', 'engine', 'active');
  await mkdir(activeDirectory, { recursive: true });
  await writeFile(
    join(activeDirectory, `${staleRunId}.lock`),
    `${JSON.stringify({ id: staleRunId, pid: 1_073_741_824 })}\n`,
  );
  assert.equal((await deleteEngineRuns(concurrent, { all: true })).reset, true);

  const object = join(directory, 'corpora', `${index.corpora[0]}.json`);
  await writeDataFile(directory, object, '{}\n');
  await assert.rejects(openProject(directory), /Stored object changed/);
  console.log(
    `ok 10,000 authored concepts: one-object edit, identity, migration, deduplication, stale-write and integrity guards (${Math.round(performance.now() - started)} ms; tree ${treeMs} ms)`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
