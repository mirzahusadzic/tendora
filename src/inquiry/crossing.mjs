/** Recursive visits over authored links. Every node receives the same inquiry
 * graph and audits its own source sentences. Returns retain independent source
 * occurrences; paths found at different occurrences are never unioned.
 */
import { focus } from '../amr/graph.mjs';
import { inspectConjunction, inspectFocus } from '../amr/audit.mjs';
import { examineContext } from './context-carry.mjs';

const branchesOf = (audit) => audit.branches ?? [audit.branch];
const carryOf = (audit) => (audit.branches ? audit.carry : [audit.carry]);

// History is a persistent chain: descending thousands of nodes does not copy
// the whole ancestry into every inquiry frame.
export function historyItems(history) {
  const items = [];
  for (let item = history; item; item = item.previous) items.push(item.entry);
  return items.reverse();
}

/** Read a return from any depth by the same rule. Records are deduplicated by
 * source-event identity, never merged into a new graph witness.
 */
export function collect(returned) {
  const findings = new Map(),
    openings = new Map(),
    proposals = new Map(),
    cycles = [];
  const contextChecks = [];
  const stack = [returned];
  while (stack.length) {
    const item = stack.pop();
    for (const finding of item.findings) findings.set(finding.id, finding);
    for (const opening of item.openings)
      openings.set(
        JSON.stringify([
          opening.kind,
          opening.node,
          opening.sourceIndex,
          opening.op,
          opening.concept,
          opening.nodeUnlocated,
          opening.scope,
          opening.paths.map((path) => path.text),
        ]),
        opening,
      );
    for (const proposal of item.proposals) proposals.set(proposal.id, proposal);
    for (const cycle of item.cycles) cycles.push(cycle);
    for (const check of item.contextChecks ?? []) contextChecks.push({ node: item.node, ...check });
    for (const child of item.children) stack.push(child.returned);
  }
  return {
    findings: [...findings.values()],
    openings: [...openings.values()],
    proposals: [...proposals.values()],
    cycles,
    ...(contextChecks.length ? { contextChecks } : {}),
  };
}

/** An attributed parse revision may replace one exact surface span, never
 * silently regenerate the whole inquiry or change an unrelated participant.
 */
export function proposedEnglish(original, { from, to }) {
  const lower = original.toLocaleLowerCase('en');
  const needle = from.toLocaleLowerCase('en');
  const at = lower.indexOf(needle);
  if (at < 0) return null;
  if (lower.indexOf(needle, at + needle.length) >= 0)
    throw new Error(`ambiguous proposal span: ${from}`);
  const before = original[at - 1] ?? '',
    after = original[at + from.length] ?? '';
  if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) return null;
  return original.slice(0, at) + to + original.slice(at + from.length);
}

