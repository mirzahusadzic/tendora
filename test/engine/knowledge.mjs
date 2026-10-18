/** Authored premises survive storage; independent clauses require an explicit shared referent. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import {
  createProject,
  saveProject,
  openProject,
  editConcept,
} from '../../src/project/authoring/project.mjs';
import {
  authorEngineKnowledge,
  knowledgeSnapshot,
} from '../../src/project/authoring/knowledge.mjs';
import { evaluateAnswer } from '../../src/recording/answers.mjs';
import { graphRevision } from '../../src/recording/revisions.mjs';
import { sourceCatalog } from '../../src/project/authoring/sources.mjs';

const graph = (id, top, nodes, edges) => ({
  id,
  top,
  nodes: Object.entries(nodes).map(([id, concept]) => ({ id, concept })),
  edges: edges.map(([from, role, to], index) => ({ id: `e${index}`, from, role, to })),
});
const left = graph('left', 'p', { p: 'probe-01', a: 'person', w: 'work-01' }, [
  ['p', ':ARG0', 'a'],
  ['p', ':ARG1', 'w'],
]);
const right = graph('right', 'm', { m: 'make-01', a: 'person', c: 'choice' }, [
  ['m', ':ARG0', 'a'],
  ['m', ':ARG1', 'c'],
]);
const query = graph(
  'q',
  'and',
  { and: 'and', p: 'probe-01', a: 'amr-unknown', w: 'work-01', m: 'make-01', c: 'choice' },
  [
    ['and', ':op1', 'p'],
    ['and', ':op2', 'm'],
    ['p', ':ARG0', 'a'],
    ['p', ':ARG1', 'w'],
    ['m', ':ARG0', 'a'],
    ['m', ':ARG1', 'c'],
  ],
);
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp('tmp/engine-knowledge-');
try {
  let project = await createProject(directory, 'Authored composition', 'Workshop');
  const scope = project.data.placements[0].id;
  project = await saveProject(
    project,
    editConcept(project.data, project.data.concepts[0].id, 'Workshop', [
      'The programmer probes the work.',
      'The programmer makes a choice.',
    ]),
  );
  const sources = sourceCatalog(project.data).map((source, index) => ({
    ...source,
    id: index ? 'right' : 'left',
    graphId: index ? 'right' : 'left',
  }));
  const recording = {
    inquiry: { text: 'Who probes the work and makes a choice?', graphId: 'q' },
    project: { placementId: scope },
    graphs: [query, left, right],
    sources,
  };
  assert.equal(
    evaluateAnswer(recording, knowledgeSnapshot(project.data)).status,
    'open',
    'Shared labels do not establish a shared referent',
  );
  const entry = {
    id: 'programmer-reference',
    kind: 'engine-knowledge',
    version: 1,
    name: 'The programmer in this workshop',
    attribution: 'Authored reading: both definite descriptions identify the same programmer.',
    scopePlacementId: scope,
    bindings: [
      {
        id: 'same-programmer',
        name: 'Recurring programmer',
        references: sources.map((source, index) => ({
          text: source.text,
          nodeId: scope,
          sourceNodeId: 'a',
          graphRevision: graphRevision(index ? right : left),
        })),
      },
    ],
  };
  project = await saveProject(project, authorEngineKnowledge(project.data, entry));
  project = await openProject(directory);
  const knowledge = knowledgeSnapshot(project.data);
  const result = evaluateAnswer(recording, knowledge);
  assert.equal(result.status, 'supported');
  assert.equal(result.answers[0].text, 'person');
  assert.equal(result.answers[0].composition.rule, 'and-introduction-v1');
  assert.equal(result.answers[0].composition.premises.length, 2);
  assert.deepEqual(new Set(result.answers[0].sourceIds), new Set(['left', 'right']));
  assert.deepEqual(result.answers[0].bindingIds, ['programmer-reference/same-programmer']);
  assert.equal(evaluateAnswer(recording, { ...knowledge, bindings: [] }).status, 'open');
  const removed = { ...recording, sources: sources.slice(0, 1) };
  assert.equal(evaluateAnswer(removed, knowledge).status, 'open');
  const changed = structuredClone(recording);
  changed.graphs[2].edges[1].role = ':ARG2';
  const obsolete = evaluateAnswer(changed, knowledge);
  assert.equal(obsolete.status, 'open');
  assert(obsolete.skipped.some((item) => item.kind === 'reference changed or unavailable'));
  assert.equal(
    evaluateAnswer(
      { ...recording, sources: [...sources].reverse(), graphs: [...recording.graphs].reverse() },
      knowledge,
    ).status,
    'supported',
  );
  assert.equal(
    evaluateAnswer({ ...recording, project: { placementId: 'other' } }, knowledge).status,
    'open',
    'Authored references do not escape placement scope',
  );
  const removedScope = knowledgeSnapshot({ ...project.data, placements: [] });
  assert.equal(removedScope.bindings.length, 0);
  assert(removedScope.skipped.some((entry) => entry.kind === 'knowledge scope unavailable'));
  const contrast = structuredClone(recording);
  contrast.graphs[0].nodes[0].concept = 'contrast-01';
  contrast.graphs[0].edges[0].role = ':ARG1';
  contrast.graphs[0].edges[1].role = ':ARG2';
  assert.equal(
    evaluateAnswer(contrast, knowledge).status,
    'open',
    'Two facts do not establish a contrast relation',
  );
  for (const role of [':polarity', ':condition']) {
    const guarded = structuredClone(recording);
    guarded.graphs[0].nodes.push({
      id: 'guard',
      concept: role === ':polarity' ? '-' : 'condition',
    });
    guarded.graphs[0].edges.push({ id: 'guard', from: 'and', role, to: 'guard' });
    assert.equal(
      evaluateAnswer(guarded, knowledge).status,
      'open',
      'A conjunction guard cannot disappear during goal decomposition',
    );
  }
  assert.throws(
    () => authorEngineKnowledge(project.data, { ...entry, scopePlacementId: 'absent' }),
    /scope/u,
  );
  assert.throws(
    () =>
      authorEngineKnowledge(project.data, {
        ...entry,
        rules: [
          { id: 'invalid', name: 'Invalid', when: [['?x', 'p', 'v']], then: [['?y', 'q', 'v']] },
        ],
      }),
    /variable/u,
  );
  console.log(
    'ok stored scoped knowledge, shared-reference composition, source/revision ablations, sentence order and guarded conjunction goals',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
