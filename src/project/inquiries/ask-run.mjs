/** CLI inquiries submit through saved pilot Asks and retain the same run lineage. */
import { captureProjectInquiry } from './inquiry.mjs';
import {
  listInvestigations,
  saveInvestigation,
  newInvestigation,
  addAsk,
  currentAsk,
} from './investigation.mjs';
import { interpretationRevision } from '../../recording/revisions.mjs';

export async function requestProjectInquiry(
  project,
  { scopePlacementId, question, caseSelection = null, progress, signal, ...options },
) {
  const caseKey = (selection) =>
    JSON.stringify([selection?.placementId, selection?.sources.map((source) => source.textDigest)]);
  let saved = (await listInvestigations(project)).find((entry) =>
    entry.data.asks.some(
      (ask) =>
        ask.question === question &&
        ask.scopePlacementId === scopePlacementId &&
        caseKey(ask.caseSelection) === caseKey(caseSelection),
    ),
  );
  let data = saved ? structuredClone(saved.data) : newInvestigation(project, question);
  const existing = data.asks.find(
    (ask) =>
      ask.question === question &&
      ask.scopePlacementId === scopePlacementId &&
      caseKey(ask.caseSelection) === caseKey(caseSelection),
  );
  if (existing) data.activeAskId = existing.id;
  else data = addAsk(data, { question, scopePlacementId, caseSelection, origin: { kind: 'cli' } });
  const ask = currentAsk(data);
  ask.caseSelection = structuredClone(caseSelection);
  ask.revision++;
  ask.status = 'running';
  saved = await saveInvestigation(project, data, saved?.digest ?? null);
  const link = {
    investigationId: data.id,
    askId: ask.id,
    revision: ask.revision,
    intention: structuredClone(data.intentions.find((item) => item.id === ask.intentionId)),
    question,
    origin: ask.origin,
  };
  try {
    const result = await captureProjectInquiry(
      project,
      scopePlacementId,
      question,
      progress,
      signal,
      { ...options, caseSelection, ask: link },
    );
    const next = structuredClone(saved.data),
      completed = currentAsk(next);
    completed.status = 'complete';
    completed.runs.push({
      path: result.path,
      recordingRevision: interpretationRevision(result.recording),
      revision: ask.revision,
      intentionId: ask.intentionId,
      question,
      scopePlacementId,
      projectDigest: project.digest,
      caseSelection,
      ...(result.recording.reasoning ? { engineRunId: result.recording.reasoning.runId } : {}),
    });
    await saveInvestigation(project, next, saved.digest);
    return result;
  } catch (error) {
    const next = structuredClone(saved.data),
      failed = currentAsk(next);
    failed.status = 'draft';
    failed.lastFailure = error.message;
    if (error.engineRunId) failed.lastEngineRunId = error.engineRunId;
    await saveInvestigation(project, next, saved.digest);
    throw error;
  }
}
