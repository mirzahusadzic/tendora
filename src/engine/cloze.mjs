/** Cloze probes: a statement's own relation asked back with one participant, or
 * its truth, unknown. A probe is built from the statement's reading, a question
 * graph, never from generated text, and is checked against the retained
 * readings of a saved check, with no acquisition and no settling: no shared
 * wording, no reference reading, no proposals.
 *
 * What comes back shows whether the corpus recovers the blank from the
 * statement itself, from other statements too, or not at all. Not at all means
 * the engine cannot use the statement's reading even for its own content.
 * Probes propose where to ask and what to reword; they answer nothing, and a
 * question worth keeping is worded by the author.
 */
import { answerBase, evaluateAnswer, withheldBase } from '../recording/answers.mjs';
import { knowledgeSnapshot } from '../project/authoring/knowledge.mjs';
import { answerRecording } from './answer.mjs';
import { onlyClause, onlyTimeCondition } from '../amr/conditions.mjs';

const argument = /^:ARG\d$/u;
// The circumstances of a relation are variables too: when, where, how, why,
// with what, from where, under what, for whom. A condition is asked as a case.
const circumstance = new Set([
  ':time',
  ':location',
  ':manner',
  ':purpose',
  ':cause',
  ':instrument',
  ':path',
  ':source',
  ':destination',
  ':beneficiary',
  ':duration',
  ':frequency',
  ':extent',
  ':accompanier',
]);
const variable = (role) => argument.test(role) || circumstance.has(role) || /^:prep-/u.test(role);
const structural = new Set(['amr-unknown', 'and', 'or', '-', '+']);
// A modal frame asserts what may, must or should hold; its participants are
// those of the relation it frames.
const modal = new Set(['possible-01', 'obligate-01', 'recommend-01', 'permit-01']);

/** The probes of one source: each core participant of its asserted relation,
 * then its truth. A conditional statement is a rule; its probes ask the
 * consequent with the condition as their case. */
export function clozeProbes(source) {
  if (!source.graph) return [];
  const top = source.graph.assertionTop ?? source.graph.top;
  // A necessary condition read as a time (“only when”) is a condition too.
  const condition = source.graph.edges.find(
    (edge) =>
      edge.from === top &&
      (edge.role === ':condition' || onlyTimeCondition(source.graph, top, edge)),
  );
  const graph = condition ? consequent(source.graph, top, condition) : source.graph;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  let relation = top;
  for (let frame; modal.has(nodes.get(relation)?.concept); relation = frame) {
    frame = graph.edges.find((edge) => edge.from === relation && edge.role === ':ARG1')?.to;
    if (!/-\d+$/u.test(nodes.get(frame)?.concept ?? '')) break;
  }
  // “Only when X, Y” is necessary, not sufficient: nothing follows from X alone.
  const necessary = condition && onlyClause(source.graph, condition.to);
  const conditional = condition
    ? { case: conditionGraph(source.graph, top, condition), ...(necessary ? { necessary } : {}) }
    : null;
  const probes = [];
  for (const edge of graph.edges) {
    const target = nodes.get(edge.to);
    if (
      edge.from !== relation ||
      !variable(edge.role) ||
      !target ||
      target.literal !== undefined ||
      structural.has(target.concept)
    )
      continue;
    // The participant goes with its description: whatever stays connected to
    // the relation only through it.
    const kept = connected(graph, top, edge.to);
    probes.push({
      id: `${source.id}:${edge.role.slice(1)}`,
      sourceId: source.id,
      kind: argument.test(edge.role) ? 'participant' : 'circumstance',
      role: edge.role,
      blank: edge.to,
      ...(relation !== top ? { framed: nodes.get(top).concept } : {}),
      ...(conditional
        ? {
            conditional: true,
            case: conditional.case,
            ...(conditional.necessary ? { necessary: true } : {}),
            // A rule read from the statement names its nodes by position
            // (amr/conditions.mjs); a conclusion binds that name.
            derived: `$c${source.graph.nodes.findIndex((node) => node.id === edge.to)}`,
          }
        : {}),
      graph: {
        ...graph,
        nodes: [
          ...graph.nodes.filter((node) => kept.has(node.id)),
          { id: 'cloze', concept: 'amr-unknown' },
        ],
        edges: [
          ...graph.edges.filter((other) => kept.has(other.from) && kept.has(other.to)),
          { id: 'cloze-edge', from: relation, role: edge.role, to: 'cloze' },
        ],
      },
    });
  }
  const negation = graph.edges.find(
    (edge) => edge.from === top && edge.role === ':polarity' && nodes.get(edge.to)?.concept === '-',
  );
  probes.push({
    id: `${source.id}:truth`,
    sourceId: source.id,
    kind: 'truth',
    expected: negation ? 'No' : 'Yes',
    ...(conditional
      ? {
          conditional: true,
          case: conditional.case,
          ...(conditional.necessary ? { necessary: true } : {}),
        }
      : {}),
    graph: {
      ...graph,
      nodes: [
        ...graph.nodes.filter((node) => node.id !== negation?.to),
        { id: 'cloze', concept: 'amr-unknown' },
      ],
      edges: [
        ...graph.edges.filter((edge) => edge !== negation),
        { id: 'cloze-edge', from: top, role: ':polarity', to: 'cloze' },
      ],
    },
  });
  return probes;
}

