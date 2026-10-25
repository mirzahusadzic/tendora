/** Questions are durable. Completed checks are a bounded, reconstructible cache. */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  artifactDatabasePath,
  openArtifactDatabase,
  storeArtifact,
  copyArtifact,
  restoreArtifact,
  openStoredArtifacts,
  loadArtifact,
  storeRun,
  pruneArtifacts,
} from '../storage/engine-artifacts.mjs';
import {
  activeEngineRunIds,
  engineDeletionLockPath,
  listEngineRuns,
  putEngineArtifact,
  readEngineArtifact,
} from '../storage/engine-runs.mjs';
import { withFileLease } from '../storage/locks.mjs';
import { interpretationRevision } from '../../recording/revisions.mjs';
import { listGrammarCaches } from '../storage/grammar.mjs';
import { listDataFiles, readDataFile } from '../storage/data-files.mjs';
import { recordingHandle } from './recordings.mjs';

// A soft cache bound, not a stop: recomputing a check costs far more than
// keeping it, so completed checks and grammar caches are kept generously.
export const engineStorageBudget = 256 * 1024 * 1024;
const questionPurposes = new Set(['inquiry', 'question-refresh', 'contribution-assessment']);
const artifactRefs = (run) =>
  [
    run.inputRef,
    run.sourceInputRef,
    run.resultRef,
    run.errorRef,
    ...(run.calls ?? []).flatMap((call) => [call.requestRef, call.responseRef, call.errorRef]),
  ].filter(Boolean);
const questionKey = (run) =>
  JSON.stringify([
    run.scopePlacementId,
    run.questions?.map((q) => q.text.trim()),
    run.caseSelection?.placementId ?? run.case ?? null,
  ]);
async function files(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function size(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}
async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
const databaseBytes = (db) =>
  db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;

function questionRecord(run) {
  const keep = [
    'version',
    'id',
    'projectId',
    'projectDigest',
    'scopePlacementId',
    'profile',
    'startedAt',
    'finishedAt',
    'purpose',
    'actor',
    'via',
    'questions',
    'case',
    'caseSelection',
    'ask',
    'recording',
    'provenance',
    'elapsedMs',
    'error',
  ];
  return {
    ...Object.fromEntries(
      keep.filter((key) => run[key] !== undefined).map((key) => [key, run[key]]),
    ),
    ...(run.recording ? { recording: { ...run.recording, artifactRef: undefined } } : {}),
    status: run.status,
    // What the released check found, so a saved question can be shown without
    // checking it again.
    ...(run.answer || run.lastAnswer ? { lastAnswer: lastAnswer(run) } : {}),
    calls: [],
    stages: [],
    openings: [],
    candidates: [],
    cache: 'recheck',
  };
}
// It keeps the statements each answer rests on, by id and text, so an exported
// answer still names them and their provenance (review 2026-10-25, #4).
const lastAnswer = (run) => {
  if (run.lastAnswer) return run.lastAnswer;
  const answers = run.answer.answers.map(
    ({ text, conditional, qualifications, readAs, sourceIds = [] }) => ({
      text,
      ...(conditional ? { conditional, qualifications } : {}),
      ...(readAs ? { readAs } : {}),
      sourceIds,
    }),
  );
  const cited = new Set(answers.flatMap((answer) => answer.sourceIds));
  return {
    status: run.answer.status,
    answers,
    sources: (run.answer.sources ?? [])
      .filter((source) => cited.has(source.id))
      .map(({ id, text, kind }) => ({ id, text, ...(kind ? { kind } : {}) })),
  };
};

export async function engineStorageUsage(project) {
  const root = dirname(project.path);
  let total = 0,
    count = 0;
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        total += await size(child);
        count++;
      }
    }
  }
  await visit(join(root, 'engine'));
  return { bytes: total, files: count };
}

/** Whole recordings written before checks kept them as engine artifacts become
 * handles. Nothing is evicted; lists stop parsing whole recordings. */
