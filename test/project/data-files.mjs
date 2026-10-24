/** Packing is lossless, bounded per block, crash-safe and shared by live readers/writers. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openProject, saveProject, editConcept } from '../../src/project/authoring/project.mjs';
import { readObject } from '../../src/project/storage/objects.mjs';
import {
  compactDataFiles,
  readDataFile,
  writeDataFile,
  writeDataFiles,
  listDataFiles,
  removeDataFile,
  removeDataArea,
  dataStorePath,
} from '../../src/project/storage/data-files.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/packed-material-'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const objectFiles = new Map();
const modulePath = new URL('../../src/project/storage/data-files.mjs', import.meta.url).href;
async function child(source, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    process.stdout.on('data', (chunk) => {
      output += chunk;
      onStdout?.(String(chunk));
    });
    process.stderr.on('data', (chunk) => {
      output += chunk;
    });
    process.once('error', reject);
    process.once('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error(output || `Child exited ${code}`)),
    );
  });
}
async function legacy(area, value) {
  const bytes = JSON.stringify(value) + '\n',
    ref = hash(bytes),
    path = join(directory, area, `${ref}.json`);
  await mkdir(join(directory, area), { recursive: true });
  await writeFile(path, bytes);
  objectFiles.set(path, bytes);
  return ref;
}
try {
  const concept = { id: 'c', name: 'Root', passages: ['An engineer maintains an instrument.'] };
  const corpus = await legacy('corpora', concept),
    records = [];
  const repeated = Array.from({ length: 500 }, (_, i) => ({
    concept: `predicate-${i}`,
    description: 'A shared retained vocabulary description.',
  }));
  for (let i = 0; i < 40; i++)
    records.push(await legacy('records', { id: `legacy-${i}`, repeated, attempt: i }));
  const index = {
    version: 2,
    id: 'p',
    name: 'Stored material',
    placements: [{ id: 'root', conceptId: 'c', parentId: null }],
    corpora: [corpus],
    records: { semanticReadings: records },
  };
  await writeFile(join(directory, 'project.json'), JSON.stringify(index, null, 2) + '\n');
  const before = await openProject(directory);
  const packed = await compactDataFiles(directory);
  assert(
    packed.bytes < 64 * 1024,
    'Repeated payloads share compression instead of growing per record',
  );
  const after = await openProject(directory);
  assert.equal(
    after.digest,
    before.digest,
    'Project revision and all source references remain unchanged',
  );
  assert.deepEqual(after.data, before.data);
  for (const [path, bytes] of objectFiles) {
    assert.equal(await readDataFile(directory, path), bytes);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
  const second = await compactDataFiles(directory);
  assert.equal(second.bytes, packed.bytes);
  assert.equal((await listDataFiles(directory, 'records')).length, 40);

  // A fresh process must load the packed material without relying on an in-memory project.
  const projectModule = new URL('../../src/project/authoring/project.mjs', import.meta.url).href;
  assert.match(
    await child(
      `import {openProject} from ${JSON.stringify(projectModule)}; const p=await openProject(${JSON.stringify(directory)}); console.log(p.data.semanticReadings.length);`,
    ),
    /40/u,
  );
  const edited = await saveProject(
    after,
    editConcept(after.data, 'c', 'Root', ['An engineer maintains the changed instrument.']),
  );
  assert.deepEqual((await openProject(directory)).data, edited.data);
  await assert.rejects(saveProject(after, after.data), { code: 'PROJECT_CHANGED' });
  assert.deepEqual(await readObject(directory, 'corpora', corpus), concept);

  // The new writer supersedes a loose mutable index. Packing cannot restore the older bytes.
  const mutable = join(directory, 'acquisitions', 'index.json');
  await mkdir(join(directory, 'acquisitions'), { recursive: true });
  await writeFile(mutable, '{"revision":1}\n');
  await writeDataFile(directory, mutable, '{"revision":2}\n');
  await compactDataFiles(directory);
  assert.equal(await readDataFile(directory, mutable), '{"revision":2}\n');

  // A batch is one transaction: an immutable object that would change refuses
  // the whole batch, and nothing in it is written.
  const record = (name) => join(directory, 'records', `${name}.json`);
  await writeDataFiles(directory, [[record('batch-a'), 'a\n']], { immutable: true });
  await assert.rejects(
    writeDataFiles(
      directory,
      [
        [record('batch-b'), 'b\n'],
        [record('batch-a'), 'changed\n'],
      ],
      { immutable: true },
    ),
    /Stored object changed/u,
  );
  assert.equal(await readDataFile(directory, record('batch-a')), 'a\n');
  await assert.rejects(readDataFile(directory, record('batch-b')), { code: 'ENOENT' });
  await writeDataFiles(
    directory,
    [
      [record('batch-b'), 'b\n'],
      [record('batch-a'), 'a\n'],
    ],
    { immutable: true },
  );
  assert.equal(await readDataFile(directory, record('batch-b')), 'b\n');

  // A fresh connection must wait even for its first schema read while packing owns the lock.
  const blocker = new DatabaseSync(dataStorePath(directory));
  blocker.exec('BEGIN EXCLUSIVE');
  let releaseTimer,
    released = false;
  try {
    const output = await child(
      `import {readDataFile} from ${JSON.stringify(modulePath)};
       console.log('opening locked project');
       console.log(await readDataFile(${JSON.stringify(directory)}, ${JSON.stringify(mutable)}));`,
      {
        onStdout: (chunk) => {
          if (chunk.includes('opening locked project'))
            releaseTimer = setTimeout(() => {
              blocker.exec('COMMIT');
              released = true;
            }, 200);
        },
      },
    );
    assert(released, 'The reader waits until the other connection releases its exclusive lock');
    assert.match(output, /"revision":2/u);
  } finally {
    clearTimeout(releaseTimer);
    if (!released) blocker.exec('ROLLBACK');
    blocker.close();
  }

  const concurrent = child(`
    import {writeDataFile,readDataFile} from ${JSON.stringify(modulePath)};
    import {join} from 'node:path';
    const root=${JSON.stringify(directory)};
    for(let i=0;i<120;i++) {
      const path=join(root,'investigations',i+'.json'), bytes=JSON.stringify({i});
      await writeDataFile(root,path,bytes);
      if(await readDataFile(root,path)!==bytes) throw new Error('Concurrent read changed');
    }
  `);
  for (let i = 0; i < 4; i++) await compactDataFiles(directory);
  await concurrent;
  await compactDataFiles(directory);
  assert.equal((await listDataFiles(directory, 'investigations')).length, 120);
  for (let i = 0; i < 120; i++)
    assert.equal(
      await readDataFile(directory, join(directory, 'investigations', `${i}.json`)),
      JSON.stringify({ i }),
    );

  // A process death with an open transaction leaves the last committed path intact.
  await child(`
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(${JSON.stringify(dataStorePath(directory))});
    db.exec("BEGIN IMMEDIATE; UPDATE files SET block = NULL;");
    process.exit(0);
  `);
  assert.equal(await readDataFile(directory, mutable), '{"revision":2}\n');
  await removeDataFile(directory, mutable);
  // Simulate an interruption after the deletion was recorded but before a legacy file was removed.
  await writeFile(mutable, '{"revision":1}\n');
  await assert.rejects(readDataFile(directory, mutable), { code: 'ENOENT' });
  await compactDataFiles(directory);
  await assert.rejects(readDataFile(directory, mutable), { code: 'ENOENT' });
  await removeDataArea(directory, 'investigations');
  await compactDataFiles(directory);
  assert.deepEqual(await listDataFiles(directory, 'investigations'), []);
  assert.deepEqual((await openProject(directory)).data, edited.data);

  // Cross-process block corruption invalidates decoded caches and is never treated as a miss.
  const db = new DatabaseSync(dataStorePath(directory));
  const block = db.prepare('SELECT hash, payload FROM blocks LIMIT 1').get();
  db.prepare('UPDATE blocks SET payload = ? WHERE hash = ?').run(
    Buffer.from('damaged'),
    block.hash,
  );
  await assert.rejects(openProject(directory));
  db.prepare('UPDATE blocks SET payload = ? WHERE hash = ?').run(block.payload, block.hash);
  db.close();
  assert.deepEqual((await openProject(directory)).data, edited.data);

  const damaged = join(directory, 'records', `${'f'.repeat(64)}.json`);
  await writeFile(damaged, '{}\n');
  await assert.rejects(compactDataFiles(directory), /Stored object changed/u);
  assert.equal(
    await readFile(damaged, 'utf8'),
    '{}\n',
    'Failed verification preserves the loose evidence',
  );
  assert((await stat(dataStorePath(directory))).size < 64 * 1024);
  await Promise.all(
    Array.from({ length: 16 }, async (_, i) => {
      const root = join(directory, `parallel-${i}`),
        path = join(root, 'records', 'value.json');
      await writeDataFile(root, path, JSON.stringify({ i }));
      await compactDataFiles(root);
      assert.equal(await readDataFile(root, path), JSON.stringify({ i }));
      await removeDataArea(root, 'records');
      assert.deepEqual(await listDataFiles(root, 'records'), []);
    }),
  );
  console.log(
    'ok lossless material packing: unchanged bytes/references, sharing, cold reload, edits, concurrent writers, crash recovery, deletion and corruption',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
