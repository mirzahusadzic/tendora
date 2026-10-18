/** Snapshot source identity and participant-authored scope for offline evaluation. */
import { sourceCatalog, scopedSources } from './sources.mjs';
import { validateRule } from '../../amr/inference.mjs';
import { validateReferenceBinding } from '../../recording/reference-bindings.mjs';
import { contributionRules } from './development.mjs';

/** Explicit authored premises; similarity mappings are never executable rules. */
export function authorEngineKnowledge(data, entry) {
  if (
    entry?.kind !== 'engine-knowledge' ||
    entry.version !== 1 ||
    !entry.id?.trim() ||
    !entry.name?.trim() ||
    !entry.attribution?.trim() ||
    !data.placements.some((placement) => placement.id === entry.scopePlacementId)
  )
    throw new Error(
      'Engine knowledge needs an identity, name, attribution and existing placement scope',
    );
  const ids = new Set();
  for (const key of ['rules', 'parses', 'queryParses', 'bindings']) {
    if (entry[key] !== undefined && !Array.isArray(entry[key]))
      throw new Error(`Invalid knowledge ${key}`);
    for (const item of entry[key] ?? []) {
      if (!item.id?.trim() || ids.has(item.id))
        throw new Error('Knowledge components need distinct identities');
      ids.add(item.id);
      if (key === 'rules') validateRule(item);
      if (key === 'bindings')
        validateReferenceBinding({
          ...item,
          attribution: item.attribution ?? entry.attribution,
          scopePlacementId: entry.scopePlacementId,
        });
      if (
        ['parses', 'queryParses'].includes(key) &&
        (!/^[a-f0-9]{64}$/u.test(item[key === 'parses' ? 'sourceRevision' : 'revision']) ||
          !Array.isArray(item.edits) ||
          !item.edits.length ||
          (key === 'parses' && !item.sourceText?.trim()))
      )
        throw new Error('Parse corrections need an exact graph revision and edits');
    }
  }
  return {
    ...data,
    knowledge: [
      ...(data.knowledge ?? []).filter((item) => item.id !== entry.id),
      structuredClone(entry),
    ],
  };
}

export function knowledgeSnapshot(data) {
  const entries = (data.knowledge ?? []).filter(
    (entry) => entry.kind === 'engine-knowledge' && entry.version === 1,
  );
  const components = { rules: [], parses: [], queryParses: [], bindings: [] };
  const skipped = [];
  for (const entry of entries) {
    if (!data.placements.some((placement) => placement.id === entry.scopePlacementId)) {
      skipped.push({
        kind: 'knowledge scope unavailable',
        entryId: entry.id,
        name: entry.name,
        reason: 'The authored placement scope was removed.',
      });
      continue;
    }
    authorEngineKnowledge(data, entry);
    for (const key of Object.keys(components))
      for (const item of entry[key] ?? [])
        components[key].push({
          ...item,
          id: `${entry.id}/${item.id}`,
          attribution: item.attribution ?? entry.attribution,
          scopePlacementId: entry.scopePlacementId,
          origin: { kind: 'authored-engine-knowledge', entryId: entry.id },
        });
  }
  components.parses.push(
    ...(data.interpretationMappings ?? []).filter(
      (entry) => entry.kind === 'source-parse' && entry.version === 1,
    ),
  );
  components.rules.push(...contributionRules(data));
  return {
    version: 1,
    contributions: data.contributions ?? [],
    sourceScopes: scopedSources(data),
    sourceCatalog: sourceCatalog(data),
    entries,
    skipped,
    ...components,
  };
}
