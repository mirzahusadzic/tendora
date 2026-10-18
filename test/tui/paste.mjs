/** Bracketed multi-line/Unicode paste is data, including strings that resemble shortcuts. */
import assert from 'node:assert/strict';
import { createPasteDecoder } from '../../src/tui/shell/paste.mjs';
import { createProject } from '../../src/project/authoring/project.mjs';
import { journeyWorkbench } from '../support/journey-workbench.mjs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
const data = [],
  pastes = [];
const decoder = createPasteDecoder(
  (bytes) => data.push(bytes),
  (text) => pastes.push(text),
);
const bytes = Buffer.from('a\x1b[200~First line.\n第二行.\nCTRL_C\x1b[201~b');
for (const byte of bytes) decoder.input(Buffer.from([byte]));
assert.equal(Buffer.concat(data).toString(), 'ab');
assert.deepEqual(pastes, ['First line.\n第二行.\nCTRL_C']);
decoder.input(Buffer.from('\x1b'));
await new Promise((r) => setTimeout(r, 25));
assert.equal(Buffer.concat(data).toString(), 'ab\x1b', 'A standalone Escape remains a key');
decoder.dispose();
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/paste-workflow-'));
const ui = journeyWorkbench(await createProject(directory, 'Paste', 'Sources'), directory);
const paste = async (text) => {
  ui.term.emit('key', text, [], { isCharacter: true, isPaste: true });
  await ui.app.idle();
};
try {
  await paste('q');
  assert.equal(ui.state.quitPrompt, null, 'Paste outside a text field never executes a shortcut');
  await ui.key('n');
  await paste('First line.\r\n第二行.');
  assert.equal(ui.state.form.fields[0].value, 'First line.\n第二行.');
  assert(!ui.state.form.busy, 'Pasted newline never submits');
  await paste('CTRL_S');
  assert(ui.state.form.fields[0].value.endsWith('CTRL_S'));
  assert(!ui.state.form.busy);
  await ui.key('ESCAPE');
  await ui.key('ENTER');
  await ui.key('ALT_U');
  await paste('Role\nlabel');
  assert.equal(ui.state.form.fields[0].value, 'Role label', 'Single-line metadata stays one line');
  console.log(
    'ok terminal paste: fragmented delimiters, Unicode, multi-line text, literal shortcut names, form isolation and Escape',
  );
} finally {
  ui.app.dispose();
}
