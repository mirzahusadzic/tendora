/** Sentence identity belongs to a concept; a placement is an occurrence of it. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { contributionSources } from './development.mjs';

export const sentenceRevision = (text) => createHash('sha256').update(text).digest('hex');
export function conceptSources(concept) {
  const used = new Set(),
    counts = new Map(),
    savedByText = new Map();
  for (const entry of concept.sourceRecords ?? []) {
    if (!savedByText.has(entry.text)) savedByText.set(entry.text, []);
    savedByText.get(entry.text).push(entry);
  }
  return concept.passages.map((text, index) => {
    const saved = savedByText.get(text)?.find((entry) => !used.has(entry.id));
    const revision = sentenceRevision(text);
    const ordinal = counts.get(text) ?? 0;
    counts.set(text, ordinal + 1);
    const id = saved?.id ?? `${concept.id}/sentence/${revision}/${ordinal}`;
    used.add(id);
    return {
      ...saved,
      id,
      text,
      revision,
      conceptId: concept.id,
      sourceRefs: structuredClone(saved?.sourceRefs ?? concept.sourceRefs ?? []),
    };
  });
}

/** Exact text survives moves. A single unambiguous replacement keeps its identity. */
export function reconcileSources(data, previous = data) {
  const next = structuredClone(data);
  const previousConcepts = new Map(previous.concepts.map((concept) => [concept.id, concept]));
  for (const concept of next.concepts) {
    const old = previousConcepts.get(concept.id);
    const records = conceptSources(concept),
      before = old ? conceptSources(old) : [];
    const currentIds = new Set(records.map((record) => record.id)),
      oldIds = new Set(before.map((record) => record.id));
    const removed = before.filter((entry) => !currentIds.has(entry.id));
    const added = records.filter((entry) => !oldIds.has(entry.id));
    if (
      removed.length === 1 &&
      added.length === 1 &&
      old.passages.length === concept.passages.length
    ) {
      Object.assign(added[0], { id: removed[0].id, previousRevision: removed[0].revision });
    }
    const derived = new Map(
      conceptSources({ ...concept, sourceRecords: undefined }).map((record) => [record.id, record]),
    );
    const explicit = records.filter((record) => !isDeepStrictEqual(record, derived.get(record.id)));
    if (explicit.length) concept.sourceRecords = explicit;
    else delete concept.sourceRecords;
  }
  return next;
}

export function sourceCatalog(data) {
  const concepts = new Map(data.concepts.map((concept) => [concept.id, concept]));
  const records = new Map(data.concepts.map((concept) => [concept.id, conceptSources(concept)]));
  const authors = new Map();
  for (const entry of data.authoring ?? []) {
    const key = JSON.stringify([entry.conceptId, entry.text]);
    if (!authors.has(key)) authors.set(key, []);
    authors.get(key).push(entry);
  }
  const authored = data.placements.flatMap((placement) =>
    records.get(placement.conceptId).map(({ id: sentenceId, ...source }, index) => ({
      ...source,
      sentenceId,
      index,
      nodeId: placement.id,
      authoring: authors.get(JSON.stringify([placement.conceptId, source.text])) ?? [],
    })),
  );
  const counts = new Map(
    data.placements.map((p) => [p.id, concepts.get(p.conceptId).passages.length]),
  );
  return [
    ...authored,
    ...contributionSources(data).map((source) => {
      const index = counts.get(source.nodeId);
      counts.set(source.nodeId, index + 1);
      return { ...source, index, authoring: [] };
    }),
  ];
}

export function scopedSources(data) {
  const catalog = sourceCatalog(data);
  return (data.sourceScopes ?? []).map((scope) => {
    const source = catalog.find(
      (item) => item.nodeId === scope.placementId && item.text === scope.text,
    );
    return {
      ...scope,
      conceptId: scope.conceptId ?? source?.conceptId,
      sentenceId: scope.sentenceId ?? source?.sentenceId,
      revision: scope.revision ?? source?.revision,
      applicability: scope.applicability ?? 'concept',
    };
  });
}
