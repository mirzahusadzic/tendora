/** A reviewed mapping library is authored project material. */
import { randomUUID } from 'node:crypto';
import { validateProject } from './project.mjs';
import { graphRevision } from '../../recording/revisions.mjs';
import { reviseGraph } from '../../amr/revision.mjs';
import { isDeepStrictEqual } from 'node:util';
export function storeSourceParse(
  project,
  { name, proposal, decisionId, source, sourceText, actor = 'participant' },
) {
  if (!name.trim() || !decisionId || !sourceText || !proposal.sourceEdits?.length)
    throw new Error('Accepted source parse required');
  reviseGraph(source, proposal.sourceEdits);
  const next = structuredClone(project.data);
  const sourceRevision = graphRevision(source);
  const previous = next.interpretationMappings?.find(
    (entry) =>
      entry.kind === 'source-parse' &&
      entry.name === name &&
      entry.sourceText === sourceText &&
      entry.sourceRevision === sourceRevision &&
      isDeepStrictEqual(entry.edits, proposal.sourceEdits),
  );
  const entry = {
    id: previous?.id ?? randomUUID(),
    name,
    version: 1,
    kind: 'source-parse',
    projectId: project.data.id,
    sourceText,
    sourceRevision,
    edits: structuredClone(proposal.sourceEdits),
    actor,
    origin: { decisionId, proposalId: proposal.id, scope: proposal.scope },
  };
  next.interpretationMappings = [
    ...(next.interpretationMappings ?? []).filter((item) => item.id !== entry.id),
    entry,
  ];
  return validateProject(next);
}
export function storeMapping(
  project,
  { name, proposal, decisionId, query, source, actor = 'participant' },
) {
  if (!name.trim() || !decisionId || !proposal.mappings?.length)
    throw new Error('Accepted mapping required');
  const next = structuredClone(project.data);
  const entry = {
    id: randomUUID(),
    name,
    version: 1,
    projectId: project.data.id,
    origin: { decisionId, proposalId: proposal.id, scope: proposal.scope },
    actor,
    queryEvent: query.nodes.find((node) => node.id === proposal.scope.queryEvent)?.concept,
    sourceEvent: source.nodes.find((node) => node.id === proposal.scope.sourceEvent)?.concept,
    pairs: proposal.mappings.map(({ queryConcept, sourceConcept }) => ({
      queryConcept,
      sourceConcept,
    })),
  };
  next.interpretationMappings = [...(next.interpretationMappings ?? []), entry];
  return validateProject(next);
}
export function resolveMapping(entry, query, source, anchors = {}) {
  if (entry.kind === 'source-parse')
    return [
      {
        status:
          entry.version === 1 &&
          entry.sourceText === anchors.sourceText &&
          entry.sourceRevision === graphRevision(source)
            ? 'unique'
            : 'absent',
      },
    ];
  if (entry.version !== 1 || !Array.isArray(entry.pairs)) throw new Error('Invalid saved mapping');
  const events = {
    query: query.nodes.filter((node) => node.concept === entry.queryEvent),
    source: source.nodes.filter((node) => node.concept === entry.sourceEvent),
  };
  const anchorStatus = ['query', 'source'].map((side) =>
    anchors[`${side}Event`]
      ? events[side].some((node) => node.id === anchors[`${side}Event`])
        ? 'unique'
        : 'absent'
      : events[side].length === 1
        ? 'unique'
        : events[side].length
          ? 'ambiguous'
          : 'absent',
  );
  return entry.pairs.map((pair) => {
    const left = query.nodes.filter((node) => node.concept === pair.queryConcept),
      right = source.nodes.filter((node) => node.concept === pair.sourceConcept);
    return {
      ...pair,
      queryNodeIds: left.map((node) => node.id),
      sourceNodeIds: right.map((node) => node.id),
      queryEvent: anchors.queryEvent ?? events.query[0]?.id,
      sourceEvent: anchors.sourceEvent ?? events.source[0]?.id,
      status: anchorStatus.includes('absent')
        ? 'absent'
        : anchorStatus.includes('ambiguous')
          ? 'ambiguous'
          : left.length === 1 && right.length === 1
            ? 'unique'
            : !left.length || !right.length
              ? 'absent'
              : 'ambiguous',
    };
  });
}
