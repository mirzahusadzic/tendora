/** Participant-authored investigation state; recordings retain their own lifecycle. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sourceCatalog, scopedSources } from '../authoring/sources.mjs';
import { isContextualSource } from '../../recording/case-sources.mjs';
import { readDataFile, writeDataFile, listDataFiles } from '../storage/data-files.mjs';
import { withFileLease } from '../storage/locks.mjs';
import { validateFrameCarry, validateInquiryFrame } from '../../recording/frame.mjs';

export const textDigest = (text) => createHash('sha256').update(text).digest('hex');
/** A case is the situation it states: its statements' texts, one per line (as
 * a run's `case` records them). A selection without statements is named by
 * its placement. */
export const caseIdentity = (selection) =>
  typeof selection === 'string'
    ? selection || null
    : selection?.sources?.length
      ? selection.sources.map((source) => source.text).join('\n')
      : (selection?.placementId ?? null);
/** A saved question is its text, its scope and its case, on every surface that
 * groups saved questions (review 2026-10-25, #8). */
export const questionIdentity = (text, scopePlacementId, selection) =>
  JSON.stringify([text.trim(), scopePlacementId, caseIdentity(selection)]);
/** A run's case by what it states: the text it records, or its selection's
 * statements (a run saved before runs recorded the text); null for none. */
export const runCase = (run) => caseIdentity(run.case || run.caseSelection);
/** The newest saved check of each question (its text, scope and case) at a
 * revision, among `purposes`: `runs`, those whose newest check holds its
 * answer, and `released`, how many questions have a newest check compaction
 * released. A released newest check is counted so, never read from an older
 * full one (review of v0.2.0, recheck #1). A run's case is its text, whatever
 * placement each asking gave it. */
export function newestChecks(runs, { digest, purposes }) {
  const newest = new Map();
  for (const run of runs) {
    const text = run.questions?.[0]?.text;
    if (!text || run.projectDigest !== digest) continue;
    if (run.purpose && !purposes.includes(run.purpose)) continue;
    if (!run.answer && run.cache !== 'recheck') continue;
    const key = questionIdentity(text, run.scopePlacementId, runCase(run));
    if (!newest.has(key) || newest.get(key).startedAt < run.startedAt) newest.set(key, run);
  }
  const all = [...newest.values()];
  return {
    runs: all.filter((run) => run.answer),
    released: all.filter((run) => !run.answer).length,
  };
}
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const identifier = (value) => typeof value === 'string' && /^[\w-]+$/u.test(value);
export function sourceReference(
  project,
  placementId,
  index,
  catalog = sourceCatalog(project.data),
) {
  const placement = project.data.placements.find((item) => item.id === placementId);
  const concept = project.data.concepts.find((item) => item.id === placement?.conceptId);
  const source = catalog.find(
    (s) => s.nodeId === placementId && s.index === index && s.development?.asserted !== false,
  );
  if (!concept || !source) throw new Error('Source unavailable');
  const text = source.text;
  return {
    projectId: project.data.id,
    revision: project.digest,
    placementId,
    conceptId: concept.id,
    sentenceId: source.sentenceId,
    sentenceRevision: source.revision,
    sourceRefs: source.sourceRefs,
    index,
    textDigest: textDigest(text),
    text,
  };
}
export function selectCase(project, placementId, indexes = null) {
  const placement = project.data.placements.find((item) => item.id === placementId);
  const concept = project.data.concepts.find((item) => item.id === placement?.conceptId);
  if (!concept) throw new Error('Case unavailable');
  const catalog = sourceCatalog(project.data);
  const availableSources = catalog
    .filter((s) => s.nodeId === placementId && s.development?.asserted !== false)
    .map(({ index }) => sourceReference(project, placementId, index, catalog));
  const scopes = scopedSources(project.data);
  const sources = indexes
    ? indexes.map((index) => sourceReference(project, placementId, index, catalog))
    : availableSources.filter((source) => !isContextualSource(source, scopes));
  if (!sources.length) throw new Error('Case sources required');
  return {
    id: randomUUID(),
    projectId: project.data.id,
    placementId,
    conceptId: concept.id,
    label: concept.name,
    revision: project.digest,
    sources,
    availableSources,
    binding: null,
  };
}
/** A question's independent circumstances, retained without asserting them in the corpus. */
export function authorCase(project, text, previous = null) {
  const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
  if (!sentences.length) throw new Error('Describe the case before saving.');
  const old =
    previous?.kind === 'authored' && previous.projectId === project.data.id ? previous : null;
  const id = old?.id ?? randomUUID();
  const placementId = old?.placementId ?? `case-${id}`;
  const conceptId = old?.conceptId ?? placementId;
  const revision = textDigest(sentences.join('\n'));
  const sources = sentences.map((sentence, index) => ({
    projectId: project.data.id,
    placementId,
    conceptId,
    revision,
    index,
    text: sentence,
    textDigest: textDigest(sentence),
    sentenceRevision: textDigest(sentence),
    sentenceId:
      old?.sources.find((source) => source.index === index && source.text === sentence)
        ?.sentenceId ?? randomUUID(),
  }));
  return validateCase(
    {
      kind: 'authored',
      id,
      projectId: project.data.id,
      placementId,
      conceptId,
      label: sentences.join(' '),
      revision,
      sources,
      availableSources: sources,
      binding: old?.revision === revision ? old.binding : null,
    },
    project.data.id,
  );
}
export function validateCase(value, projectId) {
  if (
    !value ||
    value.projectId !== projectId ||
    !nonempty(value.placementId) ||
    !nonempty(value.conceptId) ||
    !Array.isArray(value.sources) ||
    !value.sources.length ||
    [...value.sources, ...(value.availableSources ?? [])].some(
      (source) =>
        source.projectId !== projectId ||
        source.placementId !== value.placementId ||
        source.conceptId !== value.conceptId ||
        !nonempty(source.revision) ||
        !Number.isInteger(source.index) ||
        source.index < 0 ||
        !nonempty(source.text) ||
        source.textDigest !== textDigest(source.text),
    )
  )
    throw new Error('Invalid case selection');
  if (
    value.binding &&
    (!nonempty(value.binding.queryNodeId) ||
      !nonempty(value.binding.graphDigest) ||
      !nonempty(value.binding.questionDigest) ||
      !nonempty(value.binding.decisionId))
  )
    throw new Error('Invalid case binding');
  return value;
}
export function newInvestigation(project, question = '') {
  return {
    schema: 'tendora.investigation',
    version: 1,
    id: randomUUID(),
    projectId: project.data.id,
    intentions: [
      { id: randomUUID(), text: question, at: new Date().toISOString(), actor: 'participant' },
    ],
    asks: [],
    assessments: [],
  };
}
/** Where a saved question came from: asked here by the author, drafted on the
 * author's behalf, asked from outside the project, or derived by the engine.
 * Lineage groups questions; it never counts as evidence. */
