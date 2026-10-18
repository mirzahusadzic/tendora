/** Case evidence stays distinct from corpus sentences conditioned on that evidence. */
export function sourceScopesFor(source, scopes = []) {
  return scopes.filter((entry) =>
    entry.sentenceId && source.sentenceId
      ? entry.sentenceId === source.sentenceId
      : entry.text === source.text &&
        (entry.conceptId && source.conceptId
          ? entry.conceptId === source.conceptId
          : entry.placementId === (source.nodeId ?? source.placementId)),
  );
}

export const isContextualSource = (source, scopes) =>
  sourceScopesFor(source, scopes).some(
    (scope) => scope.context?.sources?.length || scope.caseTexts?.length,
  );

export function caseSources(recording, knowledge = recording.knowledge ?? {}) {
  const root = recording.caseState?.rootNodeId;
  if (!root) return [];
  const selection = recording.caseState.selection;
  const selected = selection?.placementId === root ? selection.sources : null;
  const catalog = new Map(
    (knowledge.sourceCatalog ?? [])
      .filter((source) => source.nodeId === root)
      .map((source) => [source.text, source]),
  );
  return recording.sources.filter(
    (source) =>
      source.nodeId === root &&
      (!selected ||
        selected.some(
          (reference) =>
            reference.text === source.text &&
            (!reference.sentenceId ||
              !source.sentenceId ||
              reference.sentenceId === source.sentenceId),
        )) &&
      !isContextualSource({ ...catalog.get(source.text), ...source }, knowledge.sourceScopes),
  );
}
