/** Introduce premises in ranked role order, carrying the unchanged question and open obligations. */
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { checkAnswer } from './answer.mjs';
import { knowledgeSnapshot } from '../project/authoring/knowledge.mjs';

export const roleExplorationProfile = 'ranked-role-exploration-v1';
export async function exploreRoles(
  project,
  input,
  result,
  { grammarCache, signal, phase = async () => {} } = {},
) {
  const plan = input.exploration;
  if (plan.profile !== roleExplorationProfile || plan.rootNodeId !== input.scopePlacementId)
    throw new Error('The role exploration does not match this question scope');
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const order = [],
    seen = new Set(),
    stack = [{ id: plan.rootNodeId, parentId: null }];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node.id) || !nodes.has(node.id))
      throw new Error('Invalid role exploration hierarchy');
    seen.add(node.id);
    order.push(node);
    for (const id of [...nodes.get(node.id).children].reverse())
      stack.push({ id, parentId: node.id });
  }
  const sources = new Map();
  for (const record of result.inputs.filter((item) => item.kind === 'source')) {
    if (!seen.has(record.placementId)) throw new Error('A source is outside the exploration scope');
    if (!sources.has(record.placementId)) sources.set(record.placementId, []);
    sources.get(record.placementId).push(record);
  }
  const context = result.inputs.filter((item) => item.kind !== 'source');
  const allSources = result.inputs.filter((item) => item.kind === 'source');
  const knowledge = knowledgeSnapshot(project.data);
  const batch = Math.max(1, Math.ceil(sources.size / 32));
  const available = [],
    visits = [],
    checks = [];
  let answer,
    sinceCheck = 0,
    lastCount = -1,
    proofFound = false;
  const started = performance.now();
  for (const [index, node] of order.entries()) {
    signal?.throwIfAborted();
    const local = sources.get(node.id) ?? [];
    available.push(...local);
    if (local.length) sinceCheck++;
    const incoming = checks.at(-1)?.id ?? null;
    const final = index === order.length - 1;
    if ((!proofFound && sinceCheck >= batch) || final) {
      if (
        available.length !== lastCount ||
        (final && allSources.some((s, i) => checks.at(-1)?.sourceIds[i] !== s.id))
      ) {
        const checked = final ? allSources : available;
        await phase(
          'role-answer',
          `Checking ${nodes.get(node.id).label} (${index + 1}/${order.length} roles)`,
        );
        await yieldTurn(undefined, { signal });
        const at = performance.now();
        answer = checkAnswer(
          project,
          { ...input, sources: checked },
          { ...result, inputs: [...checked, ...context] },
          { grammarCache, knowledge },
        );
        checks.push({
          id: checks.length,
          nodeId: node.id,
          visitedRoles: index + 1,
          sourceIds: checked.map((s) => s.id),
          status: answer.status,
          answers: answer.answers.map(({ facts: _facts, ...binding }) => binding),
          // The final answer owns the complete evidence. Per-role checkpoints
          // retain only compact state so a long traversal does not duplicate it.
          openings: answer.openings.map(({ id, kind, state }) => ({ id, kind, state })),
          partial: answer.partial
            ? {
                profile: answer.partial.profile,
                parts: answer.partial.parts?.length ?? 0,
                openings: answer.partial.openings?.length ?? 0,
                complete: answer.partial.complete,
              }
            : null,
          complete: answer.complete,
          grammar: answer.grammar.stats,
          elapsedMs: performance.now() - at,
        });
        grammarCache = { profile: answer.grammar.profile, grammars: answer.grammar.corpora };
        proofFound ||= answer.complete && answer.answers.length > 0;
        lastCount = available.length;
        sinceCheck = 0;
      }
    }
    visits.push({
      nodeId: node.id,
      parentId: node.parentId,
      incomingCheck: incoming,
      outgoingCheck: checks.at(-1)?.id ?? null,
      sourceIds: local.map((s) => s.id),
    });
    if (index % 128 === 0) await yieldTurn(undefined, { signal });
  }
  if (!answer) throw new Error('The role exploration did not check this question');
  return {
    answer,
    exploration: {
      profile: roleExplorationProfile,
      ordering: plan.routing.status === 'matched' ? 'embedding-ranked' : 'authored',
      routing: plan.routing,
      visits,
      checks,
      complete: available.length === result.inputs.filter((i) => i.kind === 'source').length,
      elapsedMs: performance.now() - started,
    },
  };
}