/** A conditional statement without its condition: what it says holds. */
function consequent(graph, top, condition) {
  const kept = connected(graph, top, condition.to, condition);
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => kept.has(node.id)),
    edges: graph.edges.filter(
      (edge) => edge !== condition && kept.has(edge.from) && kept.has(edge.to),
    ),
  };
}
/** The condition of a conditional statement, as a case statement's reading. */
function conditionGraph(graph, top, condition) {
  const kept = connected(graph, condition.to, top, condition);
  return {
    top: condition.to,
    nodes: graph.nodes.filter((node) => kept.has(node.id)),
    edges: graph.edges.filter(
      (edge) => edge !== condition && kept.has(edge.from) && kept.has(edge.to),
    ),
  };
}

function connected(graph, start, removed, skip = null) {
  const kept = new Set([start]);
  for (const id of kept)
    for (const edge of graph.edges) {
      if (edge === skip) continue;
      const next = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
      if (next && next !== removed && !kept.has(next)) kept.add(next);
    }
  return kept;
}

/** Check one probe against a saved check's retained readings. `withhold` leaves
 * sources out, for carriage: does anything else recover the blank? */
// Probes of one check share its material and inference: a probe's question
// is not part of its material (no interpretation was made for a probe), so one
// base serves every probe without a case, and a withheld view of it serves
// every probe that withholds the same statements.
const bases = new WeakMap();
function probeBase(result, knowledge, key, make) {
  if (!bases.has(result)) bases.set(result, new WeakMap());
  const byKnowledge = bases.get(result);
  if (!byKnowledge.has(knowledge)) byKnowledge.set(knowledge, new Map());
  const kept = byKnowledge.get(knowledge);
  if (!kept.has(key)) {
    // The full base stays; of the withheld views, only the latest: the probes
    // that withhold one statement come together.
    for (const other of kept.keys()) if (other !== '') kept.delete(other);
    kept.set(key, make());
  }
  return kept.get(key);
}

