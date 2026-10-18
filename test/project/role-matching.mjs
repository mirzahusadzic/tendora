/** Question-to-role acquisition, ordering and retained evidence, independent of answer checking. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProject } from '../../src/project/authoring/project.mjs';
import { matchQuestionRoles } from '../../src/project/inquiries/role-matching.mjs';
import { readObject } from '../../src/project/storage/objects.mjs';
import { scoreRoleVectors } from '../../src/project/storage/role-vectors.mjs';
import {
  readDataFile,
  writeDataFile,
  removeDataFile,
  compactDataFiles,
} from '../../src/project/storage/data-files.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/role-matching-test-'));
const project = await createProject(directory, 'Matching', 'Root');
const asset = {
  query: 'Find the relevant participant?',
  start: 'root',
  nodes: [
    { id: 'root', label: 'Root', sentences: [], crossings: ['other', 'container'] },
    { id: 'other', label: 'Other role', sentences: ['Unrelated statement.'], crossings: [] },
    { id: 'container', label: 'Container', sentences: [], crossings: ['leaf'] },
    { id: 'leaf', label: 'Leaf', sentences: ['Relevant statement.'], crossings: [] },
  ],
};
let calls = 0;
const unit = (a, b) => [a, b, ...Array(126).fill(0)];
const embed = async (texts) => {
  calls++;
  return {
    model: 'controlled-routing-vectors@1',
    embedding: { usedDimensions: 128 },
    vectors: texts.map((text) =>
      text === asset.query || text === 'Relevant statement.' ? unit(1, 0) : unit(0, 1),
    ),
  };
};
const ranked = await matchQuestionRoles(project, asset, { embed });
assert.equal(ranked.status, 'matched');
assert.deepEqual(ranked.matches.find((m) => m.nodeId === 'root').children, ['container', 'other']);
assert.equal(
  ranked.matches.find((m) => m.nodeId === 'container').best.nodeId,
  'leaf',
  'A container inherits its most relevant descendant without hiding other branches',
);
assert.equal(ranked.matches.length, 4);
const retained = await readObject(directory, 'role-matching/objects', ranked.evidenceRef);
assert(retained.texts.includes(asset.query));
await compactDataFiles(directory);
assert.deepEqual(await matchQuestionRoles(project, asset, { acquire: false, embed }), ranked);
assert.equal(calls, 1, 'Reload has no network dependency');
const renamed = structuredClone(asset);
renamed.nodes[3].label = 'Changed role description';
assert.equal(
  (await matchQuestionRoles(project, renamed, { acquire: false })).status,
  'unavailable',
);
const unavailable = await matchQuestionRoles(project, renamed, {
  embed: async () => {
    throw new Error('Embeddings unavailable');
  },
});
assert.equal(unavailable.status, 'unavailable');
assert.match(unavailable.reason, /Roles follow their original order/u);
const controller = new AbortController();
await assert.rejects(
  matchQuestionRoles(project, renamed, {
    signal: controller.signal,
    embed: async () => {
      controller.abort();
      throw controller.signal.reason;
    },
  }),
  { name: 'AbortError' },
);
await assert.rejects(
  matchQuestionRoles(project, renamed, {
    embed: async (texts) => ({
      model: 'broken@1',
      vectors: texts.map(() => unit(NaN, 1)),
    }),
  }),
  /Invalid role-matching embeddings/u,
);
const cache = join(directory, 'role-matching', 'objects', `${ranked.evidenceRef}.json`);
const bytes = await readDataFile(directory, cache);
await writeDataFile(
  directory,
  cache,
  bytes.replace('controlled-routing-vectors', 'modified-routing-vectors'),
);
await assert.rejects(
  matchQuestionRoles(project, asset, { acquire: false }),
  /Stored object changed/u,
);
await removeDataFile(directory, cache);
await assert.rejects(
  matchQuestionRoles(project, asset, { embed }),
  /Saved role-matching data is missing/u,
);
assert.equal(
  calls,
  1,
  'Missing retained evidence must not be replaced by an unrecorded acquisition',
);
console.log(
  'ok role matching: descendant relevance, complete branch ordering, exact-text retained vectors, invalidation, offline recovery, cancellation and integrity',
);

// A new question embeds only new text, and a role edit leaves the rest of the index intact.
const incremental = await createProject(join(directory, 'incremental'), 'Incremental', 'Root');
const batches = [];
const tracked = async (texts) => {
  batches.push([...texts]);
  return embed(texts);
};
await matchQuestionRoles(incremental, asset, { embed: tracked });
const followup = { ...asset, query: 'Another question?' };
await matchQuestionRoles(incremental, followup, { embed: tracked });
assert.deepEqual(batches.at(-1), ['Another question?']);
const changed = structuredClone(followup);
changed.nodes[1].label = 'Updated responsibility';
await matchQuestionRoles(incremental, changed, { embed: tracked });
assert.deepEqual(batches.at(-1), ['Updated responsibility']);
const acquiredCount = batches.length;
await matchQuestionRoles(incremental, changed, { acquire: false });
assert.equal(batches.length, acquiredCount);
const changedModel = await matchQuestionRoles(
  incremental,
  { ...changed, query: 'A new model question?' },
  {
    embed: async (texts) => {
      batches.push([...texts]);
      return { ...(await embed(texts)), model: 'controlled-routing-vectors@2' };
    },
  },
);
assert.equal(changedModel.model, 'controlled-routing-vectors@2');
const modelCohort = await readObject(
  join(directory, 'incremental'),
  'role-matching/objects',
  changedModel.evidenceRef,
);
assert.equal(modelCohort.vectorRefs.length, modelCohort.texts.length);
const vectorFile = join(
  directory,
  'incremental',
  'role-matching/vectors',
  `${modelCohort.vectorRefs[0]}.json`,
);
await writeDataFile(
  join(directory, 'incremental'),
  vectorFile,
  (await readDataFile(join(directory, 'incremental'), vectorFile)).replace(
    'controlled-routing-vectors',
    'tampered-routing-vectors',
  ),
);
await assert.rejects(
  matchQuestionRoles(
    incremental,
    { ...changed, query: 'A new model question?' },
    { acquire: false },
  ),
  /Stored object changed/u,
);
console.log(
  'ok incremental role index: new question only, isolated text edits, revision consistency and vector integrity',
);

const scale = await createProject(join(directory, 'scale'), 'Scale', 'Root');
const large = {
  query: 'Find one role?',
  start: '0',
  nodes: Array.from({ length: 10000 }, (_, i) => ({
    id: String(i),
    label: `Role ${i}`,
    sentences: [],
    crossings: i ? [] : Array.from({ length: 9999 }, (_, k) => String(k + 1)),
  })),
};
const acquired = [];
const scaleEmbed = async (texts) => {
  acquired.push([...texts]);
  return {
    model: 'scale-controlled@1',
    embedding: { usedDimensions: 128 },
    vectors: texts.map(() => unit(1, 0)),
  };
};
const start = performance.now();
const firstLarge = await matchQuestionRoles(scale, large, { embed: scaleEmbed });
assert.equal(firstLarge.matches.length, 10000);
assert.equal(acquired.flat().length, 10001);
assert(acquired.every((batch) => batch.length <= 128));
const indexedMs = performance.now() - start;
acquired.length = 0;
const nextStart = performance.now();
const secondLarge = await matchQuestionRoles(
  scale,
  { ...large, query: 'Another role question?' },
  { embed: scaleEmbed },
);
assert.deepEqual(acquired, [['Another role question?']]);
const secondMs = performance.now() - nextStart;
const nativeCohort = await readObject(
  join(directory, 'scale'),
  'role-matching/objects',
  secondLarge.evidenceRef,
);
const sqlStart = performance.now();
const scored = scoreRoleVectors(join(directory, 'scale'), nativeCohort.vectorRefs);
const sqlMs = performance.now() - sqlStart;
assert.equal(scored.scores.length, 10001);
assert(scored.scores.every((score) => score === 1));
const assetPath = join(directory, 'scale-query.json');
await writeFile(assetPath, JSON.stringify({ ...large, query: 'Another role question?' }));
const cold = await promisify(execFile)(process.execPath, [
  '--input-type=module',
  '-e',
  `
  import { readFile } from 'node:fs/promises';
  import { matchQuestionRoles } from ${JSON.stringify(new URL('../../src/project/inquiries/role-matching.mjs', import.meta.url).href)};
  const [path, assetPath] = process.argv.slice(1);
  const asset = JSON.parse(await readFile(assetPath, 'utf8'));
  globalThis.fetch = () => { throw new Error('Cold role matching must use retained vectors'); };
  const start = performance.now();
  const ranked = await matchQuestionRoles({path}, asset, {acquire: false});
  console.log(JSON.stringify({ms: performance.now() - start, count: ranked.matches.length,
    children: ranked.matches.find((m) => m.nodeId === '0').children, profile: ranked.scoring.profile}));
`,
  scale.path,
  assetPath,
]);
const reloaded = JSON.parse(cold.stdout);
assert.equal(reloaded.count, 10000);
assert.deepEqual(reloaded.children, large.nodes[0].crossings);
assert.equal(reloaded.profile, 'sqlite-vec-cosine-f32-v1');
assert(reloaded.ms < 2000, 'Cold complete-scope ranking of 10,000 roles stays interactive');
console.log(
  `ok 10,000-role matching: bounded acquisition batches, every branch retained, one new query vector; controlled-ingress index ${Math.round(indexedMs)} ms, second query ${Math.round(secondMs)} ms, SQL cosine ${Math.round(sqlMs)} ms, cold query ${Math.round(reloaded.ms)} ms`,
);
