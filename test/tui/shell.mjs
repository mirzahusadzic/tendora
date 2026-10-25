import { penmanEdgeLocations } from '../../src/tui/recordings/penman.mjs';
import { graphPenmanLines } from '../../src/tui/recordings/graph-preview.mjs';
import { prepareGraphs } from '../../src/models/graph-preparation.mjs';
import {
  readInvestigation,
  currentAsk,
  newInvestigation,
  addAsk,
  saveInvestigation,
} from '../../src/project/inquiries/investigation.mjs';
/** Exercise the real TUI controllers through terminal events, without a live TTY or models. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbench } from '../../src/tui/shell/app.mjs';
import { createState } from '../../src/tui/shell/state.mjs';
import {
  indexRecording,
  initialSelection,
  rankedFindings,
  selectNode,
  viewModel,
} from '../../src/tui/recordings/view.mjs';
import { createRecordingContent } from '../../src/tui/recordings/recording-content.mjs';
import { createText } from '../../src/tui/shell/text.mjs';
import { createContent } from '../../src/tui/shell/content.mjs';
import { engineSections } from '../../src/tui/engine/view.mjs';
import { caseName, unavailableReadings } from '../../src/tui/shell/wording.mjs';
import { tableWidths } from '../../src/tui/shell/layout.mjs';
import { detailTable } from '../../src/tui/shell/tree.mjs';
import { createProject, saveProject, openProject } from '../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import xterm from 'terminal-kit/lib/termconfig/xterm.js';

class TestTerminal extends EventEmitter {
  width = 140;
  height = 38;
  frames = [];
  fullscreen(value) {
    this.alternateScreen = value;
  }
  hideCursor(value = true) {
    this.cursorHidden = value;
  }
  grabInput(value) {
    this.input = value;
  }
  styleReset() {}
  raw(value) {
    this.frames.push(value);
  }
}

// Edge annotations must follow variable identity, including inverse edges and reentrancies.
{
  const penman =
    '(r / recognize-02 :ARG0 (p / person :ARG0-of (w / work-01))\n' +
    '  :ARG1 p :value "a/b" :consist-of (x / thing))';
  const graph = {
    nodes: [{ id: 'literal:3', concept: 'a/b' }],
    edges: [
      { id: 'a', from: 'r', role: ':ARG0', to: 'p' },
      { id: 'b', from: 'w', role: ':ARG0', to: 'p' },
      { id: 'c', from: 'r', role: ':ARG1', to: 'p' },
      { id: 'd', from: 'r', role: ':value', to: 'literal:3' },
      { id: 'e', from: 'r', role: ':consist-of', to: 'x' },
    ],
  };
  const locations = penmanEdgeLocations(penman, graph);
  assert.deepEqual(
    locations.map((item) => [item.edgeId, penman.slice(item.start, item.end)]),
    [
      ['a', ':ARG0'],
      ['b', ':ARG0-of'],
      ['c', ':ARG1'],
      ['d', ':value'],
      ['e', ':consist-of'],
    ],
  );
  assert.deepEqual(penmanEdgeLocations('(invalid', graph), []);
  graph.top = 'r';
  graph.nodes.push(
    ...[
      ['r', 'recognize-02'],
      ['p', 'person'],
      ['w', 'work-01'],
      ['x', 'thing'],
    ].map(([id, concept]) => ({ id, concept })),
  );
  const before = JSON.stringify(graph),
    lines = graphPenmanLines(graph),
    rendered = lines.map((line) => line.text).join('\n');
  assert.deepEqual(
    penmanEdgeLocations(rendered, graph)
      .map((item) => item.edgeId)
      .sort(),
    graph.edges.map((edge) => edge.id).sort(),
    'Live AMR preserves every relation, inverse direction, literal and shared node',
  );
  assert.equal(new Set(lines.map((line) => line.edgeId).filter(Boolean)).size, graph.edges.length);
  assert.equal(JSON.stringify(graph), before, 'The AMR preview never mutates the source graph');

  // Composition namespaces variables and literals. Its preview must still be valid
  // PENMAN, preserving shared participants and exact quoted/bare constant values.
  const composed = {
    top: `answer:${graph.top}`,
    nodes: [
      ...graph.nodes.map((n) => ({
        ...n,
        id: `answer:${n.id}`,
        ...(n.id === 'literal:3' ? { literal: '"a/b"' } : {}),
      })),
      { id: 'v0', concept: 'thing' },
      { id: 'answer:mode', concept: 'imperative', literal: 'imperative' },
      { id: 'answer:number', concept: '7', literal: '"7"' },
    ],
    edges: [
      ...graph.edges.map((e) => ({ ...e, from: `answer:${e.from}`, to: `answer:${e.to}` })),
      { id: 'mod', from: 'answer:r', role: ':mod', to: 'v0' },
      { id: 'mode', from: 'answer:r', role: ':mode', to: 'answer:mode' },
      { id: 'value', from: 'answer:r', role: ':value', to: 'answer:number' },
    ],
  };
  const saved = JSON.stringify(composed),
    preview = graphPenmanLines(composed),
    variables = new Map(
      preview.flatMap((line) => {
        const name = line.text.match(/\((\w+) \/ /u)?.[1];
        return name ? [[line.nodeId, name]] : [];
      }),
    ),
    composedPenman = preview.map((line) => line.text).join('\n');
  const prepared = (await prepareGraphs([{ penman: composedPenman }])).results[0];
  assert(prepared.ok, JSON.stringify(prepared.diagnostics));
  const triples = (g, names = new Map()) => {
    const literal = new Map(
      g.nodes.filter((n) => n.literal !== undefined).map((n) => [n.id, n.literal]),
    );
    const id = (value) => literal.get(value) ?? names.get(value) ?? value;
    return [
      ...g.nodes.filter((n) => !literal.has(n.id)).map((n) => [id(n.id), ':instance', n.concept]),
      ...g.edges.map((e) => [id(e.from), e.role, id(e.to)]),
    ]
      .map((triple) => JSON.stringify(triple))
      .sort();
  };
  assert.deepEqual(triples(prepared.graph), triples(composed, variables));
  assert.equal(JSON.stringify(composed), saved);

  const source = { id: 'source', kind: 'source', text: 'Composed source', graph: composed };
  const missing = { id: 'question', kind: 'question', text: 'Unacquired question' };
  const input = { sources: [source], cases: [], question: missing };
  const sections = engineSections(null, input, null, { Sources: 1 });
  assert.equal(
    sections[3].groups[0].groups[0].rows.find(([label]) => label === 'AMR')[1],
    'Not captured',
  );
  const openings = engineSections(
    {
      id: 'saved',
      projectDigest: 'digest',
      status: 'open',
      candidates: [],
      openings: [{ sourceId: source.id }],
    },
    input,
    null,
  )[2];
  assert.equal(
    openings.groups[0].rows.find(([label]) => label === 'Source AMR')[1],
    composedPenman,
  );
}

// A case is named by its label, else its text or its sources' texts; a check
// saved before selections were kept names it as text. Never "[object Object]".
assert.equal(caseName({ label: 'Inspection', text: 'An inspection is due.' }), 'Inspection');
assert.equal(
  caseName({ placementId: 'p', sources: [{ text: 'An inspection is due.' }] }),
  'An inspection is due.',
);
assert.equal(caseName({ placementId: 'p' }), 'Selected case');
assert.equal(caseName('An inspection is due.'), 'An inspection is due.');
// Every view names a case through caseName, never by its label alone, which a
// case selected without one lacks (review 2026-10-25, #11).
for (const file of await readdir('src/tui', { recursive: true })) {
  if (!file.endsWith('.mjs') || file.endsWith('wording.mjs')) continue;
  const source = await readFile(join('src/tui', file), 'utf8');
  assert.doesNotMatch(
    source,
    /(?:caseSelection|retained)\??\.label\b/u,
    `${file} names a case by its label alone`,
  );
}
const directory = await mkdtemp(join(tmpdir(), 'tendora-tui-'));
const config = {
  projectsHome: directory,
  preferencesPath: join(directory, '.workbench.json'),
  defaultRecording: new URL('', import.meta.url).pathname,
  noColor: true,
};

function session(initial, overrides = {}) {
  const term = new TestTerminal(),
    exits = [];
  const state = createState({ project: null, ix: null, selection: null, ...initial }, config);
  const app = createWorkbench({
    state,
    config: { ...config, ...overrides },
    term,
    onExit: (code) => exits.push(code),
  });
  const signals = process.listenerCount('SIGINT');
  app.start();
  assert.deepEqual(exits, [], state.failure);
  const key = async (key, isCharacter = false) => {
    term.emit('key', key, [], { isCharacter });
    await app.idle();
    assert.deepEqual(exits, [], `Unexpected exit after ${key}: ${state.failure}`);
    assert.equal(state.failure, '', `Action failed after ${key}`);
  };
  const paneText = (pane) =>
    [...term.frames.at(-1).matchAll(/\x1b\[(\d+);1H([^\x1b]*)/gu)]
      .flatMap(([, y, line]) => {
        const at = Number(y),
          v = state.viewport;
        if (at > v.headerHeight + v.bodyHeight) return pane === 'global' ? [line] : [];
        if (at <= v.headerHeight) return [];
        if (pane === 'global') return [];
        if (pane === 'reading') return [line.slice(v.sidebarWidth ? v.sidebarWidth + 1 : 0)];
        const leftPane = v.recordingsHeight && at > v.recordingsTop ? 'recordings' : 'nodes';
        return leftPane === pane ? [line.slice(0, v.sidebarWidth)] : [];
      })
      .join('\n');
  const formActionsVisible = (...labels) => {
    const lines = term.frames.at(-1).split(/\x1b\[\d+;1H/u);
    for (const label of labels) {
      const line = lines.find((line) => line.includes(label));
      assert(line, `Missing form action: ${label}`);
      assert(line.includes('│'), `Form action must be inside its pane: ${label}`);
    }
  };
  return { app, state, term, exits, signals, key, formActionsVisible, paneText };
}

const selectionBackground = '\x1b[48;2;44;65;96m';
const sidebarItemLine = (term, y) => {
  const frame = term.frames.at(-1);
  const line = frame.split(`\x1b[${y};1H`)[1]?.split(`\x1b[${y + 1};1H`)[0] ?? '';
  const first = line.indexOf('│'),
    last = line.indexOf('│', first + 1);
  const raw = line.slice(first + 1, last);
  return {
    raw,
    text: raw.replace(/\x1b\[[0-9;]*m/gu, '').trim(),
    prefix: raw.includes(selectionBackground)
      ? raw.slice(0, raw.indexOf(selectionBackground)).replace(/\x1b\[[0-9;]*m/gu, '')
      : '',
  };
};

try {
  const first = session({ mode: 'home' });
  const { app, state, term, key } = first;
  try {
    // Create, edit, cancel, save and undo through the actual form/key controllers.
    await key('ENTER');
    first.formActionsVisible('enter next field', 'ctrl+s save', 'esc back');
    await key('Workbench test', true);
    await key('ENTER');
    assert.equal(state.form.fields[1].value, join(directory, 'workbench-test'));
    await key('ENTER');
    await key('Home', true);
    await key('ENTER');
    assert.equal(state.mode, 'project');
    assert.equal(state.form, null);
    const original = await readFile(state.project.path, 'utf8');
    const projectSelection = state.placementId;
    await key('w');
    assert.equal(state.mode, 'home');
    assert.match(first.paneText('nodes'), /esc back to project/);
    await key('w'); // Staying on Projects must not replace its return destination.
    await key('DOWN');
    await key('ENTER');
    assert(state.projectChoices);
    await key('ESCAPE');
    assert.equal(state.projectChoices, null);
    await key('ESCAPE');
    assert.equal(state.mode, 'project');
    assert.equal(state.placementId, projectSelection);
    assert.equal(state.homeReturn, null);

    assert.match(first.paneText('nodes'), /c add child/);
    assert.match(first.paneText('nodes'), /a ask here/);
    // The roles pane lists what acts on the selected role; app-wide keys live in the footer.
    assert.doesNotMatch(first.paneText('nodes'), /w projects|o development|first child/);
    assert.match(first.paneText('global'), /w projects/);
    assert.doesNotMatch(first.paneText('nodes'), /n add material|d develop|a ask corpus/);
    assert.equal(state.viewport.recordingsHeight, 0);
    assert.equal(first.paneText('recordings'), '');
    assert.doesNotMatch(first.paneText('global'), /recordings/);
    await key('TAB');
    assert.equal(state.focus, 'reading');
    await key('SHIFT_TAB');
    assert.equal(state.focus, 'nodes');

    await key('c');
    await key('Discarded child', true);
    await key('ESCAPE');
    assert.equal(await readFile(state.project.path, 'utf8'), original);
    await key('c');
    await key('Child', true);
    await key('ENTER');
    assert.equal(state.project.data.concepts.length, 2);
    const childId = state.placementId;
    await key('TAB'); // Empty recordings have no pane.
    assert.equal(state.focus, 'reading');
    await key('ENTER');
    first.formActionsVisible('ctrl+s save', 'esc back', 'alt+u clear');
    assert.deepEqual(
      state.form.fields.map((field) => field.label),
      ['Role name', 'Description'],
    );
    assert.doesNotMatch(first.paneText('reading'), /Sentence 1|add sentence/u);
    await key('TAB');
    await key('D', true);
    await key('U', true);
    assert.equal(state.form.fields[state.form.index].value, 'DU');
    await key('ALT_U');
    await key('A role description.', true);
    await key('ESCAPE');
    const source = JSON.parse(
      await readFile(new URL('../support/theatre-acquisitions.json', import.meta.url)),
    ).entries.find((entry) => entry.text === 'Sam repairs bicycles.');
    await retainAcquisitions(state.project, [
      {
        text: source.text,
        penman: source.acquisition.penman,
        acquisition: source.acquisition,
        origin: { kind: 'test-fixture' },
      },
    ]);
    await key('n');
    await key(source.text, true);
    const statementsForm = state.form;
    await key('CTRL_S');
    await statementsForm.execution;
    await app.idle();
    assert.equal(state.form, null);
    const saved = await openProject(join(directory, 'workbench-test'));
    assert(saved.data.contributions.some((c) => c.responses.some((r) => r.text === source.text)));
    assert(saved.data.concepts.every((concept) => concept.passages.length === 0));
    while (state.focus !== 'nodes') await key('TAB');
    await key('ENTER');
    assert.deepEqual(
      state.form.fields.map((field) => field.label),
      ['Role name', 'Description'],
    );
    assert.equal(state.form.fields[state.form.index].label, 'Role name');
    await key('ALT_U');
    await key('Renamed child', true);
    await key('CTRL_S');
    const renamed = await openProject(join(directory, 'workbench-test'));
    assert.equal(
      renamed.data.concepts.find(
        (concept) =>
          concept.id ===
          renamed.data.placements.find((placement) => placement.id === childId).conceptId,
      ).name,
      'Renamed child',
    );
    assert.match(first.paneText('nodes'), /● Renamed child/u);
    assert(first.paneText('global').includes('ctrl+z undo'), 'Undo belongs to the global footer');
    assert(
      !first.paneText('nodes').includes('u undo') &&
        !first.paneText('reading').includes('ctrl+z undo'),
    );
    await key('CTRL_Z');
    assert(!state.project.data.concepts.some((concept) => concept.name === 'Renamed child'));
    assert.match(first.paneText('nodes'), /● Child/u);
    assert(first.paneText('global').includes('ctrl+y redo'));
    await key('CTRL_Y');
    assert(state.project.data.concepts.some((concept) => concept.name === 'Renamed child'));
    assert.match(first.paneText('nodes'), /● Renamed child/u);
    await key('ESCAPE');
    await key('CTRL_Z'); // Restore the name before the remaining undo checks.
    await key('ESCAPE');
    await key('l');
    assert.equal(state.form, null, 'Removed organization shortcut has no action');
    await key('a');
    assert.equal(state.focus, 'reading');
    assert.match(first.paneText('reading'), /alt\+c case/);
    await key('ALT_C');
    await key('END');
    await key('ENTER');
    assert.equal(state.form.caseSelection.placementId, state.placementId);
    assert.equal(state.focus, 'reading');
    first.formActionsVisible('enter run', 'ctrl+s save draft', 'esc back');
    assert(state.form.inquiry);
    await key('CTRL_S');
    assert(!state.form.busy);
    assert.doesNotMatch(first.paneText('reading'), /ctrl\+s ask/);
    await key('TAB');
    assert.equal(state.focus, 'nodes');
    await key('c');
    assert.equal(state.form.caseSelection.placementId, state.placementId);
    await key('TAB');
    // Simulate a pending worker to test cancellation without calling the network.
    const controller = new AbortController();
    state.form.controller = controller;
    state.form.busy = true;
    app.draw();
    first.formActionsVisible('esc cancel');
    assert(!term.frames.at(-1).includes('enter run'));
    await key('ESCAPE');
    assert(controller.signal.aborted);
    assert.equal(state.serviceStatus.egemma, 'cancelled');
    assert(state.form.workspace);
    assert.equal(state.form.busy, false);
    await key('ESCAPE');
    assert.equal(state.form, null);
    assert.equal(state.focus, 'nodes');
    await key('CTRL_Z');
    assert(state.project.data.concepts.every((concept) => concept.passages.length === 0));
    assert.equal(state.placementId, childId);
    await key('CTRL_Z');
    assert.equal(state.project.data.concepts.length, 1);
    await key('s');
    await key('Second root', true);
    await key('ENTER');
    assert(
      !state.actionProvider().some((action) => action.key === 'CTRL_Y'),
      'A new edit clears redo',
    );
    await key('m');
    first.formActionsVisible('enter move branch', 'esc back');
    await key('DOWN');
    await key('ENTER');
    assert(
      state.project.data.placements.find((placement) => placement.id === state.placementId)
        .parentId,
    );
    await key('x');
    first.formActionsVisible('enter confirm', 'esc back');
    assert.equal(state.form.title, 'Delete role');
    assert.match(first.paneText('reading'), /Role: Second root/u);
    assert.doesNotMatch(first.paneText('reading'), /Concept:/u);
    assert.match(first.paneText('reading'), /Yes[\s\S]*No/u);
    assert.match(first.paneText('reading'), /● No/u, 'Default is visible without color');
    assert.equal(state.form.yesNo.yes, false);
    const deletionTarget = state.placementId,
      reviewDigest = state.project.digest;
    const otherNode = state.viewport.nodeHits.find((hit) => hit.id !== deletionTarget);
    assert(otherNode);
    term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: 3, y: otherNode.y });
    await app.idle();
    assert.equal(state.form, null, 'Clicking another pane dismisses review without confirming it');
    assert.equal(state.focus, 'nodes');
    assert.equal(state.placementId, otherNode.id);
    assert.equal(state.project.digest, reviewDigest, 'Review dismissal does not change the corpus');
    const originalNode = state.viewport.nodeHits.find((hit) => hit.id === deletionTarget);
    term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: 3, y: originalNode.y });
    await app.idle();
    await key('x');
    await key('ENTER');
    assert.equal(state.form, null, 'No cancels deletion');
    assert.equal(state.project.data.concepts.length, 2);
    await key('x');
    await key('DOWN');
    assert.equal(state.form.yesNo.yes, true);
    assert.match(first.paneText('reading'), /● Yes/u);
    await key('ENTER');
    assert.equal(state.project.data.concepts.length, 1);
    await key('CTRL_Z');
    assert.equal(state.project.data.concepts.length, 2);
    // Resize cancel preserves preferences; a completed drag saves them.
    const width = state.preferredSidebar;
    term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: state.viewport.sidebarWidth + 1, y: 8 });
    term.emit('mouse', 'MOUSE_DRAG', { x: 51, y: 8 });
    await key('ESCAPE');
    assert.equal(state.preferredSidebar, width);
    term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: state.viewport.sidebarWidth + 1, y: 8 });
    term.emit('mouse', 'MOUSE_LEFT_BUTTON_RELEASED', { x: 51, y: 8 });
    await app.idle();
    assert.equal(JSON.parse(await readFile(config.preferencesPath, 'utf8')).sidebarWidth, 50);
    await key('q');
    first.formActionsVisible('enter confirm', 'esc back');
    await key('ESCAPE');
    assert.equal(state.quitPrompt, null);
    assert.equal(state.focus, 'nodes');
    term.emit('key', 'CTRL_C', [], {});
    await app.idle();
    assert.deepEqual(first.exits, [0]);
    assert.equal(term.input, false);
    assert.equal(term.alternateScreen, false);
    assert.equal(term.cursorHidden, false);
    assert.equal(term.listenerCount('key'), 0);
    assert.equal(process.listenerCount('SIGINT'), first.signals);
    console.log('ok TUI creation, editing, undo, worker cancellation, resize and terminal cleanup');
  } finally {
    app.dispose();
  }

  // Both default and explicitly named roots must show the saved role name,
  // independently of the project title. Assert rendered tree text, not just data.
  for (const rootName of [undefined, 'Initial role']) {
    const path = join(directory, rootName ? 'explicit-root' : 'default-root');
    const project = await createProject(path, 'Rename project', rootName);
    const placementId = project.data.placements[0].id;
    const initial = rootName ?? project.data.name;
    let renaming = session({ mode: 'project', project, placementId });
    const visibleRole = (name) => {
      assert(
        renaming.paneText('nodes').includes(`● ${name}`),
        `Tree shows the saved role: ${name}`,
      );
      assert.equal(renaming.state.placementId, placementId);
      assert.equal(renaming.state.project.data.name, 'Rename project');
    };
    try {
      await renaming.app.idle();
      visibleRole(initial);
      await renaming.key('ENTER');
      await renaming.key('ALT_U');
      await renaming.key('Policy', true);
      await renaming.key('CTRL_S');
      assert.equal(renaming.state.form, null);
      visibleRole('Policy');
      assert(!renaming.paneText('nodes').includes(`● ${initial}`));
      await renaming.key('CTRL_Z');
      visibleRole(initial);
      await renaming.key('CTRL_Y');
      visibleRole('Policy');
      await renaming.key('ENTER');
      assert.equal(renaming.state.form.fields[0].value, 'Policy');
      await renaming.key('ALT_U');
      await renaming.key('Discarded name', true);
      await renaming.key('ESCAPE');
      visibleRole('Policy');
      renaming.app.dispose();
      renaming = session({ mode: 'project', project: await openProject(path), placementId });
      await renaming.app.idle();
      visibleRole('Policy');
      await renaming.key('ENTER');
      assert.equal(renaming.state.form.fields[0].value, 'Policy');
    } finally {
      renaming.app.dispose();
    }
  }
  console.log('ok rendered root and child names follow save, undo, redo, cancellation and reopen');

  const quit = session({
    mode: 'project',
    project: await openProject(join(directory, 'workbench-test')),
    placementId: state.placementId,
  });
  try {
    await quit.key('ENTER');
    assert.equal(quit.state.form?.title, 'Edit role');
    await quit.key('q', true);
    assert(quit.state.form.fields[quit.state.form.index].value.includes('q'));
    await quit.key('ALT_Q');
    assert.deepEqual(quit.exits, [], 'Alt+Q has no quit binding');
    assert(!quit.paneText('global').includes('alt+q'));
    await quit.key('ESCAPE');
    await quit.key('q');
    assert(quit.state.quitPrompt, 'q opens the usual quit confirmation');
    assert(quit.paneText('reading').includes('Yes'));
    quit.term.emit('key', 'y', [], { isCharacter: true });
    await quit.app.idle();
    assert.deepEqual(quit.exits, [0], 'q then confirmation exits cleanly');
  } finally {
    quit.app.dispose();
  }

  const background = session(
    {
      mode: 'project',
      project: await openProject(join(directory, 'workbench-test')),
      placementId: state.placementId,
    },
    { noColor: false },
  );
  try {
    await background.app.idle();
    // Keep the activity pending independently of a form to exercise the real
    // renderer and animation timer without a model or a timing-dependent query.
    let activity = { progress: 'Checking answer support' };
    background.state.engineActivity = () => activity;
    background.app.draw();
    assert.equal(background.state.form, null);
    assert(background.state.animatedHeader, 'A background check activates the header sweep');
    const plain = background.term.frames.at(-1).replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '');
    assert.match(plain, /Checking corpus/u);
    assert.match(plain, /Checking answer support/u);
    const before = background.term.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 90));
    const ticks = background.term.frames.slice(before);
    assert(ticks.length > 0, 'The header animates while no form is busy');
    assert(ticks.every((frame) => frame.includes('\x1b7\x1b[1;1H')));
    activity = null;
    background.app.draw();
    assert.equal(background.state.animatedHeader, null);
    const stopped = background.term.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(background.term.frames.length, stopped, 'The animation stops with the activity');
  } finally {
    background.app.dispose();
  }
  // An absent selected question must not accidentally select ID-less spacer
  // rows and scroll a long saved question to its tail in the compact sidebar.
  const longProject = await createProject(join(directory, 'long-questions'), 'Workshop', 'Work');
  const longQuestion =
    'Which workshop participant should inspect the repaired stage mechanism before the evening rehearsal begins and the production opens to visitors?';
  for (let index = 0; index < 3; index++) {
    const question = `${longQuestion} ${index + 1}`;
    await saveInvestigation(
      longProject,
      addAsk(newInvestigation(longProject, question), {
        question,
        scopePlacementId: longProject.data.placements[0].id,
      }),
    );
  }
  const longQuestions = session({
    mode: 'project',
    project: longProject,
    placementId: longProject.data.placements[0].id,
  });
  try {
    await longQuestions.app.idle();
    assert.equal(longQuestions.state.projectDevelopmentOutline().length, 3);
    assert.equal(longQuestions.state.selectedDevelopmentEntry(), undefined);
    for (const [width, height] of [
      [120, 38],
      [80, 24],
    ]) {
      longQuestions.term.width = width;
      longQuestions.term.height = height;
      longQuestions.term.emit('resize', width, height);
      await longQuestions.app.idle();
      assert.equal(longQuestions.state.developmentOffset, 0);
      assert.match(longQuestions.paneText('nodes'), /Which workshop/u);
    }
    const firstQuestion = longQuestions.state.projectDevelopmentOutline()[0];
    longQuestions.state.projectEntryId = firstQuestion.id;
    longQuestions.state.focus = 'development';
    longQuestions.state.developmentOffset = 5;
    longQuestions.app.draw();
    assert.equal(longQuestions.state.developmentOffset, 0);
    assert.match(longQuestions.paneText('nodes'), /Which workshop/u);
    assert(longQuestions.state.viewport.developmentHits.some((hit) => hit.id === firstQuestion.id));
    console.log(
      'ok oversized Development questions retain their identifying prefix at compact widths',
    );
  } finally {
    longQuestions.app.dispose();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
