/** Introduce premises in ranked role order, carrying the unchanged question and open obligations. */
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { answerRecording, checkAnswer } from './answer.mjs';
import { answerBase, withheldBase } from '../recording/answers.mjs';
import { proofGraph, supportLevels } from '../amr/inference.mjs';
import { knowledgeSnapshot } from '../project/authoring/knowledge.mjs';

export const roleExplorationProfile = 'ranked-role-exploration-v1';
// The record of an exploration: its checks are independent checkpoints along
// the role order (v2), no longer each reading the grammars the last one left.
export const explorationRecordProfile = 'ranked-role-exploration-v2';
// Questions of one scope and case at one revision read the same sources: the
// base of all of them is kept for the next question (the latest two), keyed by
// the revision (which carries the knowledge) and every source's reading.
const fullBases = new Map();
const keepBases = 2;
/** A question's exploration: the role order, each role's sources and the
 * checkpoints, which follow from the order alone: one after every batch of
 * roles that adds sources, and the final one with every source. Each source is
 * available from the first checkpoint that holds it. */
export function explorationPlan(input, result) {
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
  const batch = Math.max(1, Math.ceil(sources.size / 32));
  const checkpoints = [];
  const available = [];
  let sinceCheck = 0,
    lastCount = -1;
  for (const [index, node] of order.entries()) {
    const local = sources.get(node.id) ?? [];
    available.push(...local);
    if (local.length) sinceCheck++;
    const final = index === order.length - 1;
    if (final) checkpoints.push({ index, node, sources: allSources, final });
    else if (sinceCheck >= batch && available.length !== lastCount) {
      checkpoints.push({ index, node, sources: [...available], final });
      lastCount = available.length;
      sinceCheck = 0;
    }
  }
  const levelOf = new Map();
  checkpoints.forEach((checkpoint, level) => {
    for (const source of checkpoint.sources)
      if (!levelOf.has(source.id)) levelOf.set(source.id, level);
  });
  return { plan, nodes, order, sources, context, allSources, checkpoints, levelOf };
}

/** The views every check of an exploration reads: the material and inference
 * of all its sources, with the others withheld, so the checks share one
 * inference. A checkpoint's view reads what holds from the support levels of
 * the full base, so no check needs another; a bounded inference supplies
 * nothing. */
export function explorationViews(project, input, result, exploration, { grammarCache, knowledge }) {
  const { context, allSources, checkpoints, levelOf } = exploration;
  let full = null,
    fullIds = null,
    levels = null,
    view = null;
  // The checkpoint whose sources are exactly these, read from the levels.
  const holdingAt = (present) => {
    if (!full.inference.complete) return null;
    let level = 0;
    for (const id of present) if (levelOf.has(id)) level = Math.max(level, levelOf.get(id));
    if ([...present].filter((id) => levelOf.has(id)).length !== checkpoints[level].sources.length)
      return null;
    levels ??= supportLevels(proofGraph(full.inference.facts), (id) =>
      levelOf.has(id) ? levelOf.get(id) : 0,
    ).facts;
    const holding = new Uint8Array(levels.length);
    for (let f = 0; f < levels.length; f++) holding[f] = levels[f] <= level ? 1 : 0;
    return holding;
  };
  return {
    knowledge,
    of: (recording) => {
      if (!full) {
        const key = JSON.stringify([
          project.digest,
          input.scopePlacementId,
          context
            .filter((item) => item.kind !== 'question')
            .map((item) => [item.id, item.revision ?? null, item.text, item.penman ?? null]),
          allSources.map((item) => [item.id, item.revision ?? null, item.penman ?? null]),
        ]);
        full = fullBases.get(key);
        if (!full) {
          full = answerBase(
            answerRecording(
              project,
              { ...input, sources: allSources },
              { ...result, inputs: [...allSources, ...context] },
            ),
            knowledge,
            { grammarCache },
          );
          fullBases.set(key, full);
          while (fullBases.size > keepBases) fullBases.delete(fullBases.keys().next().value);
        }
      }
      fullIds ??= new Set(full.recording.sources.map((source) => source.id));
      const present = new Set(recording.sources.map((source) => source.id));
      const withheld = full.material.sources
        .map((source) => source.id)
        .filter((id) => !present.has(id));
      if (recording.sources.some((source) => !fullIds.has(source.id))) return null;
      if (!withheld.length) return full;
      const key = withheld.join('\u0000');
      if (view?.key !== key) view = { key, base: withheldBase(full, withheld, holdingAt(present)) };
      return view.base;
    },
  };
}

