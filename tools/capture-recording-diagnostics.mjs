/** Export the actual public read-only launcher traces from its maintained test. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { terminalScreenshot } from './support/terminal-screenshots.mjs';
import { captureGallery } from './support/terminal-capture.mjs';

const [argument] = process.argv.slice(2);
assert(argument, 'Pass the directory printed by test/tui/recording-diagnostics.mjs');
const directory = resolve(argument),
  output = join(directory, 'public-screenshots');
await mkdir(output, { recursive: true });
const manifest = [],
  sessions = [];
for (const [session, selected] of [
  [
    'public-recording',
    [
      [1, 'public-source'],
      [15, 'public-help'],
      [16, 'public-openings'],
      [21, 'public-inputs'],
      [22, 'public-home'],
    ],
  ],
  [
    'public-conditional',
    [
      [1, 'public-parent-opening'],
      [2, 'public-context'],
      [3, 'public-proposal'],
      [5, 'public-linked-return'],
    ],
  ],
]) {
  const path = join(directory, session + '.capture.jsonl');
  const frames = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  sessions.push({ name: session, path, frames });
  for (const [index, name] of selected) {
    const frame = frames[index];
    assert(frame && !frame.error);
    const files = await terminalScreenshot(frame, { output, name });
    manifest.push({
      name,
      ...files,
      capture: path,
      frame: index + 1,
      command: frame.command,
      scope:
        'Actual public read-only recording launcher; declared frozen symbolic readings. No project authoring or acquisition correctness claim.',
      test: 'test/tui/recording-diagnostics.mjs',
    });
  }
}
await captureGallery(output, sessions);
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify({ captures: manifest }, null, 2) + '\n',
);
console.log(join(output, 'manifest.json'));
