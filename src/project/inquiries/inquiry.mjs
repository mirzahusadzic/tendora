/** Run the shared engine and retain its evidence in the existing Ask workspace. */
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCrossing } from '../../inquiry/cross-run.mjs';
import { validateContinuation } from '../../recording/continuation.mjs';
import { recordRun, validateRecording } from '../../recording/format.mjs';
import { selectCase, validateCase, textDigest } from './investigation.mjs';
import { knowledgeSnapshot } from '../authoring/knowledge.mjs';
import { sourceCatalog } from '../authoring/sources.mjs';

import { projectInquiryBranch } from './scope.mjs';
import { inputFromProject, retainedAcquisition } from '../../engine/input.mjs';
import { runEngine } from '../../engine/run.mjs';
import {
  readEngineArtifact,
  saveEngineRun,
  acquireEngineRunLease,
} from '../storage/engine-runs.mjs';
import { matchQuestionRoles } from './role-matching.mjs';
import { roleExplorationProfile } from '../../engine/role-exploration.mjs';
import { finalizedContinuationFrame } from './frame.mjs';

export function projectInquiryAsset(project, placementId, query) {
  const placement = project.data.placements.find((p) => p.id === placementId);
  const concept = project.data.concepts.find((c) => c.id === placement?.conceptId);
  const branch = projectInquiryBranch(project, placementId);
  if (typeof query !== 'string' || !query.trim()) throw new Error('Inquiry is required.');
  const children = new Map();
  for (const node of branch) {
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId).push(node.placementId);
  }
  const catalog = sourceCatalog(project.data).filter(
    (source) => source.development?.asserted !== false,
  );
  const local = new Map();
  for (const source of catalog) {
    if (!local.has(source.nodeId)) local.set(source.nodeId, []);
    local.get(source.nodeId).push(source);
  }
  return {
    revision: project.digest,
    query,
    start: placement.id,
    project: {
      path: project.path,
      id: project.data.id,
      digest: project.digest,
      placementId,
      conceptId: concept.id,
    },
    nodes: branch.map((node) => ({
      id: node.placementId,
      conceptId: node.conceptId,
      label: node.name,
      description: node.description,
      sourceRecords: local.get(node.placementId) ?? [],
      sentences: (local.get(node.placementId) ?? []).map((source) => source.text),
      crossings: children.get(node.placementId) ?? [],
    })),
  };
}

export function prepareProjectInquiry(
  project,
  placementId,
  query,
  { caseState = false, caseSelection = null, continuation = null, ask = null } = {},
) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('Inquiry is required.');
  if (continuation) {
    validateContinuation(continuation);
    if (
      continuation.parent.project.id !== project.data.id ||
      (continuation.version >= 2 && continuation.question !== query) ||
      (continuation.version >= 2 && continuation.scopePlacementId !== placementId) ||
      (continuation.version === 1 &&
        continuation.parent?.project?.placementId &&
        continuation.parent.project.placementId !== placementId)
    )
      throw new Error('Continuation inquiry scope mismatch');
  }
  const branch = projectInquiryBranch(project, placementId);
  const asset = projectInquiryAsset(project, placementId, query);
  if (ask) asset.ask = ask;
  if (caseSelection) {
    validateCase(caseSelection, project.data.id);
    let node = asset.nodes.find((item) => item.id === caseSelection.placementId);
    if (!node) {
      node = { id: caseSelection.placementId, label: caseSelection.label, crossings: [] };
      asset.nodes.push(node);
    }
    node.sentences = caseSelection.sources.map((source) => source.text);
    node.conceptId = caseSelection.conceptId;
    node.sourceRecords = caseSelection.sources.map(
      (source) =>
        sourceCatalog(project.data).find(
          (item) => item.nodeId === source.placementId && item.text === source.text,
        ) ?? { ...source, revision: source.sentenceRevision ?? source.textDigest },
    );
    const binding =
      caseSelection.binding?.questionDigest === textDigest(query) ? caseSelection.binding : null;
    asset.caseState = {
      policy: 'selected-context-v2',
      rootNodeId: caseSelection.placementId,
      selection: structuredClone(caseSelection),
      ...(binding ? { binding } : {}),
    };
  } else if (caseState) {
    if (!asset.nodes[0].sentences.length)
      throw new Error('Add case-state sentences to the selected concept first.');
    asset.caseState = { policy: 'ancestor-context-v1', rootNodeId: placementId };
  }
  return { asset, branch };
}

export async function captureProjectInquiry(
  project,
  placementId,
  query,
  progress,
  signal,
  options = {},
) {
  const release = await acquireEngineRunLease(project, randomUUID());
  try {
    return await captureInquiry(project, placementId, query, progress, signal, options);
  } finally {
    await release();
  }
}

