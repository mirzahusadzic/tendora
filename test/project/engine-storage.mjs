/** Bounded checks must not delete questions, readings, or change decoded evidence. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createProject, openProject, saveProject } from '../../src/project/authoring/project.mjs';
import { retainAcquisitions, acquiredTexts } from '../../src/project/storage/acquisitions.mjs';
import { readObject, writeObject } from '../../src/project/storage/objects.mjs';
import { compactProjectStorage } from '../../src/project/inquiries/project-storage.mjs';
import {
  putEngineArtifact,
  readEngineArtifact,
  saveEngineRun,
  readEngineRun,
  listEngineRuns,
  acquireEngineRunLease,
} from '../../src/project/storage/engine-runs.mjs';
import {
  artifactDatabasePath,
  openArtifactDatabase,
  loadArtifact,
  storeArtifact,
} from '../../src/project/storage/engine-artifacts.mjs';
import {
  compactEngineStorage,
  engineStorageUsage,
} from '../../src/project/inquiries/engine-storage.mjs';
import { deleteEngineRuns } from '../../src/project/inquiries/delete-engine-runs.mjs';
import { readSavedRecording } from '../../src/project/storage/recordings.mjs';
import {
  listGrammarCaches,
  readGrammarCache,
  writeGrammarCache,
} from '../../src/project/storage/grammar.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/engine-storage-'));
// The defaults are soft and generous; small bounds here exercise eviction under pressure.
const budget = 256 * 1024,
  target = 300 * 1024;
try {
  let project = await createProject(directory, 'Storage contract');
  const data = structuredClone(project.data);
  data.concepts[0].passages = ['The technician checks the device.'];
  project = await saveProject(project, data);
  const authored = await readFile(project.path);
  await retainAcquisitions(project, [
    {
      text: 'The technician checks the device.',
      penman: '(c / check-01 :ARG0 (t / technician) :ARG1 (d / device))',
      origin: { kind: 'storage-contract' },
    },
    {
      text: 'An inspection is due.',
      penman: '(d / due-01 :ARG1 (i / inspect-01))',
      origin: { kind: 'storage-contract' },
    },
  ]);
  const source = {
    text: 'Shared source',
    rules: Array.from({ length: 1800 }, (_, i) => ({
      id: i,
      lhs: 'Relation',
      roles: ['ARG0', 'ARG1'],
      source: 'Retained source',
    })),
  };
  const value = {
    first: source,
    second: structuredClone(source),
    literal: { data: null, parts: [] },
  };
  const ref = await putEngineArtifact(project, value);
  const decoded = await readEngineArtifact(project, ref);
  assert.deepEqual(decoded, value);
  decoded.first.rules[0].lhs = 'Changed only in memory';
  assert.equal(
    decoded.second.rules[0].lhs,
    'Relation',
    'Storage sharing must not alias caller values',
  );
  assert.deepEqual(await readEngineArtifact(project, ref), value);
  const beforeRepeat = (await stat(artifactDatabasePath(project))).size;
  assert.equal(await putEngineArtifact(project, value), ref);
  assert.equal((await stat(artifactDatabasePath(project))).size, beforeRepeat);

  const legacy = { legacy: 'Retained diagnostic', unicode: 'å and ↩' };
  const legacyRef = await writeObject(directory, 'engine/objects', legacy);
  assert.deepEqual(await readEngineArtifact(project, legacyRef), legacy);
  const questions = new Map();
  await mkdir(join(directory, 'recordings'));
  for (let i = 0; i < 36; i++) {
    const question = `Does participant ${i % 12} check the device?`;
    const caseSelection =
      i % 2
        ? {
            kind: 'authored',
            label: 'Inspection',
            text: 'An inspection is due.',
            sources: [{ text: 'An inspection is due.' }],
          }
        : null;
    const input = {
      projectId: project.data.id,
      projectRevision: project.digest,
      scopePlacementId: project.data.placements[0].id,
      sources: [{ text: 'The technician checks the device.', kind: 'source' }],
      cases: caseSelection?.sources ?? [],
      caseSelection,
      question: { text: question },
    };
    const noise = Array.from({ length: 1600 }, (_, n) =>
      createHash('sha256').update(`${i}:${n}`).digest('hex'),
    );
    const result = { inputs: [input.question], grammar: source, diagnostics: noise };
    const run = {
      version: 1,
      id: randomUUID(),
      projectId: project.data.id,
      projectDigest: project.digest,
      scopePlacementId: input.scopePlacementId,
      purpose: 'inquiry',
      profile: 'storage-contract',
      status: 'open',
      startedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      questions: [{ text: question }],
      case: caseSelection?.text ?? '',
      caseSelection,
      inputRef: await putEngineArtifact(project, input),
      resultRef: await putEngineArtifact(project, result),
      calls: [],
      stages: [],
    };
    const recording = {
      schema: 'tendora.workbench.recording',
      version: 1,
      id: randomUUID(),
      project: { id: project.data.id, digest: project.digest },
      asset: { revision: project.digest },
      inquiry: { text: question },
      reasoning: { runId: run.id },
      evidence: result,
    };
    const path = join(directory, 'recordings', `${run.id}.json`);
    await writeFile(path, JSON.stringify(recording));
    run.recording = { path, id: recording.id };
    await saveEngineRun(project, run);
    questions.set(question, { run, input, result, recording });
  }
  const lease = await acquireEngineRunLease(project, randomUUID());
  assert.equal((await compactEngineStorage(project, { force: true, budget })).busy, true);
  await lease();
  const report = await compactEngineStorage(project, { force: true, budget });
  assert(report.after.bytes <= budget, JSON.stringify(report));
  const saved = await listEngineRuns(project);
  assert.equal(saved.length, questions.size);
  assert.equal(
    (await readdir(join(directory, 'recordings'))).length,
    questions.size,
    'Rechecks do not accumulate recordings',
  );
  assert.deepEqual(new Set(saved.map((r) => r.questions[0].text)), new Set(questions.keys()));
  assert(
    saved.some((r) => r.cache === 'recheck'),
    'Old diagnostic bodies are evicted',
  );
  assert(
    saved.some((r) => r.cache === 'retained'),
    'Recent checks fit in the bounded cache',
  );
  for (const run of saved) {
    const original = questions.get(run.questions[0].text);
    assert.deepEqual(run.caseSelection, original.run.caseSelection);
    if (run.cache === 'retained') {
      assert.deepEqual(await readEngineArtifact(project, run.inputRef), original.input);
      assert.deepEqual(await readEngineArtifact(project, run.resultRef), original.result);
      assert.deepEqual(await readSavedRecording(run.recording.path), original.recording);
    } else {
      assert(!run.inputRef && !run.resultRef, 'Evicted checks do not leave dangling artifact refs');
      await assert.rejects(readSavedRecording(run.recording.path), {
        code: 'RECORDING_CACHE_MISS',
      });
    }
  }
  assert.deepEqual(await readFile(project.path), authored);
  assert.deepEqual((await openProject(directory)).data, project.data);
  assert.equal(
    (await acquiredTexts(project, ['The technician checks the device.']))[0].status,
    'retained',
  );
  assert(!(await readdir(join(directory, 'engine'))).includes('objects'));
  const again = await compactEngineStorage(project, { force: true, budget });
  assert(again.after.bytes <= budget);
  assert.equal((await listEngineRuns(project)).length, questions.size);
  // A recording truncated by an older interrupted write does not block compaction.
  const truncated = join(directory, 'recordings', '1999-01-01T00-00-00-000Z-truncated.json');
  await writeFile(truncated, '{"schema":"tendora.workbench.recording","id":');
  const tolerant = await compactEngineStorage(project, { force: true, budget });
  assert.deepEqual(tolerant.unreadable, [truncated]);
  assert.equal(await readFile(truncated, 'utf8'), '{"schema":"tendora.workbench.recording","id":');
  assert.equal((await listEngineRuns(project)).length, questions.size);
  await rm(truncated);
  const victim = saved.find((r) => r.cache === 'recheck');
  const handle = await readFile(victim.recording.path);
  // Simulate interruption after database publication, before the old recording was rewritten.
  await writeFile(
    victim.recording.path,
    JSON.stringify(questions.get(victim.questions[0].text).recording),
  );
  await assert.rejects(readSavedRecording(victim.recording.path), { code: 'RECORDING_CACHE_MISS' });
  await writeFile(victim.recording.path, handle);
  const abandoned = join(directory, 'engine', `.${randomUUID()}.sqlite`);
  await writeFile(abandoned, 'unfinished staging database');
  await compactEngineStorage(project, { force: true, budget });
  await assert.rejects(stat(abandoned), { code: 'ENOENT' });

  const parent = saved.find((r) => r.cache === 'retained');
  await mkdir(join(directory, '.continuations'));
  await writeFile(
    join(directory, '.continuations', 'draft.json'),
    JSON.stringify({ parent: { path: parent.recording.path } }),
  );
  const beforeRefusal = await readFile(artifactDatabasePath(project));
  await assert.rejects(
    compactEngineStorage(project, { force: true, budget: 16 * 1024 }),
    /nothing was removed/u,
  );
  assert.deepEqual(
    await readFile(artifactDatabasePath(project)),
    beforeRefusal,
    'A pinned contribution is never silently discarded to meet a budget',
  );
  // The project's own bound is soft: what cannot be released is kept, and maintenance
  // reports it instead of failing.
  const soft = await compactProjectStorage(project, {
    force: true,
    target: 16 * 1024,
    cacheBudget: 16 * 1024,
  });
  assert.equal(soft.engine.kept, true, JSON.stringify(soft.engine));
  assert.match(soft.engine.reason, /nothing was removed/u);
  assert.equal(soft.withinTarget, false);
  assert.deepEqual(await readFile(artifactDatabasePath(project)), beforeRefusal);
  await compactEngineStorage(project, { force: true, budget });
  assert.deepEqual(
    await readSavedRecording(parent.recording.path),
    questions.get(parent.questions[0].text).recording,
  );
  const alias = join(directory, 'recordings', 'parent-alias.json');
  const aliasBody = { ...questions.get(parent.questions[0].text).recording, alias: true };
  await writeFile(alias, JSON.stringify(aliasBody));
  await writeFile(
    join(directory, '.continuations', 'alias.json'),
    JSON.stringify({ parent: { path: alias } }),
  );
  await compactEngineStorage(project, { force: true, budget });
  assert.deepEqual(
    await readSavedRecording(alias),
    aliasBody,
    'Two retained recordings of one run keep their own identities',
  );
  assert.equal((await readSavedRecording(parent.recording.path)).alias, undefined);
  await deleteEngineRuns(project, { ids: [victim.id] });
  await assert.rejects(readEngineRun(project, victim.id), { code: 'ENOENT' });
  assert.equal((await listEngineRuns(project)).length, questions.size - 1);
  await deleteEngineRuns(project, { ids: [parent.id] });
  assert.equal(
    (await acquiredTexts(project, ['The technician checks the device.']))[0].status,
    'retained',
    'Deleting the last full check must not delete source AMRs still needed by evicted questions',
  );
  assert.equal(
    (await acquiredTexts(project, ['An inspection is due.']))[0].status,
    'retained',
    'A shared independent case remains acquired for the other saved questions',
  );

  const integrity = await putEngineArtifact(project, { check: 'Integrity', body: source });
  const db = openArtifactDatabase(artifactDatabasePath(project));
  db.prepare('UPDATE fragments SET payload = ? WHERE hash = ?').run(
    Buffer.from('broken'),
    integrity,
  );
  assert.throws(() => loadArtifact(db, integrity));
  db.close();

  const totalRoot = join(directory, 'whole-project');
  const totalProject = await createProject(totalRoot, 'Whole project storage');
  const material = {
    values: Array.from({ length: 4000 }, (_, i) =>
      createHash('sha256').update(`material-${i}`).digest('hex'),
    ),
  };
  const materialRef = await writeObject(totalRoot, 'records', material);
  const diagnostic = {
    values: Array.from({ length: 6000 }, (_, i) =>
      createHash('sha256').update(`diagnostic-${i}`).digest('hex'),
    ),
  };
  const totalRun = {
    version: 1,
    id: randomUUID(),
    projectId: totalProject.data.id,
    projectDigest: totalProject.digest,
    scopePlacementId: totalProject.data.placements[0].id,
    purpose: 'inquiry',
    profile: 'storage-contract',
    status: 'open',
    startedAt: new Date().toISOString(),
    questions: [{ text: 'What remains unresolved?' }],
    inputRef: await putEngineArtifact(totalProject, {
      question: { text: 'What remains unresolved?' },
    }),
    resultRef: await putEngineArtifact(totalProject, diagnostic),
    calls: [],
    stages: [],
  };
  await saveEngineRun(totalProject, totalRun);
  const totalReport = await compactProjectStorage(totalProject, {
    force: true,
    target,
    cacheBudget: budget,
  });
  assert(totalReport.before.allocated > target);
  assert(totalReport.withinTarget, JSON.stringify(totalReport));
  assert.equal((await readEngineRun(totalProject, totalRun.id)).cache, 'recheck');
  assert.deepEqual(await readObject(totalRoot, 'records', materialRef), material);
  assert.equal((await listEngineRuns(totalProject)).length, 1);
  const larger = {
    values: Array.from({ length: 14000 }, (_, i) =>
      createHash('sha256').update(`new material-${i}`).digest('hex'),
    ),
  };
  const largerRef = await writeObject(totalRoot, 'records', larger);
  const largerReport = await compactProjectStorage(totalProject, {
    force: true,
    target,
    cacheBudget: budget,
  });
  assert.equal(
    largerReport.withinTarget,
    false,
    'A storage target must never discard authored data',
  );
  assert.deepEqual(await readObject(totalRoot, 'records', largerRef), larger);
  assert.equal((await listEngineRuns(totalProject)).length, 1);
  // An unchanged grammar refreshes only its recency; without an entry it is written.
  const grammarContext = ['grammar-cache-test', null];
  const first = { profile: 'test', grammars: [{ signature: 'a' }] };
  await writeGrammarCache(totalProject, ['fresh', null], first, { unchanged: true });
  assert.deepEqual(await readGrammarCache(totalProject, ['fresh', null]), first);
  await writeGrammarCache(totalProject, grammarContext, first);
  const recency = async () =>
    (await listGrammarCaches(totalProject)).find(
      (entry) =>
        entry.key === createHash('sha256').update(JSON.stringify(grammarContext)).digest('hex'),
    ).updated;
  const before = await recency();
  await new Promise((done) => setTimeout(done, 5));
  await writeGrammarCache(totalProject, grammarContext, first, { unchanged: true });
  assert((await recency()) > before, 'An unchanged grammar stays recently used');
  assert.deepEqual(await readGrammarCache(totalProject, grammarContext), first);
  const second = { profile: 'test', grammars: [{ signature: 'b' }] };
  await writeGrammarCache(totalProject, grammarContext, second);
  assert.deepEqual(await readGrammarCache(totalProject, grammarContext), second);
  // Kept in the process by reference: read again without loading, unchanged by
  // corpora the caller adds later, and loaded again when another process
  // points the entry at other grammars.
  second.grammars.push({ signature: 'c' });
  const kept = await readGrammarCache(totalProject, grammarContext);
  assert.deepEqual(kept, { profile: 'test', grammars: [{ signature: 'b' }] });
  assert.equal(await readGrammarCache(totalProject, grammarContext), kept, 'Not loaded again');
  const other = openArtifactDatabase(artifactDatabasePath(totalProject));
  try {
    const ref = storeArtifact(other, { profile: 'test', grammars: [{ signature: 'd' }] });
    other
      .prepare('UPDATE grammars SET ref = ? WHERE key = ?')
      .run(ref, createHash('sha256').update(JSON.stringify(grammarContext)).digest('hex'));
  } finally {
    other.close();
  }
  assert.deepEqual(await readGrammarCache(totalProject, grammarContext), {
    profile: 'test',
    grammars: [{ signature: 'd' }],
  });
  console.log(
    `ok shared fragments, unchanged hashes, legacy read, bounded cache (${report.after.bytes} bytes), whole-project budget, durable questions/cases, active-run exclusion, repeat compaction, deletion and corruption`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
