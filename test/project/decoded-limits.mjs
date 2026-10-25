/** Stored data is decoded within a bound (final review #10): a damaged or
 * hostile store cannot make a read allocate without limit before its hash is
 * checked, and what could not be read back is never written. The largest real
 * units are a few MB; the bound is 256 MiB per block, run, fragment and
 * artifact. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { brotliCompressSync, constants, createBrotliCompress } from 'node:zlib';
import { readDataFile, writeDataFile } from '../../src/project/storage/data-files.mjs';
import {
  loadArtifact,
  openArtifactDatabase,
  storeArtifact,
  storedRuns,
} from '../../src/project/storage/engine-artifacts.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/decoded-limits-'));
const limit = 256 * 1024 * 1024;
const tooLarge = { code: 'STORE_LIMIT', message: /more than 256 MiB/u };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const huge = 'x'.repeat(limit);
// About 160 KB that expands past the bound, compressed a megabyte at a time.
const bomb = await (async () => {
  const stream = createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 0 } }),
    chunks = [],
    zero = Buffer.alloc(1024 * 1024);
  stream.on('data', (chunk) => chunks.push(chunk));
  for (let written = 0; written <= limit; written += zero.length)
    if (!stream.write(zero)) await once(stream, 'drain');
  stream.end();
  await once(stream, 'end');
  return Buffer.concat(chunks);
})();
try {
  const material = join(directory, 'material');
  await mkdir(material);
  await writeDataFile(material, join(material, 'records', 'kept.json'), '{"kept":true}\n');
  const db = new DatabaseSync(join(material, 'material.sqlite'));
  db.prepare('INSERT INTO blocks VALUES (?, ?)').run('b'.repeat(64), bomb);
  db.prepare('INSERT INTO files VALUES (?, ?, NULL)').run('records/bomb.json', 'b'.repeat(64));
  db.close();
  await assert.rejects(readDataFile(material, join(material, 'records', 'bomb.json')), tooLarge);
  assert.equal(
    await readDataFile(material, join(material, 'records', 'kept.json')),
    '{"kept":true}\n',
  );
  await assert.rejects(
    writeDataFile(material, join(material, 'records', 'huge.json'), huge),
    /over 256 MiB/u,
    'A file that could not be read back is not stored',
  );
  await assert.rejects(readDataFile(material, join(material, 'records', 'huge.json')), {
    code: 'ENOENT',
  });

  const artifacts = openArtifactDatabase(join(directory, 'artifacts.sqlite'));
  try {
    artifacts.prepare('INSERT INTO runs VALUES (?, ?, ?)').run('r', bomb, 'c'.repeat(64));
    assert.throws(() => storedRuns(artifacts, 'r'), tooLarge);
    const fragment = (text, payload = brotliCompressSync(Buffer.from('F2\n' + text))) => {
      const ref = digest('F2\n' + text);
      artifacts.prepare('INSERT OR IGNORE INTO fragments VALUES (?, ?, ?)').run(ref, payload, '[]');
      return ref;
    };
    const artifact = (ref) => {
      artifacts.prepare('INSERT OR IGNORE INTO artifacts VALUES (?)').run(ref);
      return ref;
    };
    assert.throws(() => loadArtifact(artifacts, artifact(fragment('{}\n', bomb))), tooLarge);
    // Forty fragments, each naming the one below twice, would parse a leaf 2^40
    // times; the read stops at the bound instead.
    let ref = fragment(JSON.stringify({ data: 'x'.repeat(1024), parts: [] }) + '\n');
    for (let depth = 0; depth < 40; depth++)
      ref = fragment(
        JSON.stringify({
          data: { a: null, b: null },
          parts: [
            [['a'], ref],
            [['b'], ref],
          ],
        }) + '\n',
      );
    const started = performance.now();
    assert.throws(() => loadArtifact(artifacts, artifact(ref)), tooLarge);
    assert(performance.now() - started < 30_000);
    assert.throws(
      () => storeArtifact(artifacts, { text: huge }),
      /over 256 MiB/u,
      'An artifact that could not be read back is not stored',
    );
  } finally {
    artifacts.close();
  }
  console.log('ok decoded limits: blocks, runs, fragments and artifacts read within 256 MiB');
} finally {
  await rm(directory, { recursive: true, force: true });
}
