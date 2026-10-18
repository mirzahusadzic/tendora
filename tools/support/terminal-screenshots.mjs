/** Export observed PTY cells, including their actual colours, for visual review. */
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import terminalKit from 'terminal-kit';

const escape = (text) =>
  String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function terminalFrameHTML(frame) {
  const rows = frame.styledRows
    ? frame.styledRows
    : frame.screen.split('\n').map((text) => [{ text }]);
  const cellWidth = 7.25,
    rowHeight = 16,
    segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const rendered = rows.map((row, rowIndex) => {
    let column = 0;
    return row
      .map(({ text, style = {} }) => {
        const width = terminalKit.stringWidth(text),
          x = column * cellWidth,
          y = rowIndex * rowHeight;
        let result = `<rect x="${x}" y="${y}" width="${width * cellWidth}" height="${rowHeight}" fill="${style.bg ?? '#10141c'}"/>`;
        const pieces = [];
        for (const { segment } of segmenter.segment(text)) {
          // Keep ASCII words compact; whitespace advances cells without glyphs.
          // Fallback-font glyphs have their own positions, so a bold box glyph
          // cannot shift the rest of the row.
          if (/^[\x21-\x7e]+$/u.test(segment) && pieces.at(-1)?.ascii)
            pieces.at(-1).text += segment;
          else pieces.push({ text: segment, ascii: /^[\x21-\x7e]+$/u.test(segment) });
        }
        for (const piece of pieces) {
          const cells = terminalKit.stringWidth(piece.text);
          if (piece.text.trim() && cells) {
            const attributes = [
              `data-column="${column}"`,
              `data-cells="${cells}"`,
              `x="${column * cellWidth}"`,
              `y="${y + 12}"`,
              `textLength="${cells * cellWidth}"`,
              'lengthAdjust="spacingAndGlyphs"',
              `fill="${style.fg ?? '#dae2ef'}"`,
              `font-weight="${style.bold ? 'bold' : 'normal'}"`,
              style.italic && 'font-style="italic"',
              style.underline && 'text-decoration="underline"',
            ]
              .filter(Boolean)
              .join(' ');
            result += `<text ${attributes}>${escape(piece.text)}</text>`;
          }
          column += cells;
        }
        return result;
      })
      .join('');
  });
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{background:#10141c;margin:0;padding:0}svg{margin:12px;font:12px Menlo,monospace;white-space:pre}</style><svg xmlns="http://www.w3.org/2000/svg" width="${frame.width * cellWidth}" height="${frame.height * rowHeight}" xml:space="preserve">${rendered.join('\n')}</svg>`;
}

export async function terminalScreenshot(frame, { output, name, chrome } = {}) {
  chrome ??=
    process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(chrome);
  await mkdir(output, { recursive: true });
  const html = join(output, `${name}.html`),
    png = join(output, `${name}.png`);
  await writeFile(html, terminalFrameHTML(frame));
  const child = spawn(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--disable-default-apps',
      '--metrics-recording-only',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      `--user-data-dir=${join(output, '.chrome-profile')}`,
      '--hide-scrollbars',
      `--window-size=${Math.ceil(frame.width * 7.25 + 28)},${frame.height * 16 + 28}`,
      `--screenshot=${png}`,
      pathToFileURL(html).href,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Screenshot timed out: ${name}`));
    }, 30_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (code !== 0) throw new Error(`Screenshot failed (${code}): ${name}\n${stderr}`);
  await access(png);
  return { html, png };
}
