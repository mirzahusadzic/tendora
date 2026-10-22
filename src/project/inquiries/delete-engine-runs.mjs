/** Remove saved assessments, or a whole question and its owned contributions. */
import { readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  activeEngineRunIds,
  engineDeletionLockPath,
  listEngineRuns,
  readEngineArtifact,
} from '../storage/engine-runs.mjs';
import { readAcquisitions, withAcquisitionIndexLease } from '../storage/acquisitions.mjs';
import { acquireFileLease } from '../storage/locks.mjs';
import { listProjectRecordings } from './recordings.mjs';
import { listInvestigations, saveInvestigation } from './investigation.mjs';
import { interpretationRevision } from '../../recording/revisions.mjs';
import { openProject, saveProject } from '../authoring/project.mjs';
import { removeContribution } from '../authoring/development.mjs';
import { sourceCatalog } from '../authoring/sources.mjs';
import {
  listDataFiles,
  removeDataFile,
  removeDataArea,
  writeDataFile,
} from '../storage/data-files.mjs';
import { readSavedRecording } from '../storage/recordings.mjs';
import {
  artifactDatabasePath,
  openArtifactDatabase,
  pruneArtifacts,
} from '../storage/engine-artifacts.mjs';

const textDigest = (text) => createHash('sha256').update(text).digest('hex');
const entries = (input) =>
  input.entries ?? [
    ...(input.sources ?? []),
    ...(input.cases ?? []),
    ...(input.question ? [input.question] : []),
  ];
const engineRefs = (run) =>
  [
    run.inputRef,
    run.sourceInputRef,
    run.resultRef,
    run.errorRef,
    ...(run.calls ?? []).flatMap((call) => [call.requestRef, call.responseRef, call.errorRef]),
  ].filter(Boolean);
async function files(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function emptyDirectory(directory) {
  await rmdir(directory).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  });
}
async function pruneObjects(directory, retained, projectRoot = null) {
  const area = projectRoot ? 'acquisitions/objects' : null;
  for (const file of projectRoot
    ? await listDataFiles(projectRoot, area)
    : await files(directory)) {
    if (/^[a-f0-9]{64}\.json$/u.test(file) && !retained.has(file.slice(0, -5)))
      if (projectRoot) await removeDataFile(projectRoot, join(directory, file));
      else await rm(join(directory, file), { force: true });
  }
  await emptyDirectory(directory);
}
async function writeIndex(path, value, projectRoot) {
  return writeDataFile(projectRoot, path, JSON.stringify(value, null, 2) + '\n');
}

export async function deleteEngineRuns(project, { ids = [], all = false } = {}) {
  if (!all && (!ids.length || ids.some((id) => !/^[a-f0-9-]{36}$/u.test(id))))
    throw new Error('Choose an engine run to delete.');
  return deleteEngineData(project, { ids, all });
}

export async function deleteQuestion(project, question, { persist = saveProject } = {}) {
  if (
    !question?.text?.trim() ||
    !project.data.placements.some((p) => p.id === question.scopePlacementId)
  )
    throw new Error('Choose a question to delete.');
  return deleteEngineData(project, { question, persist });
}

const questionTexts = (c) =>
  [c.question, ...(c.questionHistory ?? []), ...c.wordings].map((p) => p?.text).filter(Boolean);

