/** Statements written in the workbench are contributions: a check cites them as
 * `contribution:<id>:<part>` and their reading travels with them. Recoil and the
 * opportunity tree read them as they read imported passages. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { addConcept, createProject } from '../../src/project/authoring/project.mjs';
import { recoil } from '../../src/project/inquiries/recoil.mjs';
import { opportunityTree } from '../../src/project/inquiries/juxtaposition.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/contribution-statements-'));
try {
  const project = await createProject(join(directory, 'project'), 'Payments', 'Incident');
  let data = project.data;
  const root = data.placements[0].id;
  const role = (name) => {
    const added = addConcept(data, root, name);
    data = added.data;
    return added.placementId;
  };
  const security = role('Security');
  const release = role('Release');
  const graph = (concept) => ({
    top: 'z0',
    nodes: [{ id: 'z0', concept, surfaceLabel: concept.replace(/-\d+$/u, '') }],
    edges: [],
  });
  const statement = (placementId, id, text, concept) => ({
    version: 1,
    kind: 'material',
    id,
    scopePlacementId: placementId,
    question: null,
    responses: [{ id: 'r1', text, graph: graph(concept), at: '2026-10-25T00:00:00.000Z' }],
    wordings: [],
  });
  const reports = 'Priya reports a leaked key.',
    freezes = 'Morgan freezes deployments.';
  data = {
    ...data,
    contributions: [
      statement(security, 'c1', reports, 'report-01'),
      statement(release, 'c2', freezes, 'freeze-01'),
    ],
  };
  const cite = (id) => `contribution:${id}:r1`;
  const digest = 'revision-1';
  const run = (id, text, answers) => ({
    id,
    questions: [{ text }],
    scopePlacementId: root,
    purpose: 'inquiry',
    projectDigest: digest,
    startedAt: `2026-10-25T00:00:0${id.at(-1)}Z`,
    status: 'supported',
    answer: { answers, candidates: [], sources: [] },
  });
  const runs = [
    run('run-1', 'Who reports a leaked key?', [
      { text: 'Priya', sourceIds: [cite('c1')], ruleIds: [] },
    ]),
    run('run-2', 'Who reports a key, and who freezes deployments?', [
      { text: 'Priya, Morgan', sourceIds: [cite('c1'), cite('c2')], ruleIds: [] },
    ]),
  ];

  // No acquisition holds these texts: the reading is the contribution's own.
  const walk = recoil(
    { data, digest, runs, readings: new Set() },
    { kind: 'statement', text: reports },
  );
  assert.deepEqual(
    walk.frontier.filter((item) => item.reason === 'no reading'),
    [],
    'A statement written in the workbench carries its reading',
  );
  assert.deepEqual(
    walk.consequences.filter((visit) => visit.kind === 'question').map((visit) => visit.label),
    ['Who reports a leaked key?', 'Who reports a key, and who freezes deployments?'],
  );

  const tree = await opportunityTree(project, { context: { data, digest, runs } });
  assert.deepEqual(
    tree.questions.map((item) => [item.question, item.effect]),
    [
      ['Who reports a leaked key?', 'branch'],
      ['Who reports a key, and who freezes deployments?', 'juxtaposition'],
    ],
    'A cited contribution falls in its role branch',
  );
  assert.deepEqual(
    tree.tensions.map((line) => [line.labels.toSorted(), line.resolved]),
    [[['Release', 'Security'], ['Who reports a key, and who freezes deployments?']]],
  );
  console.log('ok contribution statements: recoil readings and opportunity-tree branches');
} finally {
  await rm(directory, { recursive: true, force: true });
}
