/** Prepare an authored crossing asset and run one attributed, live inquiry.
 * Capture and the diagnostic CLI use this same path; a recording never calls it.
 */
import { createHash } from 'node:crypto';
import { acquire, dot } from '../models/acquisition.mjs';
import { proposedEnglish, walk } from './crossing.mjs';
import { queryRetention } from '../amr/retention.mjs';

export const digest = (value) => createHash('sha256').update(value).digest('hex');

export async function runCrossing(
  asset,
  query = asset.query,
  progress = () => {},
  signal,
  { acquisition = acquire } = {},
) {
  if (
    typeof query !== 'string' ||
    !query.trim() ||
    !Array.isArray(asset.nodes) ||
    !asset.nodes.length ||
    typeof asset.start !== 'string'
  ) {
    throw new Error('asset needs query, start, and nonempty nodes');
  }
  const ids = new Set(),
    texts = [];
  const prepared = asset.nodes.map((node) => {
    if (
      typeof node.id !== 'string' ||
      !node.id ||
      ids.has(node.id) ||
      !Array.isArray(node.sentences) ||
      node.sentences.some((text) => typeof text !== 'string' || !text.trim()) ||
      !Array.isArray(node.crossings)
    )
      throw new Error(`invalid or duplicate node: ${node.id}`);
    ids.add(node.id);
    return { ...node, sentenceIndexes: node.sentences.map((text) => texts.push(text) - 1) };
  });
  if (!ids.has(asset.start)) throw new Error(`unknown start node: ${asset.start}`);
  for (const node of prepared) {
    if (node.crossings.some((id) => !ids.has(id)))
      throw new Error(`unknown crossing from ${node.id}`);
    for (const proposal of node.interpretationProposals ?? []) {
      if (
        !Number.isInteger(proposal.source) ||
        proposal.source < 0 ||
        proposal.source >= node.sentences.length ||
        typeof proposal.replace?.from !== 'string' ||
        !proposal.replace.from.trim() ||
        typeof proposal.replace?.to !== 'string' ||
        !proposal.replace.to.trim() ||
        proposal.replace.from === proposal.replace.to
      ) {
        throw new Error(`invalid interpretation proposal at ${node.id}`);
      }
    }
  }
  const queryIndex = texts.push(query) - 1;
  const preparedProposals = new Map(
    prepared.map((node) => [
      node.id,
      (node.interpretationProposals ?? []).flatMap((proposal) => {
        const english = proposedEnglish(query, proposal.replace);
        return english
          ? [
              {
                sourceIndex: proposal.source,
                patch: proposal.replace,
                english,
                index: texts.push(english) - 1,
              },
            ]
          : [];
      }),
    ]),
  );
  const { parsed, views, vectors, models, embedding } = await acquisition(texts, progress, signal);
  const graph = views[queryIndex];
  const retention = graph ? queryRetention(query, graph) : { status: 'invalid-parse' };
  if (!graph || retention.status === 'no-content-anchor') {
    return {
      asset,
      query,
      prepared,
      texts,
      parsed,
      views,
      vectors,
      models,
      embedding,
      queryIndex,
      retention,
      nodes: null,
      result: null,
    };
  }
  const nodes = new Map(
    prepared.map((node) => [
      node.id,
      {
        sources: node.sentenceIndexes.map((index) => ({
          text: texts[index],
          graph: views[index],
          amr: parsed[index],
          affinity: vectors ? dot(vectors[index], vectors[queryIndex]) : null,
          inputIndex: index,
        })),
        crossings: node.crossings,
        proposals: preparedProposals.get(node.id).map((proposal) => ({
          sourceIndex: proposal.sourceIndex,
          patch: proposal.patch,
          english: proposal.english,
          graph: views[proposal.index],
          amr: parsed[proposal.index],
          inputIndex: proposal.index,
        })),
      },
    ]),
  );
  const result = walk(nodes, asset.start, {
    id: digest(query).slice(0, 12),
    text: query,
    graph,
    interpretation: digest(`${models.amr}\n${parsed[queryIndex].penman}`).slice(0, 12),
    amrModel: models.amr,
    caseState: asset.caseState,
  });
  return {
    asset,
    query,
    prepared,
    texts,
    parsed,
    views,
    vectors,
    models,
    embedding,
    queryIndex,
    retention,
    nodes,
    result,
  };
}
