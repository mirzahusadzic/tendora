/** Bounded proposals for a language clarification. A proposal never asserts its question. */
import {
  answerSlots,
  compileWording,
  graphFacts,
  questionBranches,
  wordingAlignment,
} from './development.mjs';
import { inquiryPattern } from './patterns.mjs';
import { clauseFragments } from './clause-fragments.mjs';
import { conditionalReading } from './conditions.mjs';
import { createGrammarMatcher } from './hrg-query.mjs';
import { validateGraph } from './revision.mjs';

const rootConcept = (graph) => graph.nodes.find((n) => n.id === graph.top)?.concept;
const sameRoot = (a, b) =>
  a === b ||
  (/^.+-\d+$/u.test(a) &&
    /^.+-\d+$/u.test(b) &&
    a.replace(/-\d+$/u, '') === b.replace(/-\d+$/u, ''));
const label = (node, graph) => {
  if (node.authoredLabel || node.surfaceLabel) return node.authoredLabel ?? node.surfaceLabel;
  const name = graph.edges.find((e) => e.from === node.id && e.role === ':name'),
    parts =
      name &&
      graph.edges
        .filter((e) => e.from === name.to && /^:op\d+$/u.test(e.role))
        .sort((a, b) => Number(a.role.slice(3)) - Number(b.role.slice(3)))
        .map((e) => graph.nodes.find((n) => n.id === e.to)?.literal)
        .filter((value) => value !== undefined)
        .map((value) => {
          try {
            return JSON.parse(value);
          } catch {
            return value;
          }
        });
  return parts?.length ? parts.join(' ') : node.concept.replace(/-\d+$/u, '').replaceAll('-', ' ');
};
const bounded = (graph) => graph?.nodes?.length <= 128 && graph?.edges?.length <= 512;

/** Find rooted structural witnesses for a common concept. Different paths stay
 * visible as interpretation work; they are not promoted to semantic equality.
 */
function pathsFrom(graph) {
  const paths = new Map([[graph.top, []]]),
    queue = [graph.top],
    edges = [...graph.edges].sort(
      (a, b) => a.role.localeCompare(b.role) || a.id.localeCompare(b.id),
    );
  for (const id of queue) {
    for (const edge of edges) {
      const next = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
      if (next === null || paths.has(next)) continue;
      paths.set(next, [...paths.get(id), edge]);
      queue.push(next);
    }
  }
  return paths;
}

function contextAlignment(question, basis, matcher, account) {
  const sourcePaths = pathsFrom(basis.graph),
    questionPaths = pathsFrom(question),
    facts = graphFacts(basis.graph, basis.id),
    queryFacts = graphFacts(question, 'question'),
    contexts = [];
  const direction = (path, root) => {
    let at = root;
    return path.map((e) => {
      const role = `${e.from === at ? '' : '^'}${e.role}`;
      at = e.from === at ? e.to : e.from;
      return role;
    });
  };
  const witness = (graph, path, node, material) => {
    const variables = new Map(
        graph.nodes.map((n, i) => [n.id, n.id === graph.top ? graph.top : `?c${i}`]),
      ),
      patterns = [
        ...path.map((e) => [variables.get(e.from), e.role, variables.get(e.to)]),
        [variables.get(node.id), ':instance', node.concept],
        ...(node.literal !== undefined ? [[variables.get(node.id), '@literal', node.literal]] : []),
      ];
    const found = matcher.match(patterns, material, { limit: 16, budget: 5000, account });
    if (!found.complete) return null;
    return found.matches.find((m) => m.values[variables.get(node.id)] === node.id);
  };
  for (const node of question.nodes) {
    if (node.id === question.top || ['amr-unknown', 'amr-empty'].includes(node.concept)) continue;
    const queryPath = questionPaths.get(node.id);
    if (!queryPath?.length) continue;
    for (const candidate of basis.graph.nodes) {
      if (candidate.id === basis.graph.top || candidate.literal !== node.literal) continue;
      const sourcePath = sourcePaths.get(candidate.id);
      if (!sourcePath?.length) continue;
      const sourceRoles = direction(sourcePath, basis.graph.top),
        queryRoles = direction(queryPath, question.top),
        samePath = JSON.stringify(sourceRoles) === JSON.stringify(queryRoles);
      if (candidate.concept !== node.concept && !samePath) continue;
      const source = witness(basis.graph, sourcePath, candidate, facts),
        query = source && witness(question, queryPath, node, queryFacts);
      if (!source || !query) continue;
      contexts.push({
        questionNodeId: node.id,
        sourceNodeId: candidate.id,
        concept: node.concept,
        sourceConcept: candidate.concept,
        changedConcept: candidate.concept !== node.concept,
        samePath,
        sourceRoles,
        questionRoles: queryRoles,
        source: { witnesses: source.witnesses, derivation: source.derivation },
        question: { witnesses: query.witnesses, derivation: query.derivation },
      });
      if (contexts.length >= 12 || account.work >= account.limit) return contexts;
    }
  }
  return contexts;
}

