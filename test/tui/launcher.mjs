/** Help and pipelines never start an interactive editor or mutate project material. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, saveProject } from '../../src/project/authoring/project.mjs';
import { workbenchArguments } from '../../src/tui/shell/arguments.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/workbench-launcher-'));
const entry = fileURLToPath(new URL('../../src/tui/workbench.mjs', import.meta.url));
const run = (...args) =>
  spawnSync(process.execPath, [entry, ...args], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10000,
  });
for (const args of [[], ['--help'], ['-h'], ['--nonsense', '--project', '-h']]) {
  const output = run(...args);
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /Usage:/u);
  assert.match(output.stdout, /--recording PATH/u);
  assert.equal(output.stderr, '');
  assert(!output.stdout.includes('\x1b'), 'Piped help has no terminal escape codes');
}
for (const [args, expected] of [
  [['--project'], /argument missing/u],
  [['--project', ''], /needs a value/u],
  [['--project', 'a', '--project', 'b'], /only be given once/u],
  [['--wat'], /Unknown option/u],
  [['stray'], /Unexpected argument/u],
  [['--node', 'node'], /requires --recording/u],
  [['--snapshot'], /requires --project/u],
  [['--project', 'absent', '--recording', 'absent'], /cannot be combined/u],
  [['--recording', 'absent', '--detail', 'invalid'], /--detail must/u],
  [['--project', 'absent'], /ENOENT/u],
]) {
  const output = run(...args);
  assert.equal(output.status, 1);
  assert.equal(output.stdout, '');
  assert.match(output.stderr, expected);
  assert.match(output.stderr, /Use --help/u);
  assert(!output.stderr.includes('    at '), 'Expected input errors do not print a stack');
}
assert.equal(workbenchArguments([], { NO_COLOR: '0' }).noColor, true);
assert.equal(workbenchArguments([], { NO_COLOR: '' }).noColor, false);
assert.equal(workbenchArguments([], { TERM: 'dumb' }).noColor, true);
assert.equal(workbenchArguments(['--color'], { NO_COLOR: '1' }).noColor, false);
assert.equal(workbenchArguments(['--color', '--no-color'], {}).noColor, true);
assert.equal(workbenchArguments(['--no-color', '--color'], {}).noColor, false);

let project = await createProject(join(directory, 'project'), 'Workshop project', 'Workshop');
const data = structuredClone(project.data);
data.concepts[0].description = 'Workshop tasks\nRepair and inspection';
data.concepts[0].passages = ['Sam repairs bicycles.\nThe team inspects brakes.'];
data.contributions = [
  {
    version: 1,
    id: 'retained-statement',
    kind: 'material',
    scopePlacementId: data.placements[0].id,
    wordings: [],
    responses: [
      {
        id: 'source',
        text: 'The workshop opens at dawn.\nThe team prepares tools.',
        graph: { top: 'w', nodes: [{ id: 'w', concept: 'workshop' }], edges: [] },
      },
    ],
  },
];
project = await saveProject(project, data);
const before = await readFile(project.path, 'utf8');
for (const args of [
  ['--project', join(directory, 'project')],
  ['--project', project.path, '--snapshot'],
]) {
  const output = run(...args);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stderr, '');
  assert.match(output.stdout, /Workshop project\nWorkshop\n/u);
  assert.match(output.stdout, /Sam repairs bicycles\./u);
  assert.match(
    output.stdout,
    /  Description: Workshop tasks\n               Repair and inspection\n/u,
  );
  assert.match(output.stdout, /  Sam repairs bicycles\.\n  The team inspects brakes\.\n/u);
  assert.match(output.stdout, /  The workshop opens at dawn\.\n  The team prepares tools\.\n/u);
  assert.equal(output.stdout.split('The workshop opens at dawn.').length, 2);
  assert(!output.stdout.includes('\x1b'));
}
assert.equal(await readFile(project.path, 'utf8'), before);

// Close the reader before the child writes, checking the writer's exit status
// directly; a shell pipeline could hide an unhandled EPIPE behind its consumer.
for (const args of [['--help'], ['--project', project.path, '--snapshot']]) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.equal(stderr, '', 'A downstream closed pipe produces no stack or usage error');
}
console.log(
  'ok workbench help, arguments, color precedence, multiline source snapshots and closed pipes',
);
