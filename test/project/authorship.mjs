/** A statement records who wrote it (`actor`, `unrecorded` unless given) and
 * through what (`via`) when it is written, as a check and a confirmation do. An
 * exported answer names that author before any declared provenance; a
 * statement written before authors were recorded stays `unrecorded`. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, saveProject } from '../../src/project/authoring/project.mjs';
import { addMaterial, reviseMaterial } from '../../src/engine/develop.mjs';
import {
  answerProvenance,
  readProvenance,
  recordedAuthors,
} from '../../src/project/authoring/provenance.mjs';
import { frozenParser } from '../support/development-acquisition.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/authorship-'));
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = frozenParser();
  let project = await createProject(join(directory, 'project'), 'Workshop', 'Workshop');
  const scope = project.data.placements[0].id;
  const written = await addMaterial(
    project,
    { text: 'The mechanic repairs bicycles.', scopePlacementId: scope },
    { actor: 'Ana', via: 'editor' },
  );
  project = await saveProject(project, written.data);
  const [response] = written.contribution.responses;
  assert.deepEqual([response.actor, response.via], ['Ana', 'editor']);
  const scripted = await addMaterial(project, {
    text: 'Bicycles are repaired in the workshop.',
    scopePlacementId: scope,
  });
  project = await saveProject(project, scripted.data);
  assert.deepEqual(
    [scripted.contribution.responses[0].actor, scripted.contribution.responses[0].via],
    ['unrecorded', 'library'],
    'A scripted statement names no one unless given an author',
  );
  // An edit is written by whoever revises it.
  const revised = await reviseMaterial(
    project,
    { contributionId: scripted.contribution.id, text: 'The mechanic repairs bicycles.' },
    { actor: 'Ben', via: 'editor' },
  );
  project = await saveProject(project, revised.data);
  const current = revised.contribution.responses.find((r) => !r.withdrawn);
  assert.deepEqual([current.actor, current.via], ['Ben', 'editor']);

  const ana = `contribution:${written.contribution.id}:${response.id}`;
  const ben = `contribution:${scripted.contribution.id}:${current.id}`;
  const recorded = recordedAuthors(project.data);
  assert.deepEqual(
    { ...recorded.get(ana), at: undefined },
    { author: 'Ana', via: 'editor', at: undefined },
  );
  assert(recorded.get(ana).at, 'The record keeps when it was written');
  // A statement written before authors were recorded names no one.
  const legacy = structuredClone(project.data);
  delete legacy.contributions[0].responses[0].actor;
  delete legacy.contributions[0].responses[0].via;
  assert(!recordedAuthors(legacy).has(ana));

  // Declared provenance adds what the workbench does not know (a proposer); a
  // different declared author stays visible beside the recorded one.
  await writeFile(
    join(directory, 'project', 'provenance.json'),
    JSON.stringify({
      version: 1,
      statements: [
        {
          text: 'The mechanic repairs bicycles.',
          author: 'Model M',
          proposer: { model: 'M', run: 'r1' },
        },
      ],
    }),
  );
  const exported = answerProvenance(
    { projectId: project.data.id, projectRevision: 'r' },
    await readProvenance(project),
    [{ sourceIds: [ana, ben, 'imported/s1'] }],
    [
      { id: ana, text: 'The mechanic repairs bicycles.' },
      { id: ben, text: 'The mechanic repairs bicycles.' },
      { id: 'imported/s1', text: 'The mechanic repairs bicycles.' },
    ],
    recorded,
  );
  const authors = exported.statements.map(
    ({ sourceId, author, via, declaredAuthor, proposer }) => ({
      sourceId,
      author,
      via,
      declaredAuthor,
      proposer,
    }),
  );
  assert.deepEqual(authors, [
    {
      sourceId: ana,
      author: 'Ana',
      via: 'editor',
      declaredAuthor: 'Model M',
      proposer: { model: 'M', run: 'r1' },
    },
    {
      sourceId: ben,
      author: 'Ben',
      via: 'editor',
      declaredAuthor: 'Model M',
      proposer: { model: 'M', run: 'r1' },
    },
    {
      sourceId: 'imported/s1',
      author: 'Model M',
      via: undefined,
      declaredAuthor: undefined,
      proposer: { model: 'M', run: 'r1' },
    },
  ]);
  // A confirmed connection is a person's decision: it exports who confirmed it,
  // through what and when, as a confirmation, not as an unrecorded statement
  // (final review, #6).
  const decided = structuredClone(project.data);
  decided.contributions[0].wordings.push({
    id: 'w1',
    kind: 'clarification',
    text: 'Who repairs bicycles?',
    graph: { top: 'z0', nodes: [{ id: 'z0', concept: 'repair-01' }], edges: [] },
    basisSources: [{ text: 'The mechanic repairs bicycles.' }],
    confirmation: { actor: 'Reviewer R', via: 'editor', at: '2026-10-25T04:00:00.000Z' },
  });
  assert.deepEqual(recordedAuthors(decided).get(`contribution:${written.contribution.id}:w1`), {
    author: 'Reviewer R',
    via: 'editor',
    at: '2026-10-25T04:00:00.000Z',
    kind: 'confirmed connection',
  });
  console.log('ok authorship: statements record who wrote them; export names them first');
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