/** One checkpoint checked on its own: its record (without its place among the
 * checks) and its answer. Every check reads the same retained grammars, so
 * none depends on another and they may run in any order or apart. */
export function checkCheckpoint(project, input, result, exploration, level, options = {}) {
  const checkpoint = exploration.checkpoints[level];
  const knowledge = options.knowledge ?? knowledgeSnapshot(project.data);
  const supplied =
    options.supplied ??
    explorationViews(project, input, result, exploration, {
      grammarCache: options.grammarCache,
      knowledge,
    });
  const checked = checkpoint.sources;
  const at = performance.now();
  const answer = checkAnswer(
    project,
    { ...input, sources: checked },
    { ...result, inputs: [...checked, ...exploration.context] },
    { grammarCache: options.grammarCache, knowledge, supplied },
  );
  return {
    answer,
    check: {
      nodeId: checkpoint.node.id,
      level,
      visitedRoles: checkpoint.index + 1,
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
      elapsedMs: performance.now() - at,
    },
  };
}

export async function exploreRoles(
  project,
  input,
  result,
  { grammarCache, signal, phase = async () => {} } = {},
) {
  const exploration = explorationPlan(input, result);
  const { nodes, order, sources, checkpoints } = exploration;
  const knowledge = knowledgeSnapshot(project.data);
  const supplied = explorationViews(project, input, result, exploration, {
    grammarCache,
    knowledge,
  });
  const checks = [],
    checkAt = new Map();
  let answer,
    proofFound = false;
  const started = performance.now();
  for (const [level, checkpoint] of checkpoints.entries()) {
    signal?.throwIfAborted();
    // Past the first proof only the final checkpoint is checked, and only
    // when it holds other sources than the last check.
    if (proofFound && !checkpoint.final) continue;
    const last = checks.at(-1);
    if (
      checkpoint.final &&
      last &&
      last.sourceIds.length === checkpoint.sources.length &&
      checkpoint.sources.every((source, i) => last.sourceIds[i] === source.id)
    )
      continue;
    await phase(
      'role-answer',
      `Checking ${nodes.get(checkpoint.node.id).label} (${checkpoint.index + 1}/${order.length} roles)`,
    );
    await yieldTurn(undefined, { signal });
    const checked = checkCheckpoint(project, input, result, exploration, level, {
      grammarCache,
      knowledge,
      supplied,
    });
    answer = checked.answer;
    checks.push({ id: checks.length, ...checked.check });
    checkAt.set(checkpoint.index, checks.at(-1).id);
    proofFound ||= answer.complete && answer.answers.length > 0;
  }
  const visits = [],
    available = [];
  let outgoing = null;
  for (const [index, node] of order.entries()) {
    const local = sources.get(node.id) ?? [];
    available.push(...local);
    const incoming = outgoing;
    if (checkAt.has(index)) outgoing = checkAt.get(index);
    visits.push({
      nodeId: node.id,
      parentId: node.parentId,
      incomingCheck: incoming,
      outgoingCheck: outgoing,
      sourceIds: local.map((s) => s.id),
    });
    if (index % 128 === 0) await yieldTurn(undefined, { signal });
  }
  if (!answer) throw new Error('The role exploration did not check this question');
  return {
    answer,
    exploration: {
      profile: explorationRecordProfile,
      ordering: exploration.plan.routing.status === 'matched' ? 'embedding-ranked' : 'authored',
      routing: exploration.plan.routing,
      visits,
      checks,
      complete: available.length === result.inputs.filter((i) => i.kind === 'source').length,
      elapsedMs: performance.now() - started,
    },
  };
}