/** Two participants described by different actions in the same role are
 * different participants: the intake registrar is not the collections
 * conservator. A descriptor that reappears elsewhere around the source
 * participant is a different reading of the same words, not a conflict.
 */
function descriptorConflict(question, questionNodeId, source, sourceNodeId) {
  const predicate = (graph, id) => /-\d+$/u.test(graph.nodes.find((n) => n.id === id)?.concept);
  const concept = (graph, id) => graph.nodes.find((n) => n.id === id)?.concept;
  const descriptors = (graph, id) =>
    graph.edges
      .filter((e) => e.to === id && e.from !== graph.top && predicate(graph, e.from))
      .map((e) => ({ role: e.role, concept: concept(graph, e.from) }));
  const around = new Set(),
    seen = new Set([sourceNodeId]),
    frontier = [sourceNodeId];
  for (let depth = 0; depth < 3; depth++)
    for (const id of frontier.splice(0)) {
      for (const e of source.edges) {
        const next = e.from === id ? e.to : e.to === id ? e.from : null;
        if (next === null || next === source.top || seen.has(next)) continue;
        seen.add(next);
        around.add(concept(source, next));
        frontier.push(next);
      }
    }
  const sourceDescriptors = descriptors(source, sourceNodeId);
  return descriptors(question, questionNodeId).some(
    (wanted) =>
      !around.has(wanted.concept) &&
      sourceDescriptors.some((d) => d.role === wanted.role && d.concept !== wanted.concept),
  );
}

/** Candidate paths may introduce an interpretation-local descriptive wrapper
 * around an existing answer. The wrapper must be an unqualified, unshared chain;
 * predicates, names and scope boundaries cannot be contracted this way.
 */
function answerPorts(question, source, slot, contexts, occupied) {
  const queryPath = pathsFrom(question).get(slot.id),
    paths = pathsFrom(source);
  if (!queryPath?.length) return [];
  const steps = (path, root) => {
    let at = root;
    return path.map((edge) => {
      const step = { id: at, role: `${edge.from === at ? '' : '^'}${edge.role}` };
      at = edge.from === at ? edge.to : edge.from;
      return step;
    });
  };
  const querySteps = steps(queryPath, question.top),
    same = (a, b) => a.length === b.length && a.every((step, i) => step.role === b[i].role);
  const ports = source.nodes
    .filter((n) => n.id !== source.top && n.literal === undefined && paths.has(n.id))
    .map((node) => {
      const path = steps(paths.get(node.id), source.top),
        exactRole = same(path, querySteps),
        prefix = path.length < querySteps.length && same(path, querySteps.slice(0, path.length)),
        suffix = querySteps.slice(path.length),
        expandable =
          prefix &&
          suffix.every((step) => {
            const n = question.nodes.find((n) => n.id === step.id);
            return (
              n.literal === undefined &&
              !/-\d+$/u.test(n.concept) &&
              ![':polarity', ':condition', ':concession', ':mode', ':name', ':wiki'].includes(
                step.role.replace(/^\^/u, ''),
              ) &&
              question.edges.filter((e) => e.from === n.id || e.to === n.id).length === 2
            );
          }) &&
          contexts
            .filter((c) => c.sourceNodeId === node.id && c.samePath)
            .every((c) => suffix.some((step) => step.id === c.questionNodeId) && c.changedConcept);
      return {
        id: node.id,
        exactRole,
        expandable,
        sibling: same(path.slice(0, -1), querySteps.slice(0, -1)),
        occupied: occupied.has(node.id),
        depth: path.length,
      };
    });
  const exact = ports.filter((p) => p.exactRole && !p.occupied);
  if (exact.length) return exact;
  const expanded = ports.filter((p) => p.expandable);
  if (expanded.length)
    return expanded.filter((p) => p.depth === Math.max(...expanded.map((p) => p.depth)));
  return answerSlots(question).length === 1 ? ports.filter((p) => p.sibling && !p.occupied) : [];
}

