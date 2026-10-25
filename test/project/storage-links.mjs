/** Project storage stays inside its project (final review #8): a store, its
 * journal, a lease or a storage directory that is a symbolic link is refused,
 * and nothing is written where it points. The project directory itself may be
 * reached through a link. */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, openProject } from '../../src/project/authoring/project.mjs';
import { writeDataFile } from '../../src/project/storage/data-files.mjs';
import { openArtifactDatabase } from '../../src/project/storage/engine-artifacts.mjs';
import { acquireFileLease } from '../../src/project/storage/locks.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/storage-links-'));
const refused = /symbolic link/u;
const absent = (path) =>
  access(path).then(
    () => assert.fail(`Nothing may be written through a link: ${path}`),
    (error) => assert.equal(error.code, 'ENOENT'),
  );
try {
  const outside = join(directory, 'outside');
  await mkdir(outside);

  const material = join(directory, 'material');
  await mkdir(material);
  await symlink(join(outside, 'material.sqlite'), join(material, 'material.sqlite'));
  await assert.rejects(
    writeDataFile(material, join(material, 'records', 'planted.json'), '{}\n'),
    refused,
  );
  await absent(join(outside, 'material.sqlite'));
  const journal = join(directory, 'journal');
  await mkdir(journal);
  await symlink(join(outside, 'journal'), join(journal, 'material.sqlite-journal'));
  await assert.rejects(
    writeDataFile(journal, join(journal, 'records', 'planted.json'), '{}\n'),
    refused,
    'nor a journal beside it',
  );

  const artifacts = join(directory, 'artifacts');
  await mkdir(join(artifacts, 'engine'), { recursive: true });
  await symlink(join(outside, 'artifacts.sqlite'), join(artifacts, 'engine', 'artifacts.sqlite'));
  assert.throws(() => openArtifactDatabase(join(artifacts, 'engine', 'artifacts.sqlite')), refused);
  await absent(join(outside, 'artifacts.sqlite'));
  const engine = join(directory, 'engine-link');
  await mkdir(engine);
  await symlink(outside, join(engine, 'engine'));
  assert.throws(
    () => openArtifactDatabase(join(engine, 'engine', 'artifacts.sqlite')),
    refused,
    'nor an engine directory that is a link',
  );
  await absent(join(outside, 'artifacts.sqlite'));

  // A linked lease is refused at once, not taken for a live owner until a
  // timeout says the project is busy.
  const lease = join(directory, 'lease');
  await mkdir(lease);
  await writeFile(join(outside, 'owner'), JSON.stringify({ pid: process.pid }) + '\n');
  await symlink(join(outside, 'owner'), join(lease, 'held.lock'));
  await assert.rejects(acquireFileLease(join(lease, 'held.lock'), { timeoutMs: 50 }), refused);

  // A project with linked storage does not open; one reached through a link does.
  const project = await createProject(join(directory, 'project'), 'Links');
  await symlink(outside, join(directory, 'project', 'recordings'));
  await assert.rejects(openProject(join(directory, 'project')), refused);
  await rm(join(directory, 'project', 'recordings'));
  await symlink(join(directory, 'project'), join(directory, 'project-link'));
  assert.equal((await openProject(join(directory, 'project-link'))).data.id, project.data.id);
  assert.deepEqual(await readdir(outside), ['owner']);
  console.log('ok storage links: linked stores, journals, leases and storage directories refused');
} finally {
  await rm(directory, { recursive: true, force: true });
}