export function checkProbe(project, input, result, probe, { withhold = [], ...options } = {}) {
  const question = {
    id: `cloze:${probe.id}`,
    kind: 'question',
    text: '',
    revision: probe.id,
    graph: probe.graph,
  };
  // A conditional statement is asked with its condition as the only case.
  const caseStatement = probe.case && {
    id: 'case-cloze/s1',
    kind: 'case',
    placementId: 'case-cloze',
    text: `The condition of ${probe.sourceId}`,
    graph: probe.case,
  };
  const knowledge = options.knowledge ?? knowledgeSnapshot(project.data);
  // Without a case, the probe is checked against the shared base, and what is
  // withheld is read from its proofs; with a case, or when the base was
  // bounded, against its own material without the withheld statements.
  const shared = !probe.case && options.knowledge;
  const full = (withheld) =>
    result.inputs.filter(
      (item) =>
        item.kind !== 'question' &&
        !(probe.case && item.kind === 'case') &&
        !withheld.includes(item.id),
    );
  const record = (inputs) =>
    answerRecording(
      project,
      {
        ...input,
        question: { text: '', revision: probe.id },
        ...(caseStatement
          ? {
              caseSelection: {
                projectId: project.data.id,
                placementId: caseStatement.placementId,
                sources: [{ text: caseStatement.text }],
              },
            }
          : {}),
      },
      { ...result, inputs: [...inputs, ...(caseStatement ? [caseStatement] : []), question] },
    );
  let recording, base;
  if (shared) {
    recording = record(full([]));
    base = probeBase(result, knowledge, '', () => answerBase(recording, knowledge, options));
    if (withhold.length) {
      const key = JSON.stringify([...withhold].sort());
      base = probeBase(result, knowledge, key, () => withheldBase(base, withhold));
    }
  }
  if (!base) recording = record(full(withhold));
  const answer = evaluateAnswer(recording, knowledge, {
    ...options,
    ...(base ? { base: { ...base, recording, knowledge, preparation: options.preparation } } : {}),
  });
  return {
    ...outcome(probe, answer),
    status: answer.status,
    // Probes of one check share its corpus; the next probe reuses its grammar.
    grammarCache: { profile: answer.grammar.profile, grammars: answer.grammar.corpora },
  };
}

/** recovered: the statement itself supplies the blank; also elsewhere: other
 * statements give the same answer too; elsewhere: only others give it (truth
 * probes); otherwise: answers, none of them the blank; open: nothing answers;
 * conditional: nothing answers a conditional statement asked without its
 * condition; necessary: a necessary condition (only when, only if), from
 * which nothing follows alone; limited: the search stopped at its bound before finding the
 * blank, which settles nothing; conflict: a truth probe is also answered the
 * other way. */
export function outcome(probe, answer) {
  // Several possible answers make a check ambiguous; each is still considered.
  const answers = [...(answer.answers ?? []), ...(answer.candidates ?? [])];
  const own = (binding) => binding.sourceIds.includes(probe.sourceId);
  const readFrom = (binding) =>
    binding.ruleIds?.some((id) => id.startsWith(`${probe.sourceId}/clause/`));
  const found =
    probe.kind !== 'truth'
      ? answers.filter((binding) =>
          binding.bindings?.some(
            (slot) =>
              slot.id === `${probe.sourceId}#${probe.blank}` ||
              (probe.derived && readFrom(binding) && slot.id.endsWith(`:${probe.derived}`)),
          ),
        )
      : answers.filter((binding) => binding.text === probe.expected);
  // Other statements count only for the same answer the statement gives.
  const texts = new Set(found.map((binding) => binding.text));
  const others = answers.filter((binding) => !own(binding) && texts.has(binding.text));
  const result =
    probe.necessary && !found.some(own)
      ? 'necessary'
      : probe.kind === 'truth' && answers.some((binding) => binding.text !== probe.expected)
        ? 'conflict'
        : found.some(own)
          ? others.length
            ? 'also elsewhere'
            : 'recovered'
          : found.length
            ? 'elsewhere'
            : answer.status === 'limited'
              ? 'limited'
              : answers.length
                ? 'otherwise'
                : probe.conditional
                  ? 'conditional'
                  : 'open';
  return {
    outcome: result,
    answers: answers.map((binding) => ({
      text: binding.text,
      sourceIds: binding.sourceIds,
      ...(binding.conditional ? { conditional: true } : {}),
    })),
  };
}