export function walk(nodes, start, inquiry) {
  if (!inquiry.graph || !nodes.has(start))
    throw new Error('walk needs a parsed inquiry and a start node');
  if (
    inquiry.caseState &&
    (!['ancestor-context-v1', 'selected-context-v2'].includes(inquiry.caseState.policy) ||
      (inquiry.caseState.policy === 'ancestor-context-v1' &&
        inquiry.caseState.rootNodeId !== start) ||
      !nodes.get(inquiry.caseState.rootNodeId)?.sources.length)
  )
    throw new Error('Invalid case state root');
  const initial =
    inspectConjunction(inquiry.graph, []) ?? inspectFocus(inquiry.graph, [], focus(inquiry.graph));
  const obligation = {
    branches: branchesOf(initial).map(({ op, concept, required, requiredRefs }) => ({
      op,
      concept,
      required,
      requiredRefs,
    })),
    parentContext: initial.parentContext ?? [],
    wholeOpening: initial.opening,
  };
  const frame = {
    id: inquiry.id,
    text: inquiry.text,
    graph: inquiry.graph,
    interpretation: inquiry.interpretation,
    amrModel: inquiry.amrModel,
    obligation,
    bindings: inquiry.bindings ?? [],
    history: null,
    ...(inquiry.caseState
      ? {
          caseState: inquiry.caseState,
          context:
            inquiry.caseState.rootNodeId !== start
              ? {
                  nodeId: inquiry.caseState.rootNodeId,
                  sources: nodes.get(inquiry.caseState.rootNodeId).sources,
                  previous: null,
                }
              : null,
        }
      : {}),
  };
  const state = JSON.stringify([frame.id, frame.interpretation, frame.obligation, frame.bindings]);
  const keyFor = (nodeId) => `${nodeId}\u0000${state}`;
  const active = new Set();

  function begin(nodeId, incoming) {
    const node = nodes.get(nodeId);
    if (!node) throw new Error(`crossing target ${nodeId} is not a node`);
    const sources = node.sources.map((source) => source.graph);
    const audit =
      inspectConjunction(incoming.graph, sources) ??
      inspectFocus(incoming.graph, sources, focus(incoming.graph));
    const findings = branchesOf(audit).flatMap((branch) =>
      branch.candidates.map((candidate) => ({
        id: `${incoming.interpretation}/${nodeId}/${candidate.sourceIndex}/${candidate.eventNode}/${branch.op ?? 'focus'}`,
        node: nodeId,
        sourceIndex: candidate.sourceIndex,
        source: node.sources[candidate.sourceIndex].text,
        queryAmrModel: incoming.amrModel,
        sourceAmrModel: node.sources[candidate.sourceIndex].amr
          ? `${node.sources[candidate.sourceIndex].amr.model}@${node.sources[candidate.sourceIndex].amr.revision}`
          : null,
        affinity: node.sources[candidate.sourceIndex].affinity,
        eventNode: candidate.eventNode,
        op: branch.op,
        concept: branch.concept,
        required: branch.required,
        requiredRefs: branch.requiredRefs,
        aligned: candidate.aligned,
        alignedRefs: candidate.alignedRefs,
        open: candidate.open,
        openRefs: candidate.openRefs,
        alternatives: candidate.alternatives,
        context: candidate.context,
        markers: candidate.markers,
        bindings: candidate.bindings,
      })),
    );
    // Preserve source identities while ranking inspection by inquiry similarity.
    // All events remain available; graph overlap does not set the ranking.
    findings.sort(
      (a, b) =>
        (b.affinity ?? -Infinity) - (a.affinity ?? -Infinity) || a.sourceIndex - b.sourceIndex,
    );
    const openings = [
      ...carryOf(audit).map((carry) => ({ kind: 'paths', node: nodeId, ...carry })),
      {
        kind: audit.branches ? 'parent' : 'question',
        node: nodeId,
        scope: audit.parentContext ?? [],
        opening: audit.opening,
        paths: [],
      },
      ...node.sources.flatMap((source, sourceIndex) =>
        source.graph
          ? []
          : [{ kind: 'source-parse', node: nodeId, sourceIndex, source: source.text, paths: [] }],
      ),
    ];
    const proposals = (node.proposals ?? []).map((proposal, i) => ({
      node: nodeId,
      id: `${nodeId}/proposal-${i + 1}`,
      baseInterpretation: incoming.interpretation,
      sourceIndex: proposal.sourceIndex,
      source: node.sources[proposal.sourceIndex].text,
      patch: proposal.patch,
      english: proposal.english,
      graph: proposal.graph, // a proposed alternative, never substituted for the inquiry
    }));
    const local = {
      findings,
      openings,
      proposals,
      sourceCount: node.sources.length,
      validSourceCount: sources.filter(Boolean).length,
      unchanged:
        !findings.length &&
        !proposals.length &&
        !openings.some((opening) => opening.kind === 'source-parse'),
    };
    if (incoming.caseState) {
      local.contextChecks = examineContext(incoming.context, node.sources, nodeId);
      if (local.contextChecks.some((check) => check.anchors.some((anchor) => anchor.shared.length)))
        local.unchanged = false;
    }
    // Children receive the original question plus attributed local history,
    // including the matched actor path—not merely the missing object path.
    const childFrame = {
      ...incoming,
      history: {
        previous: incoming.history,
        entry: { node: nodeId, findings, openings, proposals },
      },
      ...(incoming.caseState
        ? {
            context:
              node.sources.length &&
              !(nodeId === incoming.caseState.rootNodeId && inquiry.caseState.rootNodeId !== start)
                ? { previous: incoming.context, nodeId, sources: node.sources }
                : incoming.context,
          }
        : {}),
    };
    const result = { node: nodeId, kind: 'visit', incoming, local, children: [], returned: null };
    return { node, result, childFrame, next: 0, key: keyFor(nodeId) };
  }

  const root = begin(start, frame);
  active.add(root.key);
  const stack = [root];
  while (stack.length) {
    const current = stack[stack.length - 1];
    if (current.next < current.node.crossings.length) {
      const target = current.node.crossings[current.next++];
      const key = keyFor(target);
      if (active.has(key)) {
        const incoming = current.childFrame;
        current.result.children.push({
          target,
          result: {
            node: target,
            kind: 'cycle',
            incoming,
            returned: {
              node: target,
              findings: [],
              openings: [],
              proposals: [],
              cycles: [
                { node: target, history: historyItems(incoming.history).map((item) => item.node) },
              ],
              children: [],
            },
          },
        });
        continue;
      }
      const child = begin(target, current.childFrame);
      current.result.children.push({ target, result: child.result });
      active.add(child.key);
      stack.push(child);
      continue;
    }
    // A return contains local records and child returns by reference. No
    // ancestor copies or unions a grandchild's paths into a single witness.
    current.result.returned = {
      node: current.result.node,
      findings: current.result.local.findings,
      openings: current.result.local.openings,
      proposals: current.result.local.proposals,
      cycles: [],
      ...(current.result.local.contextChecks
        ? { contextChecks: current.result.local.contextChecks }
        : {}),
      children: current.result.children.map((child) => ({
        target: child.target,
        returned: child.result.returned,
      })),
    };
    active.delete(current.key);
    stack.pop();
  }
  return root.result;
}