export const questionLineages = ['author', 'drafted', 'outside', 'derived'];
export function addAsk(
  data,
  {
    question = '',
    scopePlacementId,
    caseSelection = null,
    origin = null,
    lineage = null,
    continuation = null,
    frame = null,
    carry = null,
  } = {},
) {
  const next = structuredClone(data);
  const ask = {
    id: randomUUID(),
    question,
    scopePlacementId,
    caseSelection,
    origin,
    ...(lineage ? { lineage } : {}),
    continuation,
    ...(frame ? { frame } : {}),
    ...(carry ? { carry } : {}),
    intentionId: next.intentions.at(-1).id,
    revision: 0,
    runs: [],
    checkedFrame: null,
    originFrame: null,
    status: 'draft',
    cursor: Array.from(question).length,
  };
  next.asks.push(ask);
  next.activeAskId = ask.id;
  return next;
}
export function currentAsk(data) {
  return data?.asks.find((ask) => ask.id === data.activeAskId) ?? null;
}
export function followupFor(data, parent, openingId) {
  return (
    data?.asks.findLast(
      (ask) =>
        ask.origin?.path === parent.path &&
        ask.origin?.recordingRevision === parent.recordingRevision &&
        ask.origin?.nodeId === parent.nodeId &&
        ask.origin?.occurrenceId === parent.occurrenceId &&
        ask.continuation?.opening.id === openingId,
    ) ?? null
  );
}
export function reviseIntention(data, text, origin) {
  if (!nonempty(text)) throw new Error('Intention required');
  const next = structuredClone(data);
  const revision = {
    id: randomUUID(),
    text,
    previous: next.intentions.at(-1).id,
    origin,
    at: new Date().toISOString(),
    actor: 'participant',
  };
  next.intentions.push(revision);
  return next;
}
export function assessInvestigation(data, { action, origin, evidence = [], note = '' }) {
  if (!['selected', 'open', 'revoked'].includes(action) || !origin)
    throw new Error('Assessment target required');
  if (
    action === 'revoked' &&
    (!data.assessments.some(
      (item) => item.id === origin.assessmentId && item.action !== 'revoked',
    ) ||
      data.assessments.some(
        (item) => item.action === 'revoked' && item.origin.assessmentId === origin.assessmentId,
      ))
  )
    throw new Error('Assessment unavailable');
  const next = structuredClone(data);
  next.assessments.push({
    id: randomUUID(),
    action,
    origin,
    evidence,
    note,
    at: new Date().toISOString(),
    actor: 'participant',
  });
  return next;
}
export function validateInvestigation(data) {
  if (
    data?.schema !== 'tendora.investigation' ||
    data.version !== 1 ||
    !identifier(data.id) ||
    !nonempty(data.projectId) ||
    !Array.isArray(data.intentions) ||
    !data.intentions.length ||
    !Array.isArray(data.asks) ||
    !Array.isArray(data.assessments)
  )
    throw new Error('Invalid investigation');
  const intentions = new Set();
  for (const item of data.intentions) {
    if (
      !identifier(item.id) ||
      intentions.has(item.id) ||
      typeof item.text !== 'string' ||
      (item.previous && !intentions.has(item.previous))
    )
      throw new Error('Invalid intention revision');
    intentions.add(item.id);
  }
  const asks = new Set();
  for (const ask of data.asks) {
    if (
      !identifier(ask.id) ||
      asks.has(ask.id) ||
      !intentions.has(ask.intentionId) ||
      typeof ask.question !== 'string' ||
      !nonempty(ask.scopePlacementId) ||
      !Array.isArray(ask.runs) ||
      !Number.isInteger(ask.revision) ||
      ask.revision < 0 ||
      !['draft', 'running', 'complete'].includes(ask.status) ||
      !Number.isInteger(ask.cursor) ||
      ask.cursor < 0 ||
      ask.cursor > Array.from(ask.question).length
    )
      throw new Error('Invalid ask');
    if (ask.caseSelection) validateCase(ask.caseSelection, data.projectId);
    if (
      ask.lineage !== undefined &&
      (!questionLineages.includes(ask.lineage?.kind) ||
        (ask.lineage.by !== undefined && !nonempty(ask.lineage.by)))
    )
      throw new Error('Invalid ask lineage');
    if (ask.frame) validateInquiryFrame(ask.frame);
    if (ask.carry) validateFrameCarry(ask.carry);
    if (ask.checkedFrame) validateInquiryFrame(ask.checkedFrame);
    if (ask.originFrame) validateInquiryFrame(ask.originFrame);
    for (const run of ask.runs) {
      if (
        !nonempty(run.path) ||
        !nonempty(run.recordingRevision) ||
        typeof run.question !== 'string' ||
        !Number.isInteger(run.revision) ||
        run.revision < 0 ||
        run.revision > ask.revision
      )
        throw new Error('Invalid ask run');
      if (run.caseSelection) validateCase(run.caseSelection, data.projectId);
      if (run.frame) validateInquiryFrame(run.frame);
      if (run.carry) validateFrameCarry(run.carry);
    }
    asks.add(ask.id);
  }
  const assessments = new Set();
  for (const item of data.assessments) {
    if (
      !identifier(item.id) ||
      assessments.has(item.id) ||
      !['selected', 'open', 'revoked'].includes(item.action) ||
      !item.origin ||
      typeof item.note !== 'string' ||
      !Array.isArray(item.evidence) ||
      (item.action === 'revoked' && !assessments.has(item.origin.assessmentId))
    )
      throw new Error('Invalid assessment');
    assessments.add(item.id);
  }
  if (data.activeAskId && !asks.has(data.activeAskId)) throw new Error('Invalid active ask');
  return data;
}
const pathFor = (project, id) => {
  if (!identifier(id)) throw new Error('Invalid investigation ID');
  return join(dirname(project.path), 'investigations', `${id}.json`);
};
export async function readInvestigation(project, id) {
  const path = pathFor(project, id),
    bytes = await readDataFile(dirname(project.path), path);
  const data = validateInvestigation(JSON.parse(bytes));
  if (data.projectId !== project.data.id) throw new Error('Investigation project mismatch');
  return { path, data, digest: textDigest(bytes) };
}
export async function listInvestigations(project) {
  let files;
  try {
    files = await listDataFiles(dirname(project.path), 'investigations');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = await Promise.all(
    files
      .filter((name) => !name.startsWith('._') && name.endsWith('.json'))
      .map((name) => readInvestigation(project, name.slice(0, -5))),
  );
  return entries.sort((a, b) => (b.data.updatedAt ?? '').localeCompare(a.data.updatedAt ?? ''));
}
export async function saveInvestigation(project, data, expectedDigest = null) {
  validateInvestigation(data);
  if (data.projectId !== project.data.id) throw new Error('Investigation project mismatch');
  const path = pathFor(project, data.id);
  await mkdir(dirname(path), { recursive: true });
  return withFileLease(
    `${path}.lock`,
    async () => {
      let current = null;
      try {
        current = textDigest(await readDataFile(dirname(project.path), path));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (current !== expectedDigest) throw new Error('Investigation changed');
      const saved = { ...data, updatedAt: new Date().toISOString() },
        bytes = JSON.stringify(saved, null, 2) + '\n';
      await writeDataFile(dirname(project.path), path, bytes);
      return { path, data: saved, digest: textDigest(bytes) };
    },
    { busyMessage: 'Investigation busy' },
  );
}
