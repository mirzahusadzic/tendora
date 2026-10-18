/** Capture either an explicit asset or the actual project workbench through its PTY. */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCrossing } from '../src/inquiry/cross-run.mjs';
import { recordRun } from '../src/recording/format.mjs';

const args = process.argv.slice(2);
const option = (flag) => {
  const at = args.indexOf(flag);
  if (at < 0) return null;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const project = option('--project');
const asset = option('--asset');
const requestedOut = option('--out');
const query = option('--query');
const width = option('--width') ?? '160';
const height = option('--height') ?? '44';
const checked = args.includes('--check');
if (checked) args.splice(args.indexOf('--check'), 1);
if (args.length) throw new Error(`unknown capture options: ${args.join(' ')}`);
if (project && (asset || query))
  throw new Error('--project cannot be combined with --asset or --query');
if (!project && !asset)
  throw new Error('Choose --project for a UI capture or --asset for an engine capture');
// An explicit collision is known before any model work. The exclusive write
// below still protects against a race after this check.
if (requestedOut) {
  try {
    await access(resolve(requestedOut));
    throw new Error(`capture output already exists: ${resolve(requestedOut)}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
if (project) {
  for (const size of [width, height]) {
    if (!/^\d+$/u.test(size) || Number(size) < 20)
      throw new Error('Terminal dimensions must be integers of at least 20');
  }
  const freshName = `workbench-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}.jsonl`;
  const outPath = resolve(requestedOut ?? `recordings/captures/${freshName}`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, '', { flag: 'wx' });
  const root = fileURLToPath(new URL('../', import.meta.url));
  const child = spawn(
    'python3',
    [
      resolve(root, 'test/support/terminal-driver.py'),
      '--trace',
      outPath,
      ...(checked ? ['--check'] : []),
      '--width',
      width,
      '--height',
      height,
      '--',
      process.execPath,
      resolve(root, 'src/tui/workbench.mjs'),
      '--project',
      resolve(project),
    ],
    { stdio: 'inherit' },
  );
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => done(status ?? (signal ? 1 : 0)));
  });
  console.log(`CAPTURED ${outPath}`);
  process.exitCode = code;
} else {
  const assetPath = resolve(asset);
  const assetBytes = await readFile(assetPath, 'utf8');
  const definition = JSON.parse(assetBytes);
  const inquiry = query ?? definition.query;
  const run = await runCrossing(definition, inquiry, (message) => console.log(message));
  const recording = recordRun(run, { assetBytes, assetName: assetPath });
  const slug =
    inquiry
      .toLocaleLowerCase('en')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '')
      .slice(0, 48) || 'inquiry';
  const freshName = `${slug}-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}.json`;
  const outPath = resolve(requestedOut ?? `recordings/captures/${freshName}`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(recording, null, 2) + '\n', { flag: 'wx' });
  console.log(
    `RECORDED ${outPath} - ${recording.visits.length} visits, ` +
      `${recording.occurrences.length} occurrences, ${recording.cycleStops.length} cycle stops`,
  );
}
