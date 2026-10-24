import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createWorkbench } from '../../src/tui/shell/app.mjs';
import { createState } from '../../src/tui/shell/state.mjs';

export class JourneyTerminal extends EventEmitter {
  width = 180;
  height = 54;
  frame = '';
  fullFrame = '';
  fullscreen() {}
  hideCursor() {}
  grabInput() {}
  styleReset() {}
  raw(frame) {
    // Header animation updates one line; replay it over the last full redraw
    // so snapshots keep the body and footer, as a real terminal does.
    if (frame.startsWith('\x1b[?2026h\x1b7')) {
      this.frame = this.fullFrame + frame;
    } else {
      this.fullFrame = frame;
      this.frame = frame;
    }
  }
}

export function journeyWorkbench(project, directory, overrides = {}) {
  const config = {
    projectsHome: directory,
    preferencesPath: join(directory, '.layout'),
    noColor: true,
    ...overrides,
  };
  const state = createState(
    { mode: 'project', project, placementId: project.data.placements[0].id },
    config,
  );
  const term = new JourneyTerminal();
  const app = createWorkbench({
    state,
    config,
    term,
    onExit: () => assert.fail('Unexpected exit'),
  });
  app.start();
  const key = async (key, isCharacter = false) => {
    term.emit('key', key, [], { isCharacter });
    await app.idle();
    assert(!state.failure, state.failure);
    assert(!state.form?.error, state.form?.error);
  };
  const text = (text) => key(text, true);
  const submit = async (shortcut = 'CTRL_S') => {
    const form = state.form;
    assert(form, 'An authoring form is visible');
    await key(shortcut);
    await form.execution;
    await app.idle();
    assert(!form.error, form.error);
    return form;
  };
  const selectRole = async (label) => {
    while (state.focus !== 'nodes') await key('TAB');
    await key('HOME');
    const at = state.workflow.roles().findIndex((role) => role.label === label);
    assert(at >= 0, label);
    for (let i = 0; i < at; i++) await key('DOWN');
    assert.equal(state.workflow.role().label, label);
  };
  const ask = async (question) => {
    await key('a');
    await key('ALT_U');
    await text(question);
    await submit('ENTER');
    assert.equal(state.form, null);
    assert(state.workflow.current(), 'A current question and its actual traversal are visible');
    return state.workflow.current();
  };
  const choose = async (matches) => {
    const items = state.form?.move ?? state.workflow.developmentItems();
    const index = items.findIndex((item) =>
      typeof matches === 'string' ? item.label === matches : matches(item),
    );
    assert(index >= 0, 'Visible choice exists');
    await key('HOME');
    for (let i = 0; i < index; i++) await key('DOWN');
    const form = state.form;
    await key('ENTER');
    await form?.execution;
    await app.idle();
    assert(!form?.error, form?.error);
  };
  const selectReading = async (matches) => {
    while (state.focus !== 'reading') await key('TAB');
    const rows = (section) => [
      ...(section.rowChoices ?? []),
      ...(section.table?.entries ?? []).filter((entry) => entry.choiceIndex !== undefined),
      ...(section.groups ?? []).flatMap(rows),
    ];
    const entries = state.workflow.readingView().sections.flatMap(rows);
    const at = entries.findIndex((entry) =>
      typeof matches === 'string' ? entry.source?.text === matches : matches(entry),
    );
    assert(at >= 0, 'A visible reading row exists');
    await key('HOME');
    for (let i = 0; i < at; i++) await key('DOWN');
    assert.equal(state.workflow.readingView().activeChoice, entries[at].choiceIndex);
    return entries[at];
  };
  // The reading pane alone: Development marks its own detail lines with ↳ too.
  const readingText = () =>
    term.frame
      .split(/\x1b\[\d+;1H/u)
      .map((line) => stripVTControlCharacters(line).slice((state.viewport.sidebarWidth ?? 0) + 1))
      .join('\n');
  return {
    app,
    state,
    term,
    key,
    text,
    submit,
    selectRole,
    selectReading,
    ask,
    choose,
    readingText,
  };
}

export async function authorHierarchy(ui, node, parent = null) {
  if (parent) {
    await ui.selectRole(parent);
    await ui.key('c');
    await ui.text(node.role);
    await ui.submit('ENTER');
  }
  await ui.key('n');
  await ui.text(node.statements.join('\n'));
  await ui.submit();
  for (const child of node.children ?? []) await authorHierarchy(ui, child, node.role);
}

export function capturedParser(entries, requests, embeddings = null) {
  return async (url, options) => {
    if (url.endsWith('/embed/texts') && embeddings) {
      const { texts } = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          dimensions: 768,
          model: embeddings.model.split('@')[0],
          revision: embeddings.model.split('@')[1],
          embeddings: texts.map((text) => {
            const at = embeddings.texts.indexOf(text);
            assert(at >= 0, `Retained embedding: ${text}`);
            return [...embeddings.vectors[at], ...Array(640).fill(0)];
          }),
        }),
      };
    }
    assert(url.endsWith('/amr/parse-batch'), `No second reading or answer model: ${url}`);
    const { texts } = JSON.parse(options.body);
    requests.push(...texts);
    return {
      ok: true,
      json: async () =>
        texts.map((text) => {
          const entry = entries.find((entry) => entry.text === text);
          assert(entry, `No untouched acquisition for ${text}`);
          return structuredClone(entry.acquisition);
        }),
    };
  };
}