/** Propose existing participant ports for explicit author selection. The supplied
 * basis is retained asserted material; unresolved questions cannot be its evidence.
 * Candidate discovery may compare predicate lemmas, but generated rules retain
 * both exact senses and every explicit qualification.
 */
/** The question as denied, when it asks yes or no at its root and the source's
 * root is negated: the question gains the source's "-". Otherwise null. */
function denial(question, source, asksYesNo) {
  const negated = source.edges.some(
    (edge) =>
      edge.from === source.top &&
      edge.role === ':polarity' &&
      source.nodes.find((node) => node.id === edge.to)?.concept === '-',
  );
  if (
    !asksYesNo ||
    !negated ||
    question.edges.some((edge) => edge.from === question.top && edge.role === ':polarity')
  )
    return null;
  const id = 'denied-polarity';
  return {
    ...question,
    nodes: [...question.nodes, { id, concept: '-', literal: '-' }],
    edges: [...question.edges, { id: `${id}-edge`, from: question.top, role: ':polarity', to: id }],
  };
}

function proposeLocal(question, bases, { limit, account, asksYesNo = false }) {
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error('Correspondence limit must be a nonnegative integer.');
  if (!limit || !bounded(question)) return [];
  validateGraph(question);
  const slots = answerSlots(question);
  if (rootConcept(question) === 'amr-unknown') return [];
  const results = [],
    matcher = createGrammarMatcher(),
    maximum = Math.min(limit, 64);
  let attempts = 0;
  // The bound keeps the most relevant bases, when the caller ranks them.
  for (const basis of [...bases]
    .sort(
      (a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, 64)) {
    if (
      !basis.id ||
      basis.asserted === false ||
      basis.development?.asserted === false ||
      basis.withdrawn ||
      !bounded(basis.graph) ||
      basis.graph.nodes.some((n) => ['amr-unknown', 'amr-empty'].includes(n.concept))
    )
      continue;
    validateGraph(basis.graph);
    const conditional = conditionalReading(basis.graph);
    if (conditional?.reason) continue;
    const graph = conditional?.conclusion ?? basis.graph;
    if (!sameRoot(rootConcept(question), rootConcept(graph))) continue;
    // A yes/no question leaves its polarity open; a source that denies the
    // relation answers it No. The proposal is read against the question as
    // denied, so its rule carries the negation and nothing else moves.
    const denied = denial(question, graph, asksYesNo);
    const asked = denied ?? question;
    const contexts = contextAlignment(question, { ...basis, graph }, matcher, account);
    if (!contexts.length) continue;
    if (
      contexts.some(
        (c) => c.samePath && descriptorConflict(question, c.questionNodeId, graph, c.sourceNodeId),
      )
    )
      continue;
    const occupied = new Set(contexts.filter((c) => c.samePath).map((c) => c.sourceNodeId)),
      a = inquiryPattern(graph),
      b = inquiryPattern(question);
    let aligned;
    try {
      aligned = wordingAlignment(graph, asked, { perspective: true, account });
    } catch {
      continue;
    }
    const ids = Object.fromEntries(
      slots.map((slot) => [
        slot.id,
        [...a.variables].find(([, v]) => v === aligned.mapping.get(b.variables.get(slot.id)))?.[0],
      ]),
    );
    const available = [];
    if (slots.every((slot) => ids[slot.id])) {
      available.push({ answerNodeIds: ids, exactRole: true });
    } else if (slots.length) {
      const choices = slots.map((slot) => answerPorts(question, graph, slot, contexts, occupied));
      // Joint choices retain injectivity. Independent slots cannot select the
      // same source participant; a repeated query port is only one slot.
      const combine = (at, selected, exactRole) => {
        if (available.length >= 64) return;
        if (at === slots.length) {
          available.push({ answerNodeIds: selected, exactRole });
          return;
        }
        for (const port of choices[at]) {
          if (Object.values(selected).includes(port.id)) continue;
          combine(at + 1, { ...selected, [slots[at].id]: port.id }, exactRole && port.exactRole);
        }
      };
      combine(0, {}, true);
    }
    for (const { answerNodeIds, exactRole } of available) {
      if (++attempts > 128 || account.work >= account.limit) return results;
      let rule;
      try {
        rule = compileWording(basis.graph, asked, {
          perspective: true,
          answerNodeIds,
          isolated: true,
          account,
        });
      } catch {
        // Incompatible guards, values, and constrained answer descriptions are
        // boundaries to develop separately, never reasons to relax the compiler.
        continue;
      }
      const nodes = slots.map((slot) => graph.nodes.find((n) => n.id === answerNodeIds[slot.id]));
      results.push({
        basisId: basis.id,
        answerNodeId: nodes.length === 1 ? nodes[0].id : null,
        answerNodeIds,
        answerLabel: nodes.length
          ? nodes.map((node) => label(node, graph)).join(', ')
          : denied
            ? 'No'
            : 'This relationship',
        rule,
        alignment: {
          kind: 'candidate-context',
          asserted: false,
          exactRoot: rootConcept(question) === rootConcept(graph),
          exactAnswerRole: exactRole,
          conditional: Boolean(conditional),
          contexts,
          work: account.work,
        },
      });
      if (results.length >= maximum) return results;
    }
  }
  return results;
}

/** Each proposal names one independently asserted clause. A compound's other
 * branches remain unanswered; embedded conjunctions are never distributed.
 */
export function proposeCorrespondences(question, bases, { limit = 12 } = {}) {
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error('Correspondence limit must be a nonnegative integer.');
  if (!limit || !bounded(question)) return [];
  validateGraph(question);
  const asksYesNo = question.edges.some(
    (edge) =>
      edge.from === question.top &&
      edge.role === ':polarity' &&
      question.nodes.find((node) => node.id === edge.to)?.concept === 'amr-unknown',
  );
  const branches = questionBranches(question),
    results = [],
    account = { work: 0, limit: 100000 },
    maximum = Math.min(limit, 64);
  let attempts = 0;
  // The bound keeps the most relevant bases, when the caller ranks them.
  for (const basis of [...bases]
    .sort(
      (a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, 64)) {
    if (
      !bounded(basis.graph) ||
      !basis.id ||
      basis.asserted === false ||
      basis.development?.asserted === false ||
      basis.withdrawn ||
      basis.graph.nodes.some((n) => ['amr-unknown', 'amr-empty'].includes(n.concept))
    )
      continue;
    validateGraph(basis.graph);
    const sources = clauseFragments(basis.graph).fragments.filter((f) => f.kind === 'clause');
    for (const branch of branches)
      for (const source of sources) {
        if (++attempts > 128 || account.work >= account.limit) return results;
        const candidates = proposeLocal(branch.graph, [{ ...basis, graph: source.graph }], {
          limit: maximum - results.length,
          account,
          asksYesNo: branch.graph.top === question.top && asksYesNo,
        });
        for (const candidate of candidates) {
          const composite =
            branches.length > 1 || sources.length > 1 || answerSlots(branch.graph).length > 1;
          results.push({
            ...candidate,
            // The existing confirmation protocol treats this field as an opaque
            // selector. Composite selectors distinguish branches sharing a port.
            ...(composite
              ? {
                  answerNodeId: JSON.stringify([
                    branch.root,
                    source.root,
                    Object.entries(candidate.answerNodeIds).sort(),
                  ]),
                }
              : {}),
            questionRoot: branch.root,
            sourceRoot: source.root,
            alignment: {
              ...candidate.alignment,
              partial: branches.length > 1,
              ports: branch.ports,
            },
          });
          if (results.length >= maximum) return results;
        }
      }
  }
  return results;
}
