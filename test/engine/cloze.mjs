/** A cloze probe asks a statement's own relation back with one participant, or
 * its truth, unknown, from its reading alone; the corpus recovers the blank
 * from the statement, from others too, or not at all. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, editConcept } from '../../src/project/authoring/project.mjs';
import { checkProbe, clozeProbes, outcome } from '../../src/engine/cloze.mjs';

const graph = (top, nodes, edges) => ({
  top,
  nodes: Object.entries(nodes).map(([id, concept]) => ({ id, concept })),
  edges: edges.map(([from, role, to], i) => ({ id: `e${i}`, from, role, to })),
});
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/cloze-'));
try {
  const project = await createProject(join(directory, 'project'), 'Workshop', 'Work');
  const root = project.data.placements[0].id;
  const inspects = (id, text, who) => ({
    id: `${root}/${id}`,
    kind: 'source',
    placementId: root,
    text,
    graph: graph('i', { i: 'inspect-01', p: who, l: 'lift' }, [
      ['i', ':ARG0', 'p'],
      ['i', ':ARG1', 'l'],
    ]),
  });
  const technician = inspects('s1', 'The technician inspects the lift.', 'technician');
  const engineer = inspects('s2', 'The engineer inspects the lift.', 'engineer');
  const again = inspects('s3', 'A technician inspects the lift.', 'technician');
  const unbroken = {
    id: `${root}/s4`,
    kind: 'source',
    placementId: root,
    text: 'The seal is not broken.',
    graph: graph('b', { b: 'break-01', s: 'seal', n: '-' }, [
      ['b', ':ARG1', 's'],
      ['b', ':polarity', 'n'],
    ]),
  };
  const broken = {
    id: `${root}/s5`,
    kind: 'source',
    placementId: root,
    text: 'The seal is broken.',
    graph: graph('b', { b: 'break-01', s: 'seal' }, [['b', ':ARG1', 's']]),
  };
  const may = {
    id: `${root}/s6`,
    kind: 'source',
    placementId: root,
    text: 'A welder may repair the gate.',
    graph: graph('m', { m: 'possible-01', r: 'repair-01', w: 'welder', g: 'gate' }, [
      ['m', ':ARG1', 'r'],
      ['r', ':ARG0', 'w'],
      ['r', ':ARG1', 'g'],
    ]),
  };
  const conditional = {
    id: `${root}/s7`,
    kind: 'source',
    placementId: root,
    text: 'If the alarm sounds, the crew leaves the hall.',
    graph: graph('l', { l: 'leave-11', c: 'crew', h: 'hall', s: 'sound-01', a: 'alarm' }, [
      ['l', ':ARG0', 'c'],
      ['l', ':ARG1', 'h'],
      ['l', ':condition', 's'],
      ['s', ':ARG1', 'a'],
    ]),
  };
  const result = {
    inputs: [technician, engineer, again, unbroken, broken, may, conditional],
  };
  // The statements are the root's own, so the project's catalog holds them.
  const concept = project.data.concepts.find(
    (item) => item.id === project.data.placements[0].conceptId,
  );
  project.data = editConcept(
    project.data,
    concept.id,
    concept.name,
    result.inputs.map((item) => item.text),
  );
  const input = { projectRevision: project.digest, scopePlacementId: root, caseSelection: null };
  const check = (probe, withhold = []) =>
    checkProbe(project, input, result, probe, { withhold }).outcome;

  const probes = clozeProbes(technician);
  assert.deepEqual(
    probes.map((probe) => [probe.kind, probe.role ?? probe.expected]),
    [
      ['participant', ':ARG0'],
      ['participant', ':ARG1'],
      ['truth', 'Yes'],
    ],
  );
  const [who] = probes;
  assert(!who.graph.nodes.some((node) => node.concept === 'technician'), 'The blank is removed');
  assert(who.graph.edges.some((edge) => edge.role === ':ARG0' && edge.to === 'cloze'));
  assert.equal(check(who, [again.id, broken.id, unbroken.id]), 'recovered');
  assert.equal(check(who), 'also elsewhere', 'A technician inspects the lift too');
  assert.equal(
    check(who, [technician.id, again.id]),
    'otherwise',
    'Without the statement, another participant answers; the blank is not recovered',
  );
  assert.equal(check(who, [technician.id, again.id, engineer.id]), 'open');

  const truth = clozeProbes(unbroken).find((probe) => probe.kind === 'truth');
  assert.equal(truth.expected, 'No', 'A negated statement asks back to No');
  assert(!truth.graph.nodes.some((node) => node.concept === '-'));
  assert.equal(check(truth, [broken.id]), 'recovered');
  assert.equal(check(truth), 'conflict', 'The seal is broken answers it the other way');
  // A modal frame's participants are those of the relation it frames.
  const framed = clozeProbes(may);
  assert.deepEqual(
    framed
      .filter((probe) => probe.kind === 'participant')
      .map((probe) => [probe.role, probe.framed]),
    [
      [':ARG0', 'possible-01'],
      [':ARG1', 'possible-01'],
    ],
  );
  assert(framed[0].graph.edges.some((edge) => edge.from === 'r' && edge.to === 'cloze'));
  assert.equal(check(framed[0]), 'recovered', 'Who may repair the gate?');
  // A search that stops at its bound settles nothing: limited, never open.
  assert.equal(outcome(who, { status: 'limited', answers: [], candidates: [] }).outcome, 'limited');
  // A conditional statement asked without its condition is marked, not open.
  const [crew] = clozeProbes(conditional);
  assert.equal(crew.conditional, true);
  assert(
    !crew.graph.nodes.some((node) => node.concept === 'sound-01'),
    'The condition is the case',
  );
  assert.equal(crew.case.top, 's');
  assert.equal(
    check(crew),
    'recovered',
    'Asked with its condition as the case, the rule read from the statement answers',
  );
  assert.equal(check(crew, [conditional.id]), 'conditional');
  // Only when the alarm sounds: necessary, so nothing is expected back from it.
  const onlyWhen = structuredClone(conditional);
  onlyWhen.graph.nodes.push({ id: 'o', concept: 'only' });
  onlyWhen.graph.edges.push({ id: 'eo', from: 's', role: ':mod', to: 'o' });
  const [necessary] = clozeProbes(onlyWhen);
  assert.equal(necessary.necessary, true);
  assert.equal(
    check(necessary, [conditional.id]),
    'necessary',
    'A necessary condition is not read as sufficient',
  );
  console.log(
    'ok cloze probes: participants and truth asked back from the reading; recovered, elsewhere, otherwise, open and conflict',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
