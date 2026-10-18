/** Native cosine, retained-vector migration, scope isolation and persistence without acquisition. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { brotliCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProject } from '../../src/project/authoring/project.mjs';
import {
  matchQuestionRoles,
  roleMatchingProfile,
  roleMatchingTexts,
} from '../../src/project/inquiries/role-matching.mjs';
import { readObject, writeObject } from '../../src/project/storage/objects.mjs';
import {
  compactDataFiles,
  dataStorePath,
  readDataFile,
  removeDataFile,
  writeDataFile,
  withDataDatabase,
} from '../../src/project/storage/data-files.mjs';
import {
  indexedRoleVectors,
  indexedRoleTexts,
  retainRoleVectors,
  retainRoleTexts,
  scoreRoleVectors,
  discardRoleVectorIndex,
  roleVectorIndexBytes,
} from '../../src/project/storage/role-vectors.mjs';
import {
  compactProjectStorage,
  projectStorageUsage,
} from '../../src/project/inquiries/project-storage.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/native-role-vectors-'));
const project = await createProject(directory, 'Native vectors', 'Root');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const vector = (text) => {
  const values = Array.from(
    { length: 128 },
    (_, i) => parseInt(hash(`${text}/${i}`).slice(0, 8), 16) / 0xffffffff - 0.5,
  );
  const norm = Math.hypot(...values);
  return values.map((v) => v / norm);
};
const query = 'Find a responsibility';
const asset = {
  query,
  start: 'root',
  nodes: [
    {
      id: 'root',
      label: 'Root',
      sentences: [],
      crossings: Array.from({ length: 150 }, (_, i) => `role-${i}`),
    },
    ...Array.from({ length: 150 }, (_, i) => ({
      id: `role-${i}`,
      label: `Role ${i}`,
      sentences: [`Statement ${i}`],
      crossings: [],
    })),
  ],
};
const vectors = new Map(roleMatchingTexts(asset).map((text) => [text, vector(text)]));
// Ties, identical and opposite vectors exercise stable order and cosine's complete range.
for (const text of ['Role 0', 'Statement 0', 'Role 1', 'Statement 1'])
  vectors.set(text, vectors.get(query));
for (const text of ['Role 2', 'Statement 2'])
  vectors.set(
    text,
    vectors.get(query).map((v) => -v),
  );
const embed = async (texts) => ({
  model: 'native-vector-test@1',
  embedding: { usedDimensions: 128 },
  vectors: texts.map((text) => vectors.get(text)),
});
const ranked = await matchQuestionRoles(project, asset, { embed });
assert.equal(ranked.scoring.profile, 'sqlite-vec-cosine-f32-v1');
assert.equal(ranked.scoring.version, 'v0.1.9');
assert.equal(ranked.scoring.selection, 'complete-scope');
const cosine = (left, right) =>
  left.reduce((sum, v, i) => sum + v * right[i], 0) / (Math.hypot(...left) * Math.hypot(...right));
let maxError = 0;
for (const match of ranked.matches)
  for (const item of match.local) {
    const expected = cosine(vectors.get(query), vectors.get(item.text));
    maxError = Math.max(maxError, Math.abs(item.score - expected));
    assert(
      Math.abs(item.score - expected) < 5e-7,
      `${item.text}: SQL cosine agrees with independent arithmetic`,
    );
  }
const expectedOrder = asset.nodes
  .slice(1)
  .map((node) => ({
    id: node.id,
    score: Math.max(
      ...[node.label, ...node.sentences].map((text) =>
        cosine(vectors.get(query), vectors.get(text)),
      ),
    ),
  }))
  .sort((a, b) => b.score - a.score)
  .map((node) => node.id);
assert.deepEqual(ranked.matches.find((m) => m.nodeId === 'root').children, expectedOrder);
assert.equal(ranked.matches.find((m) => m.nodeId === 'role-2').best.score, -1);
const cohort = await readObject(directory, 'role-matching/objects', ranked.evidenceRef);
for (let i = 0; i < cohort.vectorRefs.length; i++) {
  const value = await readObject(directory, 'role-matching/vectors', cohort.vectorRefs[i]);
  assert.deepEqual(
    value.vector,
    vectors.get(cohort.texts[i]),
    'The native float32 projection preserves original acquisition bytes',
  );
}
const changes = () =>
  withDataDatabase(directory, (db) => db.prepare('SELECT total_changes() AS n').get().n);
const before = changes();
assert.deepEqual(await matchQuestionRoles(project, asset, { acquire: false }), ranked);
assert.equal(changes(), before, 'A warm query performs no writes or repeated vector import');
await compactDataFiles(directory);
const packedChanges = changes();
assert.deepEqual(await matchQuestionRoles(project, asset, { acquire: false }), ranked);
assert.equal(changes(), packedChanges, 'Compaction preserves the native vector index');
const scoped = structuredClone(asset);
scoped.nodes = scoped.nodes.filter((node) => ['root', 'role-2', 'role-9'].includes(node.id));
scoped.nodes[0].crossings = ['role-2', 'role-9'];
const scopeResult = await matchQuestionRoles(project, scoped, { acquire: false });
assert.deepEqual(
  new Set(scopeResult.matches.map((m) => m.nodeId)),
  new Set(['root', 'role-2', 'role-9']),
);
assert.deepEqual(scopeResult.matches.find((m) => m.nodeId === 'root').children, [
  'role-9',
  'role-2',
]);

const assetPath = join(directory, 'query.json');
await writeFile(assetPath, JSON.stringify(asset));
const child = await promisify(execFile)(process.execPath, [
  '--input-type=module',
  '-e',
  `
  import { readFile } from 'node:fs/promises';
  import { join } from 'node:path';
  import { matchQuestionRoles } from ${JSON.stringify(new URL('../../src/project/inquiries/role-matching.mjs', import.meta.url).href)};
  globalThis.fetch = () => { throw new Error('Cold reload must not acquire'); };
  const [directory, path] = process.argv.slice(1);
  console.log(JSON.stringify(await matchQuestionRoles({path: join(directory, 'project.json')},
    JSON.parse(await readFile(path, 'utf8')), {acquire: false})));
`,
  directory,
  assetPath,
]);
assert.deepEqual(
  JSON.parse(child.stdout),
  ranked,
  'A new process returns identical native scores and branch order',
);

// The index can be discarded and reconstructed from the exact retained acquisitions.
withDataDatabase(directory, (db) =>
  db.exec('DELETE FROM role_vector_texts; DELETE FROM role_vectors;'),
);
assert.deepEqual(await matchQuestionRoles(project, asset, { acquire: false }), ranked);
const sample = await readObject(directory, 'role-matching/vectors', cohort.vectorRefs[0]);
const added = { ...sample, text: 'Transactional insertion' };
const ref = await writeObject(directory, 'role-matching/vectors', added);
assert.throws(
  () =>
    retainRoleVectors(directory, [
      { ...added, ref },
      { ...sample, vector: Array(128).fill(0), ref: cohort.vectorRefs[0] },
    ]),
  /Stored role vector changed/u,
);
assert.equal(
  indexedRoleVectors(directory, [ref])[0],
  null,
  'A failed batch commits no partial vector index',
);
const textIndex = 'role-matching/texts/concurrent.json';
const older = JSON.stringify({ ref: cohort.vectorRefs[0] }) + '\n';
const newer = JSON.stringify({ ref: cohort.vectorRefs[1] }) + '\n';
await writeDataFile(directory, join(directory, textIndex), newer);
retainRoleTexts(directory, [{ path: textIndex, bytes: newer, ref: cohort.vectorRefs[1] }]);
retainRoleTexts(directory, [{ path: textIndex, bytes: older, ref: cohort.vectorRefs[0] }]);
assert.equal(
  indexedRoleTexts(directory, [textIndex])[0].ref,
  cohort.vectorRefs[1],
  'An older concurrent inquiry cannot overwrite the current text mapping',
);
await removeDataFile(
  directory,
  join(directory, 'role-matching/vectors', `${cohort.vectorRefs[0]}.json`),
);
assert.equal(indexedRoleVectors(directory, [cohort.vectorRefs[0]])[0], null);
assert.throws(() => scoreRoleVectors(directory, cohort.vectorRefs), /every retained vector/u);
assert.equal(
  withDataDatabase(
    directory,
    (db) =>
      db.prepare('SELECT count(*) AS n FROM role_vectors WHERE ref = ?').get(cohort.vectorRefs[0])
        .n,
  ),
  0,
);

// A pre-index database and an inline cohort both migrate offline, preserving the original object.
const legacy = join(directory, 'legacy');
await mkdir(legacy);
const legacyAsset = {
  query,
  start: 'root',
  nodes: [{ id: 'root', label: 'Root', sentences: [], crossings: [] }],
};
const texts = roleMatchingTexts(legacyAsset);
const captured = {
  profile: roleMatchingProfile,
  texts,
  vectors: texts.map((text) => vectors.get(text)),
  model: 'native-vector-test@1',
  embedding: { usedDimensions: 128 },
  acquiredAt: '2026-01-01T00:00:00.000Z',
};
const original = JSON.stringify(captured) + '\n',
  originalRef = hash(original);
const pairs = [
  [`role-matching/objects/${originalRef}.json`, original],
  [
    `role-matching/${hash(JSON.stringify([roleMatchingProfile, texts]))}.json`,
    JSON.stringify({ ref: originalRef }) + '\n',
  ],
];
const oldVector = {
  profile: captured.profile,
  text: texts[0],
  vector: captured.vectors[0],
  model: captured.model,
  embedding: captured.embedding,
  acquiredAt: captured.acquiredAt,
};
const oldVectorBytes = JSON.stringify(oldVector) + '\n';
pairs.push([`role-matching/vectors/${hash(oldVectorBytes)}.json`, oldVectorBytes]);
const block = JSON.stringify(pairs),
  db = new DatabaseSync(dataStorePath(legacy));
db.exec(
  'CREATE TABLE files(path TEXT PRIMARY KEY, block TEXT); CREATE TABLE blocks(hash TEXT PRIMARY KEY, payload BLOB);',
);
db.prepare('INSERT INTO blocks VALUES (?, ?)').run(
  hash(block),
  brotliCompressSync(Buffer.from(block)),
);
for (const [path] of pairs) db.prepare('INSERT INTO files VALUES (?, ?)').run(path, hash(block));
db.close();
const migrated = await matchQuestionRoles({ path: join(legacy, 'project.json') }, legacyAsset, {
  acquire: false,
});
assert.equal(migrated.status, 'matched');
assert.equal(migrated.scoring.profile, ranked.scoring.profile);
assert.equal(await readDataFile(legacy, join(legacy, pairs[0][0])), original);
assert.notEqual(migrated.evidenceRef, originalRef);
assert.deepEqual(
  await matchQuestionRoles({ path: join(legacy, 'project.json') }, legacyAsset, { acquire: false }),
  migrated,
);
const followupAsset = { ...legacyAsset, query: 'Use another question' },
  asked = [];
const followup = await matchQuestionRoles({ path: join(legacy, 'project.json') }, followupAsset, {
  embed: async (texts) => {
    asked.push(...texts);
    return { model: captured.model, embedding: captured.embedding, vectors: texts.map(vector) };
  },
});
assert.deepEqual(
  asked,
  ['Use another question'],
  'Inline legacy vectors transfer to a new question without re-embedding the roles',
);
const followupCohort = await readObject(legacy, 'role-matching/objects', followup.evidenceRef);
assert(followupCohort.vectorOrigins.some(Boolean));
discardRoleVectorIndex(legacy);
assert.deepEqual(
  await matchQuestionRoles({ path: join(legacy, 'project.json') }, followupAsset, {
    acquire: false,
  }),
  followup,
);
discardRoleVectorIndex(legacy);
await matchQuestionRoles(
  { path: join(legacy, 'project.json') },
  { ...legacyAsset, query: 'A third question' },
  {
    embed: async (texts) => {
      assert.deepEqual(
        texts,
        ['A third question'],
        'Losing the index never forces a model pass over retained legacy roles',
      );
      return { model: captured.model, embedding: captured.embedding, vectors: texts.map(vector) };
    },
  },
);

// Derived vectors obey the small-project budget, and rebuild offline after eviction.
const budgetDirectory = join(directory, 'budget');
const budgetProject = await createProject(budgetDirectory, 'Vector budget', 'Root');
const budgetMatch = await matchQuestionRoles(budgetProject, legacyAsset, { embed });
await writeDataFile(
  budgetDirectory,
  join(budgetDirectory, 'records/padding.json'),
  JSON.stringify({ material: randomBytes(280000).toString('base64') }),
);
await compactDataFiles(budgetDirectory);
const used = await projectStorageUsage(budgetProject);
assert(used.allocated > 300 * 1024);
assert(used.allocated - roleVectorIndexBytes(budgetDirectory) < 300 * 1024);
const packed = await compactProjectStorage(budgetProject);
assert.equal(packed.vectorsEvicted, true);
assert.equal(packed.withinTarget, true);
assert.equal(packed.material.bytes, packed.after.areas['material.sqlite'].bytes);
assert.deepEqual(
  await matchQuestionRoles(budgetProject, legacyAsset, { acquire: false }),
  budgetMatch,
);
// A long-lived editor connection observes a worker creating and evicting the index.
const externalDirectory = join(directory, 'external');
const external = await createProject(externalDirectory, 'External worker', 'Root');
const externalAsset = join(directory, 'external-query.json');
await writeFile(externalAsset, JSON.stringify(legacyAsset));
const worker = async (action) =>
  promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    `
  import {readFile} from 'node:fs/promises';
  import {join} from 'node:path';
  import {matchQuestionRoles} from ${JSON.stringify(new URL('../../src/project/inquiries/role-matching.mjs', import.meta.url).href)};
  import {discardRoleVectorIndex} from ${JSON.stringify(new URL('../../src/project/storage/role-vectors.mjs', import.meta.url).href)};
  const [directory, path, action] = process.argv.slice(1);
  globalThis.fetch = () => {throw new Error('No network in a worker test');};
  if (action === 'discard') discardRoleVectorIndex(directory);
  else await matchQuestionRoles({path:join(directory,'project.json')}, JSON.parse(await readFile(path,'utf8')), {
    embed: async texts => ({model:'worker@1',embedding:{usedDimensions:128},
      vectors:texts.map(()=>[1,...Array(127).fill(0)])})
  });
`,
    externalDirectory,
    externalAsset,
    action,
  ]);
await worker('build');
await writeDataFile(externalDirectory, join(externalDirectory, 'records/editor.json'), '{}\n');
await compactDataFiles(externalDirectory);
const externalMatch = await matchQuestionRoles(external, legacyAsset, { acquire: false });
await worker('discard');
assert.deepEqual(
  await matchQuestionRoles(external, legacyAsset, { acquire: false }),
  externalMatch,
);
console.log(
  `ok native SQLite vectors: cosine error ${maxError.toExponential(2)}, stable full-scope ranking, zero-write reuse, cold restart, atomic rebuild, deletion and legacy migration`,
);
