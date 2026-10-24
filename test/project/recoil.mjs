/** Recoil walks saved checks from a locus toward what it rests on and what rests
 * on it, checking nothing again; what the walk cannot see is its frontier, never
 * absence, and a question that cites nothing of the locus is only unaffected
 * when its check is current. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { addConcept, createProject, editConcept } from '../../src/project/authoring/project.mjs';
import { sentenceRevision } from '../../src/project/authoring/sources.mjs';
import { recoil } from '../../src/project/inquiries/recoil.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/recoil-'));
try {
  const project = await createProject(join(directory, 'project'), 'Workshop', 'Work');
  let data = project.data;
  const root = data.placements[0].id;
  const role = (name, passages) => {
    const added = addConcept(data, root, name);
    const placement = added.data.placements.find((p) => p.id === added.placementId);
    data = editConcept(added.data, placement.conceptId, name, passages);
    return added.placementId;
  };
  const inspects = 'The technician inspects the lift.',
    opens = 'If the lift is inspected, the stage opens.',
    signs = 'The manager signs the repair.';
  const stage = role('Stage', [inspects, opens]);
  const office = role('Office', [signs]);
  const digest = 'revision-2';
  const source = (placementId, index, text) => ({
    id: `${placementId}/s${index}`,
    nodeId: placementId,
    text,
    revision: sentenceRevision(text),
  });
  let started = 0;
  const run = (
    text,
    scope,
    answers,
    { sources = [], projectDigest = digest, answer = true } = {},
  ) => ({
    id: `run-${++started}`,
    questions: [{ text }],
    scopePlacementId: scope,
    purpose: 'inquiry',
    projectDigest,
    startedAt: `2026-10-24T10:00:${String(started).padStart(2, '0')}Z`,
    status: answers.length ? 'supported' : 'open',
    ...(answer ? { answer: { answers, candidates: [], sources } } : { cache: 'recheck' }),
  });
  const lift = source(stage, 1, inspects);
  const rule = `${stage}/s2/clause/z0/condition-v1`;
  const runs = [
    run(
      'Who inspects the lift?',
      root,
      [
        {
          text: 'technician',
          sourceIds: [lift.id],
          ruleIds: [],
          fragmentIds: [`${lift.id}/clause/z0`],
        },
      ],
      { sources: [lift] },
    ),
    run(
      'Does the stage open?',
      root,
      [{ text: 'Yes', sourceIds: [lift.id], ruleIds: [rule], fragmentIds: [] }],
      { sources: [lift] },
    ),
    run(
      'Who signs the repair?',
      root,
      [{ text: 'manager', sourceIds: [`${office}/s1`], ruleIds: [], fragmentIds: [] }],
      { sources: [source(office, 1, signs)] },
    ),
    run('Who repairs the lift?', root, [], { answer: false }),
    run('Who opens the stage?', root, [], { projectDigest: 'revision-1' }),
    run('Who files the repair?', office, []),
  ];
  const asks = [{ question: 'Who closes the stage?', scopePlacementId: root, caseSelection: null }];
  const readings = new Set([sentenceRevision(inspects), sentenceRevision(opens)]);
  const walk = (locus, options) => recoil({ data, digest, runs, asks, readings }, locus, options);
  const named = (visits) => visits.map((visit) => [visit.kind, visit.label, visit.relation]);

  const fromLift = walk({ kind: 'statement', text: inspects });
  assert.deepEqual(named(fromLift.consequences), [
    ['question', 'Who inspects the lift?', 'rests on'],
    ['question', 'Does the stage open?', 'rests on'],
    ['role', 'Work', 'asked at'],
  ]);
  assert.deepEqual(named(fromLift.origins), [['role', 'Stage', 'placed at']]);
  assert.deepEqual(
    fromLift.frontier.map((item) => [item.label, item.reason]),
    [
      ['Who repairs the lift?', 'released'],
      ['Who opens the stage?', 'changed'],
      ['Who closes the stage?', 'unchecked'],
    ],
    'Checks the walk cannot see are its frontier, not unaffected',
  );
  // Office's own question does not reach a Stage statement.
  assert.equal(fromLift.unaffected, 1, 'Only the current check that cites nothing of it');

  const fromRule = walk({ kind: 'statement', text: opens });
  assert.deepEqual(named(fromRule.consequences).slice(0, 1), [
    ['question', 'Does the stage open?', 'rests on a rule read from'],
  ]);
  assert.equal(fromRule.unaffected, 2);

  const fromQuestion = walk({
    kind: 'question',
    text: 'Does the stage open?',
    scopePlacementId: root,
  });
  assert.deepEqual(named(fromQuestion.origins), [
    ['statement', inspects, 'answer'],
    ['rule', `Rule read from “${opens}”`, 'answer'],
    ['role', 'Stage', 'placed at'],
    ['statement', opens, 'read from'],
  ]);
  assert.deepEqual(named(fromQuestion.consequences), [['role', 'Work', 'asked at']]);
  assert.deepEqual(fromQuestion.frontier, []);
  const fragment = walk({
    kind: 'question',
    text: 'Who inspects the lift?',
    scopePlacementId: root,
  });
  assert.deepEqual(fragment.origins[0].fragments, [`${lift.id}/clause/z0`]);

  const released = walk({
    kind: 'question',
    text: 'Who repairs the lift?',
    scopePlacementId: root,
  });
  assert.deepEqual(released.origins, [], 'A released check shows no origins');
  assert.deepEqual(
    released.frontier.map((item) => item.reason),
    ['released'],
  );

  // Without a reading, a statement's interpretation is an opening of its own.
  const unread = walk({ kind: 'statement', text: signs });
  assert(unread.frontier.some((item) => item.kind === 'reading' && item.reason === 'no reading'));
  // Office's own question reaches this statement too, and cites nothing of it.
  assert.equal(unread.unaffected, 3);

  const fromRole = walk({ kind: 'role', placementId: stage });
  assert.deepEqual(
    named(fromRole.consequences).filter(([kind]) => kind === 'question'),
    [
      ['question', 'Who inspects the lift?', 'rests on a statement here'],
      ['question', 'Does the stage open?', 'rests on a statement here'],
    ],
  );
  assert.deepEqual(named(fromRole.origins), [
    ['statement', inspects, 'contains'],
    ['statement', opens, 'contains'],
  ]);

  const bounded = walk({ kind: 'statement', text: inspects }, { limit: 3 });
  assert(bounded.origins.length + bounded.consequences.length <= 2);
  assert(
    bounded.frontier.some((item) => item.reason === 'bound'),
    'A bound is reported',
  );
  console.log(
    'ok recoil: cited origins and consequences, fragments and derived rules, a frontier for unseen checks, missing readings and the bound',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
