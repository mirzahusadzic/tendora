/** Screenshot glyph advance follows terminal cells, including fallback fonts. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import terminalKit from 'terminal-kit';
import { terminalFrameHTML } from '../../tools/support/terminal-screenshots.mjs';

const output = spawnSync(
  'python3',
  [
    'test/support/terminal-driver.py',
    '--check',
    '--width',
    '12',
    '--height',
    '4',
    '--',
    process.execPath,
    '--input-type=module',
    '-e',
    "process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('\\x1b[2J\\x1b[H│\\x1b[1m┃\\x1b[22m│\\r\\n海e\\u0301│');",
  ],
  {
    encoding: 'utf8',
    input: JSON.stringify({ expect: ['│┃│', '海é│'], quit: true }) + '\n',
    timeout: 10000,
  },
);
assert.equal(output.status, 0, output.stderr || output.stdout);
const frame = JSON.parse(output.stdout.trim().split('\n').at(-1));
assert.equal(frame.screen.split('\n')[1], '海é│');
for (const row of frame.styledRows) {
  assert.equal(
    row.reduce((sum, span) => sum + terminalKit.stringWidth(span.text), 0),
    frame.width,
    'Wide glyph continuation cells are not exported as an extra space',
  );
}
const html = terminalFrameHTML(frame);
assert.match(
  html,
  /data-column="1" data-cells="1" x="7\.25"[^>]*textLength="7\.25"[^>]*font-weight="bold">┃/u,
);
assert.match(html, /data-column="2" data-cells="1" x="14\.5"[^>]*>│/u);
assert.match(html, /data-column="0" data-cells="2" x="0"[^>]*textLength="14\.5"[^>]*>海/u);
assert.match(html, /data-column="2" data-cells="1" x="14\.5"[^>]*>é/u);
assert.match(html, /data-column="3" data-cells="1" x="21\.75"[^>]*>│/u);
assert(!html.includes('<script'), 'Capture rendering requires no script or external resource');
console.log(
  'ok terminal screenshots preserve bold border positions, wide cells and combining text',
);
