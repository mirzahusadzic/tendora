/** Pure persistent-partial merge. It never treats saved proofs as current evidence. */
import { partialIdentity, partialQueryRevision } from './partial-coverage.mjs';

export const partialContributionProfile = 'persistent-partial-contribution-v2';
const clone = (value) => structuredClone(value);
const sorted = (values) =>
  [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const unique = (values) => [
  ...new Map(values.map((value) => [partialIdentity(value), value])).values(),
];
const ownedId = (contribution, id) => `${contribution.id}/${id}`;

function partIdentity(part) {
  if (part.identity) return part.identity;
  const binding = part.bindings?.find((binding) => binding.nodeId === part.root);
  const source = part.dependencies?.find((source) => binding?.id.startsWith(`${source.id}#`));
  if (!source) return part.id;
  return `partial:${partialIdentity([
    { kind: 'node', nodeId: part.root },
    ['source', [source.nodeId, source.sentenceId ?? source.id], binding.id.slice(source.id.length)],
  ])}`;
}

function history(previous, observation, details = {}) {
  const id = partialIdentity(observation);
  const entries = previous ?? [];
  // Consecutive identical observations are idempotent. A withdrawal followed
  // by restoration still records both transitions, even to an earlier proof.
  return entries.at(-1)?.id === id
    ? clone(entries)
    : [...clone(entries), { id, ...clone(observation), ...clone(details) }];
}

function evidence(part) {
  return {
    edgeIds: sorted(part.edgeIds),
    bindings: sorted(part.bindings.map(({ nodeId, participant }) => ({ nodeId, participant }))),
    dependencies: sorted(
      part.dependencies.map(({ nodeId, sentenceId, revision, graphRevision }) => ({
        nodeId,
        sentenceId,
        revision,
        graphRevision,
      })),
    ),
    // Witnesses and derivations remain inspectable, but their ephemeral source
    // IDs must not create a new observation on sentence reordering.
    ruleIds: sorted(part.ruleIdentities ?? part.ruleIds),
    ruleDependencies: sorted(
      (part.ruleDependencies ?? []).map(({ identity, revision }) => ({ identity, revision })),
    ),
    bindingIds: sorted(part.bindingIds ?? []),
    bindingDependencies: sorted(part.bindingDependencies ?? []),
  };
}

/** Pure merge. It cannot consult saved proofs to decide whether support is current. */
export function mergePartialContribution(
  contribution,
  coverage,
  { questionGraph = contribution.question.graph } = {},
) {
  const previous = contribution.partial ?? {};
  const scope = {
    placementId: contribution.scopePlacementId,
    caseSelection: previous.caseSelection ? partialIdentity(previous.caseSelection) : null,
  };
  const revision = partialQueryRevision(questionGraph);
  const changedQuestion =
    previous.profile === partialContributionProfile && previous.questionRevision !== revision;
  const changedScope = previous.scope && partialIdentity(previous.scope) !== partialIdentity(scope);
  // Reassessment of revised language is a different query. Old graph positions
  // must not silently become anchors into it, even when their IDs are reused.
  if (changedQuestion || changedScope) coverage = { parts: [], openings: [], complete: false };
  const identities = new Map((previous.parts ?? []).map((part) => [partIdentity(part), part.id]));
  const fresh = new Map();
  for (const proof of coverage?.parts ?? []) {
    const id = identities.get(proof.id) ?? ownedId(contribution, proof.id);
    if (!fresh.has(id)) fresh.set(id, []);
    fresh.get(id).push(proof);
  }
  const old = new Map((previous.parts ?? []).map((part) => [part.id, part]));
  const parts = [...new Set([...old.keys(), ...fresh.keys()])].map((id) => {
    const before = old.get(id);
    const supports = fresh.get(id) ?? [];
    const current = supports.length > 0;
    const state = current ? 'supported' : coverage?.complete ? 'unsupported' : 'unverified';
    const representative = supports[0] ?? before;
    const observation = {
      state,
      questionRevision: revision,
      evidence: sorted(supports.map(evidence)),
    };
    return {
      ...clone(representative),
      id,
      identity: supports[0]?.id ?? partIdentity(before),
      anchor: representative.anchor ?? {
        kind: 'node',
        nodeId: representative.root ?? questionGraph.top,
      },
      scope: before?.scope ?? scope,
      questionRevision: before?.questionRevision ?? revision,
      current,
      state,
      supports: clone(supports),
      // Historical fields are kept for inspection; consumers must use current
      // and supports. Never union bindings from distinct proofs.
      candidateConnections: clone(representative.candidateConnections ?? []),
      evidenceHistory: history(
        before?.evidenceHistory ??
          (before
            ? [
                {
                  id: partialIdentity(before),
                  state: 'unverified',
                  reason: 'Legacy snapshot requires replay.',
                  proofs: [clone(before)],
                },
              ]
            : []),
        observation,
        { proofs: supports },
      ),
    };
  });
  const oldAporias = new Map(
    (previous.aporias ?? previous.openings ?? [])
      .filter((opening) => opening.anchor)
      .map((opening) => {
        const identity =
          opening.identity ?? `aporia:${partialIdentity([opening.kind, opening.anchor])}`;
        const id = previous.aporias ? opening.id : ownedId(contribution, identity);
        return [id, { ...opening, id, identity }];
      }),
  );
  const freshAporias = new Map(
    (coverage?.openings ?? []).map((opening) => [
      ownedId(contribution, opening.identity ?? `aporia:${partialIdentity(opening.anchor)}`),
      opening,
    ]),
  );
  const aporias = [...new Set([...oldAporias.keys(), ...freshAporias.keys()])].map((id) => {
    const before = oldAporias.get(id),
      opening = freshAporias.get(id);
    const anchor = (opening ?? before).anchor;
    const supporting = parts.filter(
      (part) =>
        part.current &&
        part.supports.some((proof) =>
          anchor.kind === 'edge'
            ? proof.edgeIds.includes(anchor.edgeId)
            : proof.nodeIds.includes(anchor.nodeId),
        ),
    );
    const state = opening
      ? 'open'
      : supporting.length && ((opening ?? before).kind !== 'connection' || coverage?.resolved)
        ? 'supported'
        : 'unverified';
    const bindings =
      opening?.bindings ??
      supporting.flatMap((part) => part.supports.flatMap((proof) => proof.bindings));
    const dependencies =
      opening?.dependencies ??
      supporting.flatMap((part) => part.supports.flatMap((proof) => proof.dependencies));
    const candidateConnections = opening?.candidateConnections ?? [];
    return {
      ...clone(opening ?? before),
      id,
      anchor,
      scope: before?.scope ?? scope,
      questionRevision: before?.questionRevision ?? revision,
      state,
      bindings: clone(bindings),
      dependencies: clone(dependencies),
      candidateConnections: clone(candidateConnections),
      evidenceHistory: history(
        before?.evidenceHistory,
        {
          state,
          questionRevision: revision,
          supportingPartIds: supporting.map((part) => part.id).sort(),
          bindings: sorted(
            unique(bindings.map(({ nodeId, participant }) => ({ nodeId, participant }))),
          ),
          dependencies: sorted(
            unique(
              dependencies.map(({ nodeId, sentenceId, revision, graphRevision }) => ({
                nodeId,
                sentenceId,
                revision,
                graphRevision,
              })),
            ),
          ),
          candidates: sorted(
            candidateConnections.map((candidate) => ({
              kind: candidate.kind,
              bindings: sorted(
                (candidate.bindings ?? []).map(({ nodeId, participant }) => ({
                  nodeId,
                  participant,
                })),
              ),
              dependencies: sorted(
                (candidate.dependencies ?? []).map(
                  ({ nodeId, sentenceId, revision, graphRevision }) => ({
                    nodeId,
                    sentenceId,
                    revision,
                    graphRevision,
                  }),
                ),
              ),
              rules: sorted(candidate.ruleIdentities ?? []),
              source: candidate.source && {
                nodeId: candidate.source.nodeId,
                sentenceId: candidate.source.sentenceId,
                revision: candidate.source.revision,
              },
            })),
          ),
        },
        { candidateConnections },
      ),
    };
  });
  const {
    contributions: ignoredPrevious,
    replay: ignoredReplay,
    invalidation: ignoredInvalidation,
    observedQuestionRevision: ignoredRevision,
    observedScope: ignoredScope,
    ...retained
  } = previous;
  const { contributions: ignoredCurrent, ...computed } = coverage ?? {};
  return {
    ...clone(retained),
    ...clone(computed),
    profile: partialContributionProfile,
    scope: previous.scope ?? scope,
    questionRevision: changedQuestion ? previous.questionRevision : revision,
    ...(changedQuestion || changedScope
      ? {
          invalidation: changedQuestion ? 'question-changed' : 'scope-changed',
          observedQuestionRevision: revision,
          observedScope: scope,
        }
      : {}),
    parts,
    aporias,
    openings: aporias.filter((opening) => opening.state !== 'supported'),
  };
}
