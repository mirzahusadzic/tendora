/** One language editor over existing source identities, without migrating their evidence. */
import { conceptSources, sentenceRevision } from '../project/authoring/sources.mjs';
import { addMaterial, reviseMaterial, reviseContribution, readLanguage } from './develop.mjs';

export function roleStatements(data, placementId) {
  const placement = data.placements.find((p) => p.id === placementId);
  const concept = data.concepts.find((c) => c.id === placement?.conceptId);
  if (!concept) throw new Error('Choose a role to edit.');
  return [
    ...conceptSources(concept).map((source, index) => ({
      kind: 'passage',
      conceptId: concept.id,
      index,
      source,
      texts: [source.text],
    })),
    ...(data.contributions ?? [])
      .filter((c) => c.scopePlacementId === placementId)
      .filter((c) => c.responses.some((r) => !r.withdrawn))
      .map((c) => ({
        kind: c.question ? 'answer' : 'material',
        contributionId: c.id,
        texts: c.question
          ? [c.question.text, ...c.responses.filter((r) => !r.withdrawn).map((r) => r.text)]
          : [
              c.responses
                .filter((r) => !r.withdrawn)
                .map((r) => r.text)
                .join('\n'),
            ],
      })),
  ];
}

/** Acquire all changed language before publishing one project revision. */
export async function reviseRoleStatements(project, { placementId, blocks, values }, options = {}) {
  const current = roleStatements(project.data, placementId);
  if (JSON.stringify(current) !== JSON.stringify(blocks))
    throw new Error('These statements changed. Reopen their editor.');
  if (values.length !== blocks.reduce((n, b) => n + b.texts.length, 0) + 1)
    throw new Error('The statement fields do not match this role.');
  let data = project.data,
    cursor = 0;
  const passages = [];
  for (const block of blocks) {
    options.signal?.throwIfAborted();
    const texts = values.slice(cursor, (cursor += block.texts.length)).map((t) => t.trim());
    if (block.kind === 'passage') {
      const text = texts[0];
      if (text !== block.texts[0] && text) await readLanguage(project, text, options);
      if (text)
        passages.push({
          ...block.source,
          text,
          revision: sentenceRevision(text),
          ...(text !== block.source.text
            ? {
                previousRevision: block.source.revision,
                actor: options.actor ?? 'unrecorded',
                via: options.via ?? 'library',
              }
            : {}),
        });
    } else if (texts.some((t, i) => t !== block.texts[i])) {
      const c = data.contributions.find((c) => c.id === block.contributionId);
      ({ data } =
        block.kind === 'material'
          ? await reviseMaterial(
              { ...project, data },
              { contributionId: c.id, text: texts[0] },
              options,
            )
          : await reviseContribution(
              { ...project, data },
              {
                contributionId: c.id,
                question: texts[0],
                responses: c.responses
                  .filter((r) => !r.withdrawn)
                  .map((r, i) => ({ id: r.id, text: texts[i + 1] })),
              },
              options,
            ));
    }
  }
  const placement = data.placements.find((p) => p.id === placementId);
  const concept = data.concepts.find((c) => c.id === placement.conceptId);
  if (JSON.stringify(concept.passages) !== JSON.stringify(passages.map((s) => s.text))) {
    data = structuredClone(data);
    const edited = data.concepts.find((c) => c.id === concept.id);
    edited.passages = passages.map((s) => s.text);
    edited.sourceRecords = passages;
  }
  if (values.at(-1).trim())
    ({ data } = await addMaterial(
      { ...project, data },
      { text: values.at(-1), scopePlacementId: placementId },
      options,
    ));
  options.signal?.throwIfAborted();
  return { data, changed: data !== project.data };
}
