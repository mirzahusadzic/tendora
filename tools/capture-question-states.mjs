/** Export asserted controller-state frames, with explicit fixture provenance.
 * The keyboard suite performs the actions and saves the actual coloured renderer
 * output. The terminal decoder below only converts those saved bytes to cells;
 * it is not a second live interaction or evidence of an inferred status.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalScreenshot } from './support/terminal-screenshots.mjs';
import { captureGallery } from './support/terminal-capture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const screenshots = args.includes('--screenshots');
if (screenshots) args.splice(args.indexOf('--screenshots'), 1);
if (args.length > 1)
  throw new Error(
    'Usage: node tools/capture-question-states.mjs [state-frames.json] [--screenshots]',
  );
async function run(command, argv, input) {
  const child = spawn(command, argv, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (bytes) => (stdout += bytes));
  child.stderr.on('data', (bytes) => (stderr += bytes));
  child.stdin.end(input);
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  assert.equal(code, 0, stderr || stdout);
  return stdout;
}
let source = args[0] && resolve(args[0]);
if (!source) {
  const log = await run(process.execPath, ['test/tui/inquiries/keyboard-workflow.mjs']);
  const matrix = /keyboard transitions: (.+\/matrix\.json)/u.exec(log)?.[1];
  assert(matrix, log);
  source = join(dirname(matrix), 'state-frames.json');
}
const declared = JSON.parse(await readFile(source));
const output = join(dirname(source), 'state-captures');
await mkdir(output, { recursive: true });
const sessions = [],
  manifest = [];
for (const item of declared.frames) {
  const path = join(output, item.name + '.capture.jsonl');
  await writeFile(path, '');
  const transcript = await run(
    'python3',
    [
      'test/support/terminal-driver.py',
      '--check',
      '--trace',
      path,
      '--width',
      String(item.width),
      '--height',
      String(item.height),
      '--',
      process.execPath,
      '--input-type=module',
      '-e',
      "import {readFile} from 'node:fs/promises'; process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write(await readFile(process.argv[1]));",
      item.ansi,
    ],
    JSON.stringify({ expect: item.expect, quit: true }) + '\n',
  );
  const frames = transcript.trim().split('\n').map(JSON.parse);
  const frame = frames.at(-1);
  assert(!frame.error, JSON.stringify(frame));
  assert(
    frame.styledRows.some((row) => row.some((span) => span.style.fg)),
    'Actual renderer colours retained',
  );
  sessions.push({ name: item.name, path, frames });
  const files = screenshots ? await terminalScreenshot(frame, { output, name: item.name }) : {};
  manifest.push({
    ...item,
    capture: path,
    frame: frames.length,
    provenance:
      'Saved actual renderer bytes from asserted controller actions, decoded by the maintained terminal parser. This export does not replay the editor interaction.',
    ...files,
  });
}
await captureGallery(output, sessions);
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify({ source, provenance: declared.provenance, captures: manifest }, null, 2) + '\n',
);
console.log(join(output, 'manifest.json'));
