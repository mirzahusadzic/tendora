/** Experimental reuse must not turn cache hits or lexical resemblance into evidence. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createRetainedPreparation,
  lexicalInterfaces,
  questionFocus,
} from '../../tools/support/deterministic-reuse.mjs';
import { propbankAuditor } from '../../src/models/propbank.mjs';

await mkdir('evaluations/test-runs', { recursive: true });
const directory = await mkdtemp(resolve('evaluations/test-runs/retained-preparation-'));
const project = { path: join(directory, 'project.json') };
const graph = {
  top: 'p',
  nodes: [
    { id: 'p', concept: 'photograph-01' },
    { id: 'a', concept: 'person' },
    { id: 'o', concept: 'comet' },
  ],
  edges: [
    { id: 'a0', from: 'p', role: ':ARG0', to: 'a' },
    { id: 'a1', from: 'p', role: ':ARG1', to: 'o' },
  ],
};
const source = (id) => ({
  id,
  kind: 'source',
  revision: 'v1',
  text: 'Someone photographs a comet.',
  acquisition: { status: 'retained', penman: '(frozen)' },
});
const inquiry = {
  id: 'q',
  kind: 'question',
  revision: 'q1',
  text: 'Who photographs a comet?',
  graph: {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === 'a' ? { ...n, concept: 'amr-unknown' } : n)),
  },
};
const input = { sources: [source('s1'), source('s2')], cases: [], question: inquiry };
const original = structuredClone(input);
let preparedCount = 0;
const prepare = async (items) => {
  preparedCount += items.length;
  return {
    results: items.map(() => ({ ok: true, graph: structuredClone(graph), penman: '(frozen)' })),
  };
};
try {
  let reuse = await createRetainedPreparation(project, { prepare });
  const first = await reuse(input);
  assert.equal(first.stats.sourcePrepared, 2);
  assert.equal(first.stats.sourceReused, 0);
  assert.equal(preparedCount, 2);
  assert.equal(first.stats.focus.type, 'who-answer');
  assert(
    first.input.sources[0].graph.nodes
      .find((n) => n.id === 'a')
      .semanticTypes.includes('who-answer'),
  );
  assert.deepEqual(input, original, 'The frozen input is immutable');
  reuse = await createRetainedPreparation(project, { prepare });
  const warm = await reuse(input);
  assert.equal(warm.stats.sourcePrepared, 0);
  assert.equal(warm.stats.sourceReused, 2);
  assert.equal(preparedCount, 2);
  assert.deepEqual(first.input, warm.input, 'Reload preserves the complete source meaning');
  for (const mutate of [
    (s) => {
      s.revision = 'v2';
    },
    (s) => {
      s.text = 'Someone photographs the comet.';
    },
    (s) => {
      s.acquisition.penman = '(different capture)';
    },
    (s) => {
      s.graph = {
        ...graph,
        nodes: graph.nodes.map((n) => (n.id === 'o' ? { ...n, concept: 'moon' } : n)),
      };
    },
  ]) {
    const changed = structuredClone(input);
    mutate(changed.sources[0]);
    const next = await reuse(changed);
    assert.equal(next.stats.sourcePrepared, 1);
    assert.equal(next.stats.sourceReused, 1);
    assert.equal(
      next.stats.interfaces.find((r) => r.inputId === 's2').key,
      first.stats.interfaces.find((r) => r.inputId === 's2').key,
    );
  }
  const withdrawn = await reuse({ ...input, sources: input.sources.slice(1) });
  assert.deepEqual(
    withdrawn.input.sources.map((s) => s.id),
    ['s2'],
  );
  const newQuestion = { ...inquiry, id: 'q2', text: 'Where does someone photograph a comet?' };
  const changedFocus = await reuse({ ...input, question: newQuestion });
  assert.equal(changedFocus.stats.sourcePrepared, 0);
  assert.equal(changedFocus.stats.questionPrepared, 1);
  assert.equal(changedFocus.stats.focus, null, 'Location is governed by the represented relation');

  const lexical = { ...(await propbankAuditor()), organizations: new Set() };
  const spelling = {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === 'p' ? { ...n, concept: 'catalog-01' } : n)),
  };
  assert.equal(
    lexicalInterfaces(spelling, 'Someone catalogs a comet.', lexical).graph.nodes[0].concept,
    'catalogue-01',
  );
  for (const concept of ['return-01', 'return-02', 'catalog-99']) {
    const distinct = {
      ...spelling,
      nodes: spelling.nodes.map((n) => (n.id === 'p' ? { ...n, concept } : n)),
    };
    assert.equal(
      lexicalInterfaces(distinct, '', lexical).graph.nodes[0].concept,
      concept,
      'Never merge senses',
    );
  }
  const extraRole = {
    ...spelling,
    edges: spelling.edges.map((e) => (e.id === 'a1' ? { ...e, role: ':ARG9' } : e)),
  };
  assert.equal(lexicalInterfaces(extraRole, '', lexical).aliases.length, 0);
  assert.deepEqual(
    lexicalInterfaces(spelling, '', lexical).graph.edges,
    spelling.edges,
    'Roles and guards are unchanged',
  );
  assert.equal(questionFocus(inquiry.graph, 'What photographs a comet?').focus, null);
  const multiple = {
    ...inquiry.graph,
    nodes: [...inquiry.graph.nodes, { id: 'u2', concept: 'amr-unknown' }],
    edges: [...inquiry.graph.edges, { id: 'u2e', from: 'p', role: ':location', to: 'u2' }],
  };
  assert.equal(questionFocus(multiple, 'Who photographs a comet where?').focus, null);
  console.log(
    'ok deterministic experiment: source reuse after reload, selective revision invalidation, withdrawal, unchanged roles/senses and explicit question focus',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
