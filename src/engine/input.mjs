/** Bind one actual Ask to current scoped sources and its independent case snapshot. */
import { acquiredTexts } from '../project/storage/acquisitions.mjs';
import { sentenceRevision, sourceCatalog } from '../project/authoring/sources.mjs';
import { graphView } from '../amr/graph.mjs';
import { normalizedRoleProfile } from '../models/graph-preparation.mjs';

/** Snapshot current authored text directly, without creating a saved inquiry. */
export async function inputFromProject(
  project,
  { scopePlacementId, question, caseSelection = null, ask = null },
) {
  if (typeof question !== 'string' || !question.trim()) throw new Error('Question is required');
  const placements = project.data.placements;
  if (!placements.some((item) => item.id === scopePlacementId))
    throw new Error('Scope unavailable');
  const selected = new Set([scopePlacementId]);
  const children = new Map();
  for (const placement of placements) {
    if (!children.has(placement.parentId)) children.set(placement.parentId, []);
    children.get(placement.parentId).push(placement.id);
  }
  for (const id of selected) for (const child of children.get(id) ?? []) selected.add(child);
  if (caseSelection && caseSelection.projectId !== project.data.id) {
    throw new Error('Case belongs to another project');
  }
  const catalog = sourceCatalog(project.data);
  const sources = catalog
    .filter((item) => selected.has(item.nodeId) && item.nodeId !== caseSelection?.placementId)
    .map((item) => ({
      id: item.development ? item.sentenceId : `${item.nodeId}/s${item.index + 1}`,
      kind: 'source',
      placementId: item.nodeId,
      conceptId: item.conceptId,
      sentenceId: item.sentenceId,
      revision: item.revision,
      text: item.text,
      sourceRefs: item.sourceRefs,
      ...(item.development
        ? { graph: item.graph, development: item.development, acquisition: item.acquisition }
        : {}),
    }));
  const cases = (caseSelection?.sources ?? []).map((item, index) => ({
    id: `${item.placementId}/s${index + 1}`,
    kind: 'case',
    placementId: item.placementId,
    conceptId: item.conceptId,
    sentenceId: item.sentenceId,
    revision: item.sentenceRevision ?? item.textDigest,
    text: item.text,
    sourceRefs: item.sourceRefs,
  }));
  const entries = [
    ...sources,
    ...cases,
    {
      id: ask?.askId ?? `question:${sentenceRevision(question)}`,
      kind: 'question',
      text: question,
      revision: sentenceRevision(question),
      ask: structuredClone(ask),
    },
  ];
  const captures = await acquiredTexts(
    project,
    entries.map((item) => item.text),
  );
  const bound = entries.map((item, index) => ({
    ...item,
    acquisition: item.acquisition ??
      captures?.[index] ?? {
        status: 'missing',
        text: item.text,
        textDigest: sentenceRevision(item.text),
        reason: 'AMR acquisition is required for this exact text.',
      },
  }));
  return {
    version: 1,
    projectId: project.data.id,
    projectRevision: project.digest,
    scopePlacementId,
    caseSelection: structuredClone(caseSelection),
    sources: bound.slice(0, sources.length),
    cases: bound.slice(sources.length, -1),
    question: bound.at(-1),
    openings: bound
      .filter((item) => item.acquisition.status === 'missing')
      .map((item) => ({
        id: `acquisition:${item.id}`,
        kind: 'acquisition',
        inputId: item.id,
        text: item.text,
        placementId: item.placementId ?? scopePlacementId,
        reason: item.acquisition.reason,
      })),
  };
}

/** Adapt normalized retained graphs to the pilot's attributed ingress contract. */
export function retainedAcquisition(result) {
  const byText = new Map();
  for (const entry of result.inputs) if (!byText.has(entry.text)) byText.set(entry.text, entry);
  return async (texts) => {
    const parsed = texts.map((text) => {
      const input = byText.get(text);
      if (!input) throw new Error(`No retained AMR for: ${text}`);
      const capture = input.acquisition;
      if (!input.graph)
        return {
          decode_status: 'missing',
          penman: capture?.penman ?? null,
          model: capture?.acquisition?.model ?? 'retained',
          revision: capture?.acquisition?.revision ?? null,
          diagnostics: [{ message: capture?.reason ?? 'No normalized retained graph' }],
        };
      const literals = new Map(
        input.graph.nodes
          .filter((node) => node.literal !== undefined)
          .map((node) => [node.id, node.literal]),
      );
      return {
        decode_status: 'ok',
        penman: input.penman,
        top: input.graph.top,
        model: capture?.acquisition?.model ?? 'authored AMR',
        revision: capture?.acquisition?.revision ?? 'retained',
        originalPenman: capture?.penman ?? input.penman,
        ...(capture?.origin ? { origin: capture.origin } : {}),
        ...(capture?.ref ? { acquisitionRef: capture.ref } : {}),
        normalization: {
          profile: normalizedRoleProfile,
          ...(input.origins ? { origins: input.origins } : {}),
          ...(input.operations ? { operations: input.operations } : {}),
        },
        triples: [
          ...input.graph.nodes
            .filter((node) => node.literal === undefined)
            .map((node) => ({
              source: node.id,
              relation: ':instance',
              target: node.concept,
              target_kind: 'literal',
            })),
          ...input.graph.edges.map((edge) => ({
            source: edge.from,
            relation: edge.role,
            target: literals.get(edge.to) ?? edge.to,
            target_kind: literals.has(edge.to) ? 'literal' : 'node',
          })),
        ],
      };
    });
    const modelNames = [
      ...new Set(
        parsed
          .filter((item) => item.decode_status === 'ok')
          .map((item) => `${item.model}@${item.revision}`),
      ),
    ];
    return {
      parsed,
      views: parsed.map(graphView),
      vectors: null,
      models: { amr: modelNames.join('; '), acquisition: 'retained', embedding: null },
      embedding: null,
    };
  };
}
