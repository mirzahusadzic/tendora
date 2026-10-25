/** The public demo works through the real CLI and PTY without live acquisition. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { terminalCapture, captureGallery } from '../../tools/support/terminal-capture.mjs';

const original = resolve('demo/payments-on-call');
const snapshot = async () => {
  const files = (await readdir(original, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(path.slice(original.length));
    hash.update(await readFile(path));
  }
  return hash.digest('hex');
};
const before = await snapshot();
await mkdir('tmp', { recursive: true });
const output = await mkdtemp(resolve('tmp/payments-acceptance-'));
const project = join(output, 'project');
await cp(original, project, { recursive: true });
const previous = {
  NODE_OPTIONS: process.env.NODE_OPTIONS,
  TENDORA_CAPTURE_NETWORK_LOG: process.env.TENDORA_CAPTURE_NETWORK_LOG,
};
const networkLog = join(output, 'network-attempts.jsonl');
await writeFile(networkLog, '');
process.env.NODE_OPTIONS = [
  previous.NODE_OPTIONS,
  `--import=${pathToFileURL(resolve('tools/support/offline-terminal.mjs')).href}`,
]
  .filter(Boolean)
  .join(' ');
process.env.TENDORA_CAPTURE_NETWORK_LOG = networkLog;

try {
  const question = 'What does the security engineer report?';
  const args = [
    'src/cli/engine.mjs',
    'ask',
    '--project',
    project,
    '--scope',
    'Incident Commander',
    '--question',
    question,
    '--offline',
  ];
  const cli = promisify(execFile);
  const session = await terminalCapture(
    { project, output, name: 'payments-offline', width: 180, height: 54 },
    async ({ step, screen }) => {
      await step({ waitFor: 'Incident Commander', expect: ['Roles'] });
      await step({ keys: ['o'], waitFor: 'Development' });
      // Newer saved questions come first: move down Development until the
      // walkthrough's question is listed there, then select it by pointer.
      const walkthrough = 'What does the release';
      const listed = () =>
        screen()
          .split('\n')
          .findIndex((row) => row.includes(walkthrough) && row.indexOf(walkthrough) < 40);
      for (let i = 0; i < 30 && listed() < 0; i++) await step({ keys: ['DOWN'] });
      const y = listed();
      assert(y >= 0, `Development lists ${walkthrough}`);
      await step({
        mouse: [{ x: screen().split('\n')[y].indexOf(walkthrough) + 2, y: y + 1 }],
      });
      // The list's preview already shows the answer; the saved check shows
      // where it comes from once it has loaded.
      await step({ waitFor: 'Answer comes from', expect: ['Answer: deployments'], timeout: 30 });
      await step({
        keys: ['ESC', 'a', 'ALT_U'],
        text: 'Who freezes deployments during a major incident?',
        expect: ['Case: None (optional)'],
      });
      await step({ keys: ['ENTER'], waitFor: 'Answer: Morgan', timeout: 30 });
      await step({
        keys: ['ESC', 'a', 'ALT_U'],
        text: question,
        expect: ['Case: None (optional)'],
      });
      await step({ keys: ['ENTER'], waitFor: 'Answer: leaked payment key', timeout: 30 });
    },
  );
  const { stdout: readable } = await cli(process.execPath, args, { timeout: 30000 });
  assert.match(readable, /^conditional:/u);
  assert.match(readable, /Answer: leaked payment key/u);
  const { stdout: machine } = await cli(process.execPath, [...args, '--json'], { timeout: 30000 });
  assert.equal(JSON.parse(machine).status, 'conditional');
  assert(!machine.includes('\x1b'));
  await writeFile(join(output, 'cli.txt'), readable);
  await captureGallery(output, [session]);
  assert.equal(
    await readFile(networkLog, 'utf8'),
    '',
    'The public demo never requests acquisition',
  );
  console.log(`ok payments CLI and real PTY; offline evidence: ${output}`);
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  assert.equal(await snapshot(), before, 'The canonical payments demo is unchanged');
}
