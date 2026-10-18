/** Drive and retain real PTY frames through the repository's terminal harness. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function terminalCapture(
  { project, output, name, live = false, color = false, width = 180, height = 54 },
  flow,
) {
  const path = join(output, `${name}.capture.jsonl`);
  const child = spawn(
    process.execPath,
    [
      join(root, 'tools/capture-workbench.mjs'),
      '--project',
      project,
      '--out',
      path,
      '--width',
      String(width),
      '--height',
      String(height),
      '--check',
    ],
    {
      cwd: output,
      env: {
        ...process.env,
        ...(!live ? { EGEMMA_URL: 'http://127.0.0.1:1' } : {}),
        ...(color ? { NO_COLOR: '', TERM: 'xterm-256color' } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const exit = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  let stderr = '';
  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const frames = [];
  const next = async () => {
    while (true) {
      const { value, done } = await lines.next();
      if (done) throw new Error(`${name}: capture ended. ${stderr}`);
      if (!value.startsWith('{')) continue;
      const frame = JSON.parse(value);
      frames.push(frame);
      assert(!frame.error, `${name}: ${frame.error}\n${frame.screen}`);
      return frame;
    }
  };
  let frame;
  const step = async (command) => {
    child.stdin.write(JSON.stringify({ timeout: 30, ...command }) + '\n');
    frame = await next();
    return frame;
  };
  const clickText = async (label, command = {}) => {
    const rows = frame.screen.split('\n');
    const y = rows.findIndex((row) => row.includes(label));
    assert(y >= 0, `Visible text: ${label}\n${frame.screen}`);
    return step({ mouse: [{ x: rows[y].indexOf(label) + 2, y: y + 1 }], ...command });
  };
  try {
    frame = await next();
    await flow({ step, clickText, screen: () => frame.screen, frames });
    await step({ keys: ['CTRL_C'], expectExit: true, quit: true });
    child.stdin.end();
    assert.equal(await exit, 0, stderr);
    return { name, path, frames };
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

export async function captureGallery(output, sessions) {
  const escape = (text) =>
    String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const rendered = (frame) =>
    frame.styledRows
      ? frame.styledRows
          .map((line) =>
            line
              .map(({ text, style }) => {
                const css = [
                  style.fg && `color:${style.fg}`,
                  style.bg && `background:${style.bg}`,
                  style.bold && 'font-weight:bold',
                  style.italic && 'font-style:italic',
                  style.underline && 'text-decoration:underline',
                ]
                  .filter(Boolean)
                  .join(';');
                return `<span style="${css}">${escape(text)}</span>`;
              })
              .join(''),
          )
          .join('\n')
      : escape(frame.screen);
  await writeFile(
    join(output, 'captures.html'),
    `<!doctype html><meta charset="utf-8"><title>Question through the roles</title><style>body{background:#10141a;color:#d7dce3;font:16px system-ui;margin:2rem}pre{font:12px/1.35 monospace;overflow:auto;padding:1.2rem;background:#161d26}summary{cursor:pointer;margin:1rem 0}a{color:#90c3f4}</style><h1>Question through the roles</h1>${sessions
      .map(
        (session) =>
          `<h2>${escape(session.name)}</h2>${session.frames
            .filter((frame) => frame.screen)
            .map(
              (frame, index) =>
                `<details${index === 0 ? ' open' : ''}><summary>Frame ${index + 1}: ${escape(frame.command?.expect?.join(' / ') ?? frame.command?.waitFor ?? 'Editor')}</summary><pre>${rendered(frame)}</pre></details>`,
            )
            .join('')}`,
      )
      .join('')}`,
  );
}