async function deleteEngineData(project, { ids = [], all = false, question = null, persist }) {
  const directory = dirname(project.path),
    lockPath = engineDeletionLockPath(project);
  const release = await acquireFileLease(lockPath, {
    busyMessage: 'Engine data is being deleted elsewhere.',
  });
  try {
    if ((await activeEngineRunIds(project)).length)
      throw new Error('Wait for the running engine or cancel it before deleting engine data.');
    const runs = await listEngineRuns(project);
    if (runs.some((run) => run.status === 'running'))
      throw new Error('Wait for the running engine or cancel it before deleting engine data.');
    let forgetQuestion = () => false;
    if (question) {
      const current = await openProject(directory);
      if (current.digest !== project.digest)
        throw new Error('Project changed. Reload before deleting the question.');
      const c = question.contributionId
        ? project.data.contributions?.find((c) => c.id === question.contributionId)
        : null;
      if (
        question.contributionId &&
        (!c?.question || c.scopePlacementId !== question.scopePlacementId)
      )
        throw new Error('Question is no longer available.');
      const texts = new Set((c ? questionTexts(c) : [question.text]).map((text) => text.trim()));
      const data = c ? removeContribution(project.data, c.id) : project.data;
      // A second authored contribution may still own the same scoped question.
      const shared = new Set(
        (data.contributions ?? [])
          .filter((other) => other.scopePlacementId === question.scopePlacementId)
          .flatMap(questionTexts)
          .map((text) => text.trim()),
      );
      forgetQuestion = (scope, text) =>
        scope === question.scopePlacementId &&
        typeof text === 'string' &&
        texts.has(text.trim()) &&
        !shared.has(text.trim());
      ids = runs
        .filter((run) => forgetQuestion(run.scopePlacementId, run.questions?.[0]?.text))
        .map((run) => run.id);
      if (c) project = await persist(project, data);
    }
    const selected = all
      ? runs
      : ids.map((id) => {
          const run = runs.find((run) => run.id === id);
          if (!run) throw new Error('Engine run is no longer available.');
          return run;
        });
    const removed = new Set(selected.map((run) => run.id));
    const corpusTexts = new Set(
      (project.data.contributions ?? []).flatMap((c) =>
        [c.question, ...(c.questionHistory ?? []), ...c.responses, ...c.wordings]
          .map((r) => r?.acquisition?.text)
          .filter(Boolean)
          .map(textDigest),
      ),
    );
    if (all) {
      for (const area of ['engine', 'recordings', '.continuations'])
        await rm(join(directory, area), { recursive: true, force: true });
      await removeDataArea(directory, 'investigations');
      await withAcquisitionIndexLease(project, async () => {
        const acquisitions = await readAcquisitions(project);
        if (acquisitions && corpusTexts.size) {
          acquisitions.entries = Object.fromEntries(
            Object.entries(acquisitions.entries).filter(([key]) => corpusTexts.has(key)),
          );
          await writeIndex(join(directory, 'acquisitions', 'index.json'), acquisitions, directory);
          await pruneObjects(
            join(directory, 'acquisitions', 'objects'),
            new Set(Object.values(acquisitions.entries)),
            directory,
          );
        } else await removeDataArea(directory, 'acquisitions');
      });
      return { deleted: [...removed], reset: true };
    }
    const remaining = runs.filter((run) => !removed.has(run.id));
    const recordings = await Promise.all(
      (await listProjectRecordings(project)).map(async (entry) => ({
        ...entry,
        artifactRef: JSON.parse(await readFile(entry.path, 'utf8')).artifactRef,
        data: await readSavedRecording(entry.path, { allowHeader: true }),
      })),
    );
    const deletedRecordings = recordings.filter((record) =>
      removed.has(record.data.reasoning?.runId),
    );
    const keptRecordings = recordings.filter((record) => !deletedRecordings.includes(record));
    const paths = new Set(deletedRecordings.map((record) => record.path));
    const referencesRemoved = (value) =>
      value &&
      typeof value === 'object' &&
      Object.entries(value).some(
        ([key, item]) =>
          (['path', 'recordingPath', 'parentPath'].includes(key) && paths.has(item)) ||
          (['engineRunId', 'runId', 'lastEngineRunId'].includes(key) && removed.has(item)) ||
          (typeof item === 'object' && referencesRemoved(item)),
      );
    const retainedTexts = new Set([
        ...corpusTexts,
        ...sourceCatalog(project.data).map((source) => textDigest(source.text)),
      ]),
      deletedTexts = new Set();
    for (const run of runs) {
      if (!run.inputRef) {
        for (const entry of [...(run.questions ?? []), ...(run.caseSelection?.sources ?? [])])
          (removed.has(run.id) ? deletedTexts : retainedTexts).add(textDigest(entry.text));
        continue;
      }
      const input = await readEngineArtifact(project, run.inputRef);
      for (const entry of entries(input)) {
        if (entry.text)
          (removed.has(run.id) ? deletedTexts : retainedTexts).add(textDigest(entry.text));
      }
    }
    for (const record of keptRecordings)
      for (const text of [
        ...(record.data.sources ?? []).map((source) => source.text),
        record.data.inquiry.text,
      ])
        retainedTexts.add(textDigest(text));

    for (const investigation of await listInvestigations(project)) {
      const data = structuredClone(investigation.data);
      data.asks = data.asks.filter((ask) => !forgetQuestion(ask.scopePlacementId, ask.question));
      if (data.asks.length !== investigation.data.asks.length) {
        if (!data.asks.length) {
          await removeDataFile(directory, investigation.path);
          continue;
        }
        if (!data.asks.some((ask) => ask.id === data.activeAskId))
          data.activeAskId = data.asks.at(-1).id;
      }
      for (const ask of data.asks) {
        const before = ask.runs.length;
        ask.runs = ask.runs.filter((run) => !referencesRemoved(run));
        const failed = removed.has(ask.lastEngineRunId);
        if (failed) {
          delete ask.lastEngineRunId;
          delete ask.lastFailure;
        }
        if ((before !== ask.runs.length || failed) && !ask.runs.length) {
          ask.status = 'draft';
          if (ask.caseSelection) ask.caseSelection.binding = null;
        }
        if (referencesRemoved(ask.origin)) ask.origin = null;
        if (referencesRemoved(ask.continuation)) ask.continuation = null;
      }
      for (const intention of data.intentions)
        if (referencesRemoved(intention.origin)) delete intention.origin;
      const retainedAssessments = new Set();
      data.assessments = data.assessments.filter((item) => {
        if (
          referencesRemoved(item) ||
          (item.action === 'revoked' && !retainedAssessments.has(item.origin.assessmentId))
        )
          return false;
        retainedAssessments.add(item.id);
        return true;
      });
      if (JSON.stringify(data) !== JSON.stringify(investigation.data))
        await saveInvestigation(project, data, investigation.digest);
    }
    const retainedRevisions = new Set(
      keptRecordings.map(
        (record) => record.data.retainedRevision ?? interpretationRevision(record.data),
      ),
    );
    for (const record of deletedRecordings) {
      await rm(record.path, { force: true });
      const revision = record.data.retainedRevision ?? interpretationRevision(record.data);
      if (!retainedRevisions.has(revision))
        await rm(join(directory, 'recordings', '.interpretations', revision), {
          recursive: true,
          force: true,
        });
    }
    for (const area of [
      join(directory, 'recordings', '.evaluations'),
      join(directory, '.continuations'),
    ]) {
      for (const file of await files(area)) {
        if (!file.endsWith('.json')) continue;
        const value = JSON.parse(await readFile(join(area, file), 'utf8'));
        if (referencesRemoved(value)) await rm(join(area, file), { force: true });
      }
      await emptyDirectory(area);
    }
    for (const run of selected)
      await rm(join(directory, 'engine', 'runs', run.id), { recursive: true, force: true });
    try {
      await readFile(artifactDatabasePath(project));
      const db = openArtifactDatabase(artifactDatabasePath(project));
      try {
        const remove = db.prepare('DELETE FROM runs WHERE id = ?');
        for (const id of removed) remove.run(id);
        db.exec('DELETE FROM grammars');
        pruneArtifacts(
          db,
          new Set([
            ...remaining.flatMap(engineRefs),
            ...keptRecordings
              .flatMap((record) => [record.artifactRef, ...engineRefs(record.data.reasoning ?? {})])
              .filter(Boolean),
          ]),
        );
      } finally {
        db.close();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // A shared derived cache can contain material from a deleted run. Rebuild it
    // automatically on the next Ask instead of retaining that run's material.
    await rm(join(directory, 'engine', 'grammars'), { recursive: true, force: true });
    await pruneObjects(
      join(directory, 'engine', 'objects'),
      new Set([
        ...remaining.flatMap(engineRefs),
        ...keptRecordings.flatMap((record) => engineRefs(record.data.reasoning ?? {})),
      ]),
    );
    await withAcquisitionIndexLease(project, async () => {
      const acquisitions = await readAcquisitions(project);
      if (acquisitions) {
        const kept = {};
        for (const [key, ref] of Object.entries(acquisitions.entries)) {
          if (retainedTexts.has(key) || !deletedTexts.has(key)) kept[key] = ref;
        }
        if (Object.keys(kept).length) {
          await writeIndex(
            join(directory, 'acquisitions', 'index.json'),
            {
              ...acquisitions,
              entries: kept,
            },
            directory,
          );
          await pruneObjects(
            join(directory, 'acquisitions', 'objects'),
            new Set(Object.values(kept)),
            directory,
          );
        } else await removeDataArea(directory, 'acquisitions');
      }
    });
    for (const area of ['engine/runs', 'engine', 'recordings/.interpretations', 'recordings'])
      await emptyDirectory(join(directory, area));
    return {
      deleted: [...removed],
      recordings: [...paths],
      reset: false,
      ...(question ? { project } : {}),
    };
  } catch (error) {
    // Lease cleanup must not replace the deletion failure.
    await release().catch(() => {});
    throw error;
  } finally {
    await release();
  }
}