async function captureInquiry(project, placementId, query, progress, signal, options = {}) {
  const { asset } = prepareProjectInquiry(project, placementId, query, options);
  const { continuation, ask } = options;
  const routing = await matchQuestionRoles(project, asset, {
    acquire: options.acquireMissing ?? true,
    embed: options.embedRoles,
    progress,
    signal,
  });
  const matches = new Map((routing.matches ?? []).map((m) => [m.nodeId, m]));
  const input = await inputFromProject(project, {
    scopePlacementId: placementId,
    question: query,
    ask,
    caseSelection:
      options.caseSelection ?? (options.caseState ? selectCase(project, placementId) : null),
  });
  input.exploration = {
    profile: roleExplorationProfile,
    rootNodeId: placementId,
    routing,
    nodes: asset.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      children: matches.get(node.id)?.children ?? node.crossings,
    })),
  };
  let stored = null;
  const engine = await runEngine(project, {
    input,
    onResult: (value) => (stored = value),
    acquireMissing: options.acquireMissing ?? true,
    signal,
    progress,
    clients: options.engineClients,
    bounds: options.engineBounds,
    trace: options.engineTrace ?? false,
    onUpdate(value) {
      options.onEngineUpdate?.(value);
      const stage = value.stages.at(-1),
        call = value.calls.at(-1);
      progress?.(
        (call?.status === 'running' ? call.client + ': ' : '') +
          (stage?.label ?? 'Engine') +
          ' (' +
          (value.elapsedMs / 1000).toFixed(1) +
          ' s)',
      );
    },
  });
  // The result as stored, without decoding it again.
  const reasoning =
    stored ?? (engine.resultRef ? await readEngineArtifact(project, engine.resultRef) : null);
  if (
    signal?.aborted ||
    ['failed', 'cancelled', 'stale'].includes(engine.status) ||
    !reasoning?.inputs.at(-1)?.graph
  ) {
    const error = new Error(
      engine.error ??
        reasoning?.openings
          .map((item) => (item.text ?? item.label ?? item.kind) + ': ' + item.reason)
          .join('; ') ??
        'Engine ' + engine.status,
    );
    error.engineRunId = engine.id;
    error.client = engine.calls.findLast((call) => call.status === 'failed')?.client;
    throw error;
  }
  const finalizedContinuation = continuation
    ? finalizedContinuationFrame(project, continuation, {
        reasoning,
        ask,
        engineProjectDigest: engine.projectDigest,
        scopePlacementId: placementId,
        caseSelection: options.caseSelection ?? null,
      })
    : null;
  return retainInquiryTraversal(project, engine, reasoning, asset, progress, signal, {
    ...options,
    ...(finalizedContinuation ? { continuation: finalizedContinuation } : {}),
    routing,
    acquireMissing: options.acquireMissing ?? true,
  });
}

/** Record the actual hierarchy walk over the very same frozen engine inputs. */
export async function retainInquiryTraversal(
  project,
  engine,
  reasoning,
  asset,
  progress,
  signal,
  options = {},
) {
  const release = await acquireEngineRunLease(project, randomUUID());
  try {
    return await retainTraversal(project, engine, reasoning, asset, progress, signal, options);
  } finally {
    await release();
  }
}

async function retainTraversal(
  project,
  engine,
  reasoning,
  asset,
  progress,
  signal,
  { ask, continuation, acquireMissing = false, embedRoles, routing: priorRouting } = {},
) {
  if (engine.projectDigest !== project.digest || asset.revision !== project.digest)
    throw new Error('The corpus changed before its question could be followed. Check again.');
  const query = asset.query;
  const routing =
    priorRouting ??
    reasoning.exploration?.routing ??
    (await matchQuestionRoles(project, asset, {
      acquire: acquireMissing,
      embed: embedRoles,
      progress,
      signal,
    }));
  const ranked = new Map((routing.matches ?? []).map((match) => [match.nodeId, match]));
  const inputIds = new Map(
    reasoning.inputs.map((source) => [
      JSON.stringify([source.placementId, source.sentenceId]),
      source.id,
    ]),
  );
  const routedAsset = {
    ...asset,
    nodes: asset.nodes.map((node) => ({
      ...node,
      sourceRecords: node.sourceRecords?.map((source) => ({
        ...source,
        engineSourceId: inputIds.get(JSON.stringify([node.id, source.sentenceId])),
      })),
      crossings: ranked.get(node.id)?.children ?? node.crossings,
    })),
  };
  const run = await runCrossing(routedAsset, query, progress, signal, {
    acquisition: retainedAcquisition(reasoning),
  });
  const recording = recordRun(run, {
    assetBytes: JSON.stringify(routedAsset),
    assetName: `${project.path} (selected branch snapshot)`,
  });
  recording.project = { ...asset.project, digest: project.digest };
  recording.routing = routing;
  if (routing.status === 'matched') {
    recording.models.embedding = routing.model;
    recording.embedding = routing.embedding;
  }
  recording.reasoning = {
    profile: reasoning.profile,
    runId: engine.id,
    inputRef: engine.inputRef,
    resultRef: engine.resultRef,
    ask: ask ?? null,
    policy: engine.policy,
    status: engine.status,
    elapsedMs: engine.elapsedMs,
    coverage: reasoning.retrieval,
    candidates: engine.candidates,
    openings: engine.openings,
    chains: reasoning.chains,
    applications: reasoning.applications,
    stages: engine.stages,
    calls: engine.calls,
    selectedFit: reasoning.selectedFit,
    traceStatus: engine.traceStatus,
    answer: engine.answer,
    exploration: reasoning.exploration,
  };
  recording.knowledge = knowledgeSnapshot(project.data);
  if (ask) recording.ask = structuredClone(ask);
  if (continuation) recording.continuation = structuredClone(continuation);
  validateRecording(recording);
  signal?.throwIfAborted();
  const directory = join(dirname(project.path), 'recordings');
  await mkdir(directory, { recursive: true });
  signal?.throwIfAborted();
  const path = join(
    directory,
    `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}.json`,
  );
  // Publish whole recordings only; an interrupted write leaves an ignored dot file.
  const staged = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(staged, JSON.stringify(recording, null, 2) + '\n', { flag: 'wx', signal });
    signal?.throwIfAborted();
    await rename(staged, path);
  } finally {
    await unlink(staged).catch((cleanup) => {
      if (cleanup.code !== 'ENOENT') throw cleanup;
    });
  }
  engine.recording = { path, id: recording.id, ask: ask ?? null };
  await saveEngineRun(project, engine);
  return { recording, path };
}
