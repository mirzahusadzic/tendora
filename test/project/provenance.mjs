/** Statement provenance beside a project: declared authorship read by text,
 * validated, and carried by an exported answer with the corpus's identity. A
 * statement it does not list names no one. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject } from '../../src/project/authoring/project.mjs';
import {
  answerProvenance,
  readProvenance,
  validateProvenance,
} from '../../src/project/authoring/provenance.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/provenance-'));
try {
  const project = await createProject(directory, 'Provenance');
  assert.equal((await readProvenance(project)).size, 0, 'Without the file, no one is named');
  for (const [data, pattern] of [
    [{ statements: [] }, /version 1/u],
    [{ version: 1, statements: [{ author: 'A' }] }, /statement text/u],
    [{ version: 1, statements: [{ text: 'T.' }] }, /an author/u],
    [
      {
        version: 1,
        statements: [
          { text: 'T.', author: 'A' },
          { text: 'T.', author: 'B' },
        ],
      },
      /twice/u,
    ],
    [{ version: 1, statements: [{ text: 'T.', author: 'A', accepted: { by: 'B' } }] }, /accepted/u],
  ])
    assert.throws(() => validateProvenance(data), pattern);
  await writeFile(
    join(directory, 'provenance.json'),
    JSON.stringify({
      version: 1,
      statements: [
        { text: 'The gate opens.', author: 'A', accepted: { by: 'B', on: '2026-10-25' } },
        { text: 'The lock holds.', author: 'Model M', proposer: { model: 'M', run: 'r1' } },
      ],
    }),
  );
  const provenance = await readProvenance(project);
  const sources = [
    { id: 's1', text: 'The gate opens.' },
    { id: 's2', text: 'The lock holds.' },
    { id: 's3', text: 'The bell rings.' },
  ];
  const exported = answerProvenance(
    { projectId: 'p', projectRevision: 'r' },
    provenance,
    [{ sourceIds: ['s2', 's1'] }, { sourceIds: ['s1', 's3', 'gone'] }],
    sources,
  );
  assert.deepEqual(exported, {
    projectId: 'p',
    projectRevision: 'r',
    statements: [
      {
        sourceId: 's2',
        text: 'The lock holds.',
        author: 'Model M',
        proposer: { model: 'M', run: 'r1' },
      },
      {
        sourceId: 's1',
        text: 'The gate opens.',
        author: 'A',
        accepted: { by: 'B', on: '2026-10-25' },
      },
      { sourceId: 's3', text: 'The bell rings.', author: 'unrecorded' },
      { sourceId: 'gone', text: null, author: 'unrecorded' },
    ],
  });
  console.log('ok statement provenance: validated, read by text, carried by exported answers');
} finally {
  await rm(directory, { recursive: true, force: true });
}