export async function retainRecordings(project, { dryRun = false } = {}) {
  const directory = join(dirname(project.path), 'recordings');
  const names = (await files(directory)).filter(
    (file) => file.endsWith('.json') && !file.startsWith('.'),
  );
  if (!names.length) return { retained: 0 };
  return withFileLease(engineDeletionLockPath(project), async () => {
    let retained = 0;
    for (const file of names) {
      const path = join(directory, file);
      let recording;
      try {
        recording = await json(path);
      } catch (error) {
        // An interrupted older write is left for compaction to report.
        if (error instanceof SyntaxError || error.code === 'ENOENT') continue;
        throw error;
      }
      if (
        recording?.schema !== 'tendora.workbench.recording' ||
        recording.artifactRef ||
        recording.cache
      )
        continue;
      retained++;
      if (dryRun) continue;
      const ref = await putEngineArtifact(project, recording);
      const staged = `${path}.${randomUUID()}.tmp`;
      await writeFile(staged, JSON.stringify(recordingHandle(recording, ref)) + '\n', {
        flag: 'wx',
      });
      await rename(staged, path);
    }
    return { retained };
  });
}

export async function compactEngineStorage(
  project,
  { force = false, budget = engineStorageBudget, dryRun = false } = {},
) {
  const root = dirname(project.path),
    engine = join(root, 'engine');
  const recordingDirectory = join(root, 'recordings');
  let recordingBytes = 0;
  for (const file of await files(recordingDirectory))
    if (file.endsWith('.json'))
      recordingBytes += Math.ceil((await size(join(recordingDirectory, file))) / 4096) * 4096;
  const legacy =
    (await files(join(engine, 'runs'))).length > 0 ||
    (await files(join(engine, 'objects'))).length > 0;
  if (!force && !legacy && (await engineStorageUsage(project)).bytes + recordingBytes <= budget)
    return { changed: false };
  await mkdir(engine, { recursive: true });
  return withFileLease(engineDeletionLockPath(project), async () => {
    if ((await activeEngineRunIds(project)).length) return { changed: false, busy: true };
    const runs = await listEngineRuns(project);
    if (runs.some((run) => run.status === 'running')) return { changed: false, busy: true };
    // A killed maintenance process may leave only its unpublished staging database.
    if (!dryRun)
      for (const file of await files(engine))
        if (/^\.[a-f0-9-]{36}\.sqlite(?:-journal)?$/u.test(file))
          await rm(join(engine, file), { force: true });
    const before = await engineStorageUsage(project);
    const byId = new Map(runs.map((run) => [run.id, run]));
    const latest = new Map(),
      protectedRuns = new Set(),
      requiredRecordings = new Set();
    const recordings = [],
      unreadable = [];
    for (const file of await files(recordingDirectory)) {
      if (!file.endsWith('.json') || file.startsWith('._')) continue;
      const path = join(recordingDirectory, file);
      let header;
      try {
        header = await json(path);
      } catch (error) {
        // An interrupted older write cannot block compaction of every other question.
        // It is left in place, unreferenced and unchanged, for the author to inspect.
        if (!(error instanceof SyntaxError)) throw error;
        unreadable.push(path);
        continue;
      }
      if (header?.schema !== 'tendora.workbench.recording') continue;
      recordings.push({ path, header });
      if (!header.reasoning?.runId) requiredRecordings.add(path);
      if (header.continuation?.parent?.path)
        requiredRecordings.add(header.continuation.parent.path);
    }
    if (!before.bytes && !recordings.length)
      return {
        changed: false,
        before,
        after: before,
        plannedBytes: 0,
        handleBytes: 0,
        questions: 0,
        runs: 0,
        cached: 0,
        unreadable,
      };
    const recordingPaths = new Set(recordings.map((record) => record.path));
    // An authored continuation must retain its original parent, even if it is not the latest check.
    function references(value, pinRecording = true) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (['engineRunId', 'runId', 'lastEngineRunId'].includes(key) && typeof child === 'string')
          protectedRuns.add(child);
        if (
          pinRecording &&
          ['path', 'parentPath', 'recordingPath'].includes(key) &&
          recordingPaths.has(child)
        )
          requiredRecordings.add(child);
        // An Ask's previous checks are regenerable; its authored origin is evidence.
        references(child, pinRecording && key !== 'runs');
      }
    }
    references(project.data);
    for (const file of await listDataFiles(root, 'investigations'))
      if (file.endsWith('.json'))
        references(JSON.parse(await readDataFile(root, join(root, 'investigations', file))));
    for (const file of await files(join(root, '.continuations'))) {
      if (!file.endsWith('.json')) continue;
      const draft = await json(join(root, '.continuations', file));
      if (draft.parent?.path) requiredRecordings.add(draft.parent.path);
    }
    for (const file of await files(join(recordingDirectory, '.evaluations')))
      if (file.endsWith('.json'))
        references(await json(join(recordingDirectory, '.evaluations', file)));
    for (const record of recordings) {
      const revision = record.header.retainedRevision ?? interpretationRevision(record.header);
      if ((await files(join(recordingDirectory, '.interpretations', revision))).length)
        requiredRecordings.add(record.path);
      if (requiredRecordings.has(record.path) && record.header.reasoning?.runId)
        protectedRuns.add(record.header.reasoning.runId);
    }
    for (const run of runs) {
      if (!questionPurposes.has(run.purpose ?? 'inquiry')) continue;
      if (run.caseSelection === undefined && run.case && run.inputRef)
        run.caseSelection = (await readEngineArtifact(project, run.inputRef)).caseSelection;
      const key = questionKey(run);
      if (!latest.has(key)) latest.set(key, run);
    }
    const kept = new Map([...latest.values()].map((run) => [run.id, run]));
    for (const id of protectedRuns) if (byId.has(id)) kept.set(id, byId.get(id));
    // Reserve space for the small handles too; moving a dump out of engine/ is not a saving.
    const handleBytes = recordings
      .filter((r) => requiredRecordings.has(r.path) || kept.has(r.header.reasoning?.runId))
      .reduce(
        (sum, r) =>
          sum +
          Math.ceil(
            Buffer.byteLength(JSON.stringify(recordingHandle(r.header, 'f'.repeat(64))) + '\n') /
              4096,
          ) *
            4096,
        0,
      );
    const cacheBudget = budget - handleBytes;
    const temporary = join(engine, `.${randomUUID()}.sqlite`);
    const db = openArtifactDatabase(temporary);
    let stored = await openStoredArtifacts(project);
    const retained = new Set(),
      cached = new Set(),
      headers = [],
      obsolete = [];
    const summary = (run) => {
      const record = recordings.find(
        (r) =>
          r.header.reasoning?.runId === run.id &&
          r.requiredRef &&
          (!run.recording?.path || r.path === run.recording.path),
      );
      const saved = questionRecord(run);
      if (record)
        saved.recording = {
          ...saved.recording,
          path: record.path,
          id: record.header.id,
          artifactRef: record.requiredRef,
        };
      return saved;
    };
    let published = false,
      closed = false;
    try {
      for (const run of kept.values()) {
        let caseSelection = run.caseSelection;
        if (caseSelection === undefined && run.case && run.inputRef) {
          const input = await readEngineArtifact(project, run.inputRef);
          caseSelection = input.caseSelection;
        }
        run.caseSelection = caseSelection ?? null;
        storeRun(db, summary(run));
      }
      // Stored artifacts are copied as they are: names, bytes and shared parts
      // stay, whichever format named them, so the records that refer to them by
      // name still resolve. One of the older layout is stored under its name.
      const keep = async (ref) =>
        copyArtifact(stored, db, ref)
          ? ref
          : restoreArtifact(db, ref, await readEngineArtifact(project, ref));
      const keepRecording = ({ header }) =>
        header.artifactRef
          ? keep(header.artifactRef)
          : header.cache === 'recheck'
            ? null
            : storeArtifact(db, header);
      for (const record of recordings) {
        if (!requiredRecordings.has(record.path)) continue;
        const ref = await keepRecording(record);
        if (!ref) throw new Error('A continuation parent is unavailable; storage was not changed.');
        retained.add(ref);
        record.requiredRef = ref;
        const run = kept.get(record.header.reasoning?.runId);
        if (run) storeRun(db, summary(run));
      }
      if (databaseBytes(db) > cacheBudget)
        throw Object.assign(
          new Error(
            'Durable questions and continuation evidence exceed the cache budget; nothing was removed.',
          ),
          { code: 'ENGINE_STORAGE_REQUIRED' },
        );
      // Keep reusable corpus compilation ahead of old question diagnostics.
      for (const entry of await listGrammarCaches(project)) {
        const ref = entry.ref ? await keep(entry.ref) : storeArtifact(db, await json(entry.path));
        if (databaseBytes(db) <= cacheBudget / 2) {
          retained.add(ref);
          db.prepare('INSERT INTO grammars VALUES (?, ?, ?)').run(entry.key, ref, entry.updated);
        } else pruneArtifacts(db, retained);
      }
      for (const run of [...kept.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
        if (!run.inputRef || !run.resultRef) continue;
        const group = new Set();
        try {
          for (const ref of artifactRefs(run)) group.add(await keep(ref));
          for (const record of recordings.filter((r) => r.header.reasoning?.runId === run.id)) {
            const ref = await keepRecording(record);
            if (ref) group.add((record.proposedRef = ref));
          }
          const recording =
            recordings.find((r) => r.path === run.recording?.path) ??
            recordings.find((r) => r.header.reasoning?.runId === run.id);
          storeRun(db, {
            ...run,
            cache: 'retained',
            ...(recording?.proposedRef
              ? {
                  recording: {
                    ...run.recording,
                    path: recording.path,
                    id: recording.header.id,
                    artifactRef: recording.proposedRef,
                  },
                }
              : {}),
          });
          if (databaseBytes(db) <= cacheBudget) {
            for (const ref of group) retained.add(ref);
            cached.add(run.id);
          } else {
            storeRun(db, summary(run));
            pruneArtifacts(db, retained);
          }
        } catch (error) {
          // A prior bounded check may already have been evicted. Corruption is never ignored.
          if (error.code !== 'ENOENT') throw error;
          storeRun(db, summary(run));
          pruneArtifacts(db, retained);
        }
      }
      for (const record of recordings) {
        if (!requiredRecordings.has(record.path) && !kept.has(record.header.reasoning?.runId)) {
          obsolete.push(record.path);
          continue;
        }
        const h = record.header;
        const ref =
          record.requiredRef ?? (cached.has(h.reasoning?.runId) ? record.proposedRef : null);
        headers.push({
          path: record.path,
          value: recordingHandle(h, ref),
        });
      }
      pruneArtifacts(db, retained);
      for (const ref of retained) loadArtifact(db, ref);
      if (databaseBytes(db) > cacheBudget)
        throw new Error('Engine storage exceeds its budget; nothing was removed.');
      if (dryRun)
        return {
          changed: false,
          before,
          plannedBytes: databaseBytes(db),
          handleBytes,
          questions: latest.size,
          runs: kept.size,
          cached: cached.size,
          protectedRecordings: requiredRecordings.size,
          unreadable,
        };
      stored?.close();
      stored = null;
      db.close();
      closed = true;
      await rename(temporary, artifactDatabasePath(project));
      published = true;
      for (const { path, value } of headers) {
        const staged = `${path}.${randomUUID()}.tmp`;
        await writeFile(staged, JSON.stringify(value) + '\n', { flag: 'wx' });
        await rename(staged, path);
      }
      for (const path of obsolete) await rm(path, { force: true });
      // Authored records and acquisitions are not part of engine storage.
      for (const area of ['objects', 'runs', 'grammars', 'experiments'])
        await rm(join(engine, area), { recursive: true, force: true });
      return {
        changed: true,
        before,
        after: await engineStorageUsage(project),
        handleBytes,
        questions: latest.size,
        runs: kept.size,
        cached: cached.size,
        unreadable,
      };
    } finally {
      stored?.close();
      if (!closed) db.close();
      if (!published) await rm(temporary, { force: true });
    }
  });
}
