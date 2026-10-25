/** A checked question is quiet, a branch, or a juxtaposition of branches at a
 * grain; a tension line is resolved only when one answer composes statements
 * from both branches, gathered when separate answers reach each, and open when
 * only parts reach them; openings activate nothing. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { addConcept, createProject, editConcept } from '../../src/project/authoring/project.mjs';
import {
  activation,
  branchAt,
  opportunityTree,
} from '../../src/project/inquiries/juxtaposition.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/juxtaposition-'));
try {
  const project = await createProject(join(directory, 'project'), 'Workshop', 'Work');
  let data = project.data;
  const root = data.placements[0].id;
  const role = (name, parent) => {
    const added = addConcept(data, parent, name);
    data = added.data;
    return added.placementId;
  };
  const stage = role('Stage', root),
    office = role('Office', root),
    lift = role('Lift', stage);
  const at = (placement) => `${placement}/s1`;
  const branchOf = branchAt(data, 1);
  assert.equal(branchOf(lift), stage, 'A role belongs to its section at grain 1');
  assert.equal(branchAt(data, 2)(lift), lift, 'and is its own branch at grain 2');
  assert.equal(branchAt(data, 2)(office), office, 'A role above the grain is its own branch');
  assert.equal(branchOf(root), null, 'The root is above every branch');

  assert.equal(activation({ answers: [] }, branchOf).effect, 'quiet');
  assert.equal(
    activation({ answers: [{ sourceIds: [at(lift), at(stage)] }] }, branchOf).effect,
    'branch',
  );
  const joined = activation({ answers: [{ sourceIds: [at(lift), at(office)] }] }, branchOf);
  assert.equal(joined.effect, 'juxtaposition');
  assert.deepEqual(joined.tensions, [
    { left: [stage, office].sort()[0], right: [stage, office].sort()[1], status: 'resolved' },
  ]);
  const gathered = activation(
    { answers: [{ sourceIds: [at(lift)] }, { sourceIds: [at(office)] }] },
    branchOf,
  );
  assert.equal(
    gathered.tensions[0].status,
    'gathered',
    'Two answers, one from each branch, compose nothing',
  );
  const apart = activation(
    {
      answers: [],
      partial: { parts: [{ sourceIds: [at(lift)] }, { sourceIds: [at(office)] }] },
    },
    branchOf,
  );
  assert.equal(apart.effect, 'juxtaposition');
  assert.equal(apart.tensions[0].status, 'open', 'Parts in two branches, not yet answered');
  assert.equal(
    activation({ answers: [], openings: [{ sourceIds: [at(lift), at(office)] }] }, branchOf).effect,
    'quiet',
    'Openings name where a relation occurs; they activate nothing',
  );

  const run = (text, answer, minute) => ({
    id: `r${minute}`,
    questions: [{ text }],
    scopePlacementId: root,
    purpose: 'inquiry',
    projectDigest: 'rev',
    startedAt: `2026-10-24T10:${String(minute).padStart(2, '0')}:00Z`,
    answer,
  });
  const tree = await opportunityTree(null, {
    context: {
      data,
      digest: 'rev',
      runs: [
        run(
          'Who inspects the lift and signs the repair?',
          {
            answers: [],
            partial: { parts: [{ sourceIds: [at(lift)] }, { sourceIds: [at(office)] }] },
          },
          1,
        ),
        run(
          'Who inspects the lift and signs the repair?',
          { answers: [{ sourceIds: [at(lift), at(office)] }] },
          2,
        ),
        run(
          'Who files the report?',
          {
            answers: [],
            partial: { parts: [{ sourceIds: [at(stage)] }, { sourceIds: [at(office)] }] },
          },
          3,
        ),
        run('Who inspects the lift?', { answers: [{ sourceIds: [at(lift)] }] }, 4),
        run(
          'Who inspects the lift, and who keeps the office?',
          { answers: [{ sourceIds: [at(lift)] }, { sourceIds: [at(office)] }] },
          5,
        ),
      ],
    },
  });
  assert.deepEqual(tree.effects, { quiet: 0, branch: 1, juxtaposition: 3 });
  assert.equal(tree.tensions.length, 1, 'One line between Stage and Office');
  assert.deepEqual(tree.tensions[0].labels.sort(), ['Office', 'Stage']);
  assert.deepEqual(
    tree.tensions[0].resolved,
    ['Who inspects the lift and signs the repair?'],
    'The latest check',
  );
  assert.deepEqual(tree.tensions[0].open, ['Who files the report?']);
  assert.deepEqual(tree.tensions[0].gathered, ['Who inspects the lift, and who keeps the office?']);

  // An answer composed through a rule joins the branch its rule comes from
  // (review 2026-10-25, #6).
  const ruled = activation(
    { answers: [{ sourceIds: [at(lift)], ruleIds: ['office-rule'] }] },
    branchOf,
    (id) => (id === 'office-rule' ? [at(office)] : null),
  );
  assert.equal(ruled.tensions[0]?.status, 'resolved', 'A rule from another branch composes it');
  const officeConcept = data.placements.find((placement) => placement.id === office).conceptId;
  const withRule = editConcept(data, officeConcept, 'Office', [
    'Every inspection needs a signature.',
  ]);
  const derived = await opportunityTree(null, {
    context: {
      data: withRule,
      digest: 'rev',
      runs: [
        run(
          'Who signs for the lift?',
          { answers: [{ sourceIds: [at(lift)], ruleIds: [`${at(office)}/clause/c0/kind`] }] },
          6,
        ),
      ],
    },
  });
  assert.deepEqual(
    derived.tensions.map((line) => line.resolved),
    [['Who signs for the lift?']],
    'and so does a rule derived from a statement there',
  );
  console.log(
    'ok juxtaposition: quiet, branch and juxtaposition at a grain; tension lines resolved only by one composed answer (its sources or its rules), gathered by separate ones; the opportunity tree',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
