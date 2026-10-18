/** Interaction contracts: visible promise, action, resulting work and recoverability. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import terminalKit from 'terminal-kit';
import { createProject, openProject } from '../../../src/project/authoring/project.mjs';
import {
  journeyWorkbench,
  authorHierarchy,
  capturedParser,
} from '../../support/journey-workbench.mjs';
import { theatre } from '../../../tools/harbour-theatre.mjs';
import { randomUUID } from 'node:crypto';
import {
  saveEngineRun,
  listEngineRuns,
  acquireEngineRunLease,
} from '../../../src/project/storage/engine-runs.mjs';
import { layoutPane } from '../../../src/tui/shell/layout.mjs';
import { createText } from '../../../src/tui/shell/text.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/editor-interaction-matrix-'));
const fixture = JSON.parse(
  await readFile(new URL('../../support/theatre-acquisitions.json', import.meta.url)),
);
const embeddings = JSON.parse(
  await readFile(new URL('../../support/theatre-embeddings.json', import.meta.url)),
);
const fetch = globalThis.fetch;
globalThis.fetch = capturedParser(fixture.entries, [], embeddings);
const matrix = [];
let ui;
let releaseCache;
// Workflow explanations are content. Keyboard commands belong to the pane
// footer and help, not to instructions embedded among the user's statements.
const explanatoryContent = () => {
  const check = (value) =>
    assert.doesNotMatch(
      String(value ?? ''),
      /\bpress\s+(?:[a-z]|enter|escape|esc|tab)\b|\b[ierdn]\s+(?:review|inspect)\b/iu,
      'Working-question content must not contain shortcut instructions',
    );
  const visit = (section) => {
    for (const [label, value, tone] of section.rows ?? []) {
      assert.notEqual(label, 'Next', 'Actions belong in the footer');
      if (tone !== 'input' && tone !== 'amr') check(value);
    }
    for (const table of [section.table, ...(section.tables ?? [])].filter(Boolean))
      for (const entry of table.entries)
        entry.cells.forEach((value, i) => {
          if (entry.cellTones?.[i] !== 'input') check(value);
        });
    for (const group of section.groups ?? []) visit(group);
  };
  for (const section of ui.state.workflow.readingView()?.sections ?? []) visit(section);
};
const row = async (pane, state, action, promise, perform, verify) => {
  const before = ui.term.frame;
  if (promise) assert(before.includes(promise), `Visible promise: ${promise}`);
  explanatoryContent();
  await perform();
  await verify();
  explanatoryContent();
  matrix.push({ pane, state, action, promise, result: 'passed' });
};
const sameQuestion = (text) => assert.equal(ui.state.workflow.current().input.question.text, text);
try {
  ui = journeyWorkbench(
    await createProject(join(directory, 'project'), theatre.name, theatre.role),
    directory,
  );
  await ui.app.idle();
  await row(
    'Development',
    'empty',
    'o',
    'Development',
    () => ui.key('o'),
    () => {
      assert.equal(ui.state.form, null);
      assert.equal(ui.state.focus, 'development');
      assert.match(ui.term.frame, /› Development/u, 'Focus is visible without colour');
      assert.match(ui.term.frame, /No questions yet/u);
    },
  );
  await row(
    'Development',
    'empty',
    'a',
    'a ask here',
    () => ui.key('a'),
    () => {
      assert(ui.state.form.workspace);
      assert.equal(ui.state.focus, 'reading');
    },
  );
  await ui.text('Who approves the rehearsal?');
  await row(
    'Ask',
    'wording entered',
    'Escape',
    'esc back',
    () => ui.key('ESCAPE'),
    () => {
      assert.equal(ui.state.form, null);
      assert(
        ui.state.workflow
          .developmentItems()
          .some((i) => i.question === 'Who approves the rehearsal?'),
      );
    },
  );
  await row(
    'Development',
    'saved draft',
    'o, Enter',
    'Development',
    async () => {
      await ui.key('o');
      await ui.key('ENTER');
    },
    () => assert.equal(ui.state.form.fields[0].value, 'Who approves the rehearsal?'),
  );
  await ui.key('ESCAPE');
  await ui.key('o');
  await ui.key('SHIFT_TAB');
  assert.equal(ui.state.focus, 'reading');
  await row(
    'Question',
    'saved draft in main pane',
    'Enter',
    'Saved; not checked yet.',
    () => ui.key('ENTER'),
    () => assert(ui.state.form.workspace),
  );
  await ui.key('ESCAPE');
  await ui.selectRole('Production');
  await row(
    'Roles',
    'root',
    'c, Escape',
    'c add child',
    async () => {
      await ui.key('c');
      await ui.text('Cancelled child');
      await ui.key('ESCAPE');
    },
    () => assert.equal(ui.state.workflow.roles().length, 1),
  );
  await authorHierarchy(ui, theatre);
  await ui.selectRole('Production');
  await row(
    'Roles',
    'authored role',
    'Enter',
    'enter edit role',
    () => ui.key('ENTER'),
    () => {
      assert.equal(ui.state.form.title, 'Edit role');
      assert.deepEqual(
        ui.state.form.fields.map((field) => field.label),
        ['Role name', 'Description'],
      );
      assert(!ui.term.frame.includes('Sentence 1:'));
    },
  );
  await ui.key('ESCAPE');
  await row(
    'Source statements',
    'existing language',
    'e',
    'e edit statements',
    () => ui.key('e'),
    () => {
      assert.equal(ui.state.form.title, 'Edit statements');
      assert.equal(ui.state.form.fields[0].value, theatre.statements.join('\n'));
      assert(ui.term.frame.includes('ctrl+s save'));
    },
  );
  const unchanged = ui.state.project.digest;
  await row(
    'Edit statements',
    'paragraph pasted over existing text',
    'Alt+U, paste, Escape',
    'esc back',
    async () => {
      await ui.key('ALT_U');
      ui.term.emit('key', 'Keep q, e and n as text.\nKeep this second line too.', [], {
        isCharacter: true,
        isPaste: true,
      });
      await ui.app.idle();
      assert.equal(
        ui.state.form.fields[0].value,
        'Keep q, e and n as text.\nKeep this second line too.',
      );
      await ui.key('ESCAPE');
    },
    () => {
      assert.equal(ui.state.form, null);
      assert.equal(ui.state.project.digest, unchanged);
      assert(ui.term.frame.includes(theatre.statements[0]));
    },
  );
  await row(
    'Source statements',
    'existing statements retained',
    'n',
    'n add statements',
    () => ui.key('n'),
    () => {
      assert.equal(ui.state.form.title, 'Add statements');
      assert.equal(ui.state.form.index, ui.state.form.fields.length - 1);
      assert.equal(ui.state.form.fields[0].value, theatre.statements.join('\n'));
      assert.equal(ui.state.form.fields.at(-1).value, '');
    },
  );
  await ui.key('ESCAPE');
  const question = 'Who approves the rehearsal?';
  // These navigation assertions need retained results. Eviction and automatic
  // reconstruction are exercised independently in tendora.mjs.
  releaseCache = await acquireEngineRunLease(ui.state.project, randomUUID());
  await row(
    'Roles',
    'authored sources',
    'a, text, Enter',
    'a ask here',
    () => ui.ask(question),
    () => {
      assert.match(ui.term.frame, /Answer: technician/u);
      assert(ui.state.workflow.developmentItems().some((i) => i.question === question));
      assert.equal(ui.state.workflow.current().recording.routing.status, 'matched');
    },
  );
  const entries = (group) => [
    ...(group.rowChoices ?? []),
    ...(group.table?.entries ?? []).filter((entry) => entry.choiceIndex !== undefined),
    ...(group.groups ?? []).flatMap(entries),
  ];
  const selectReadingRow = async (predicate) => {
    while (ui.state.focus !== 'reading') await ui.key('TAB');
    const choices = ui.state.workflow.readingView().sections.flatMap(entries);
    const at = choices.findIndex(predicate);
    assert(at >= 0);
    await ui.key('HOME');
    for (let i = 0; i < at; i++) await ui.key('DOWN');
  };
  await selectReadingRow(
    (entry) =>
      entry.placementId ===
      ui.state.workflow.roles().find((role) => role.label === 'Technical production').id,
  );
  await row(
    'Question',
    'matched branches',
    'Enter',
    'enter follow selected role',
    () => ui.key('ENTER'),
    () => {
      sameQuestion(question);
      assert.equal(ui.state.workflow.role().label, 'Technical production');
    },
  );
  const runs = (await listEngineRuns(ui.state.project)).length;
  await row(
    'Roles',
    'working question',
    'select Rigging',
    'Rigging',
    () => ui.selectRole('Rigging'),
    () => {
      sameQuestion(question);
      assert.match(ui.term.frame, /At Rigging/u);
      assert.match(ui.term.frame, /The technician inspects the rig/u);
      assert.match(ui.term.frame, /Used in the answer proof/u);
    },
  );
  await row(
    'Roles',
    'child selected',
    'Left',
    'left parent',
    () => ui.key('LEFT'),
    () => {
      assert.equal(ui.state.workflow.role().label, 'Technical production');
      sameQuestion(question);
    },
  );
  await ui.selectRole('Workshop');
  await ui.ask('Does Sam repair bicycles?');
  assert(
    (await listEngineRuns(ui.state.project)).every((run) => run.inputRef && run.resultRef),
    'Both answers remain available throughout the navigation fixture',
  );
  await row(
    'Development',
    'two questions',
    'o, choose approval',
    'o development',
    async () => {
      await ui.key('o');
      await ui.choose(question);
    },
    () => {
      sameQuestion(question);
      assert.equal(
        ui.state.workflow.role().label,
        'Workshop',
        'A role inside the question branch stays selected',
      );
    },
  );
  await ui.selectRole('Rigging');
  await row(
    'Development',
    'question already current',
    'mouse on working question',
    'Development',
    async () => {
      const id = ui.state.workflow.selectedQuestion().id;
      const hit = ui.state.viewport.developmentHits.find((h) => h.id === id);
      assert(hit, 'The selected question has a visible click target');
      ui.term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: 8, y: hit.y });
      await ui.app.idle();
    },
    () => {
      sameQuestion(question);
      assert.equal(ui.state.workflow.role().label, 'Rigging');
    },
  );
  assert.equal(
    (await listEngineRuns(ui.state.project)).length,
    runs + 1,
    'Selection does not run a new question',
  );
  await releaseCache();
  await row(
    'Development',
    'current question',
    'Enter',
    'enter work on question',
    () => ui.key('ENTER'),
    () => {
      assert.equal(ui.state.focus, 'reading');
      sameQuestion(question);
    },
  );
  await row(
    'Question',
    'current answer',
    'select question, i, Escape',
    null,
    async () => {
      await selectReadingRow((entry) => entry.source?.kind === 'question');
      assert.match(ui.term.frame, /i read selected text/u);
      await ui.key('i');
      assert.match(ui.term.frame, /Check the language reading/u);
      explanatoryContent();
      await ui.key('ESCAPE');
    },
    () => sameQuestion(question),
  );
  // Every pane remains reachable, with the same working question, at supported sizes.
  for (const [width, height] of [
    [180, 54],
    [120, 38],
    [100, 30],
    [80, 24],
    [60, 20],
  ]) {
    await row(
      'All panes',
      `${width}x${height}`,
      'resize, Tab through panes',
      null,
      async () => {
        ui.term.width = width;
        ui.term.height = height;
        ui.term.emit('resize', width, height);
        await ui.app.idle();
        const reached = new Set();
        for (let i = 0; i < 3; i++) {
          await ui.key('TAB');
          reached.add(ui.state.focus);
          const title = {
            nodes: 'Roles',
            development: 'Development',
            reading: 'Develop question',
          }[ui.state.focus];
          assert(
            ui.term.frame.includes(`› ${title}`),
            `Focused ${title} is visible at ${width}x${height}`,
          );
          if (ui.state.focus === 'development')
            assert(
              ui.state.viewport.developmentHits.length > 0,
              'The working question is visible and selectable',
            );
          const frameRows = ui.term.frame.split(/\x1b\[\d+;1H/u).slice(1);
          for (const line of frameRows) {
            const text = line
              .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
              .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '');
            assert(terminalKit.stringWidth(text) <= width, `No row overflows ${width} columns`);
          }
          assert(ui.state.viewport);
          assert(!ui.term.frame.includes('Earlier assessment'));
        }
        assert.equal(reached.size, 3, 'All three panes are reachable at every supported size');
      },
      () => sameQuestion(question),
    );
  }
  ui.term.width = 120;
  ui.term.height = 38;
  ui.term.emit('resize', 120, 38);
  await ui.app.idle();
  await ui.selectRole('Production');
  await ui.ask('Who approves the curtain?');
  await row(
    'Question',
    'unanswered',
    'inspect result',
    'Answer: Still open.',
    async () => {},
    () => {
      assert.match(ui.term.frame, /Why no answer/u);
      assert.doesNotMatch(ui.term.frame, /Answer: technician/u);
    },
  );
  await ui.selectRole('Rigging');
  await row(
    'Roles',
    'narrow layout',
    '? then Escape',
    '? help',
    async () => {
      await ui.key('?');
      assert.match(ui.term.frame, /move role/u);
      assert.match(ui.term.frame, /add sibling/u);
      await ui.key('ESCAPE');
    },
    () => assert.equal(ui.state.focus, 'nodes'),
  );
  await row(
    'Roles',
    'working question with sidebar focus',
    'i',
    null,
    async () => {
      await ui.key('i');
      await ui.choose('Who approves the curtain?');
    },
    () => assert.match(ui.term.frame, /Check the language reading/u),
  );
  await ui.key('ESCAPE');
  const original = ui.state.project.path;
  ui.app.dispose();
  ui = journeyWorkbench(await openProject(join(directory, 'project')), directory);
  await ui.app.idle();
  await row(
    'Development',
    'cold reopen',
    'o, choose approval',
    'Development',
    async () => {
      await ui.key('o');
      await ui.choose(question);
    },
    () => {
      sameQuestion(question);
      assert.match(ui.term.frame, /Answer: technician/u);
    },
  );
  const benchmark = {
    ...ui.state.workflow.current().run,
    id: randomUUID(),
    purpose: 'test-observation',
    startedAt: '2099-01-01T00:00:00.000Z',
  };
  await saveEngineRun(ui.state.project, benchmark);
  await row(
    'Development',
    'separate diagnostic runs exist',
    'refresh work list',
    'Development',
    () => ui.key('o'),
    () => {
      assert(!ui.state.workflow.developmentItems().some((item) => item.run?.id === benchmark.id));
    },
  );
  await ui.selectRole('Rigging');
  await ui.ask('Who inspects the rig?');
  await ui.selectRole('Rigging');
  await row(
    'Roles',
    'question belongs to role being removed',
    'x, confirm removal',
    '? help',
    async () => {
      await ui.key('x');
      assert.equal(ui.state.form.yesNo.yes, false, 'Deleting a role defaults to No');
      await ui.key('LEFT');
      await ui.key('ENTER');
    },
    () => {
      assert.equal(ui.state.form, null);
      assert.match(ui.term.frame, /The role where this question started was removed/u);
      assert.equal(ui.state.workflow.activity(), null, 'A missing scope cannot cause a retry loop');
    },
  );
  await row(
    'Question',
    'original role removed',
    'a',
    'a ask here',
    () => ui.key('a'),
    () => {
      assert.equal(ui.state.form.fields[0].value, 'Who inspects the rig?');
      assert(ui.state.project.data.placements.some((p) => p.id === ui.state.placementId));
    },
  );
  await ui.key('ESCAPE');
  // Actual palette text, including selected rows and errors, stays legible against its surface.
  const text = createText();
  const page = layoutPane({
    height: 8,
    header: [text.row('Pane'), text.row()],
    content: [
      text.row('Source remains visible.'),
      text.row(),
      { ...text.row('Next section', 'section'), keepWithNext: true },
      text.row(),
      text.row('Its content.'),
    ],
  });
  assert(
    !page.rows.some((row) => row.text === 'Next section'),
    'No detached heading at the bottom of the pane',
  );
  const wrapped = text.wrap(
    text.row('Éclairage 技術部 Technical production with a long role name'),
    18,
  );
  assert(wrapped.every((row) => terminalKit.stringWidth(row.text) <= 18));
  assert.equal(
    wrapped
      .map((row) => row.text)
      .join('')
      .replaceAll(' ', ''),
    'Éclairage技術部Technicalproductionwithalongrolename',
  );
  matrix.push({
    pane: 'Reading and lists',
    state: 'wrapping near the viewport edge',
    action: 'wrap and paginate',
    promise: 'Complete labels and headings with content',
    result: 'No lost Unicode text, overwide lines or detached heading',
  });
  const rgb = (hex) =>
    hex.map((n) => {
      n /= 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    });
  const lum = (v) => {
    const [r, g, b] = rgb(v);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const tone of [
    'plain',
    'muted',
    'title',
    'input',
    'warning',
    'error',
    'selected',
    'located',
  ]) {
    for (const surface of [text.background, text.sidebar, text.headerBand]) {
      const painted = text.paint('Sample text', tone, surface);
      const fg = [...painted.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/gu)]
        .at(-1)
        .slice(1)
        .map(Number);
      const bg = [...painted.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/gu)]
        .at(-1)
        .slice(1)
        .map(Number);
      const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
      assert(ratio >= 4.5, `${tone} text contrast: ${ratio}`);
    }
  }
  matrix.push({
    pane: 'All panes',
    state: 'palette',
    action: 'measure actual fg/bg colours',
    promise: 'Readable text, warnings and selection',
    result: '24 text/surface pairs exceed 4.5:1',
  });
  await writeFile(
    join(directory, 'matrix.json'),
    JSON.stringify({ project: original, matrix }, null, 2) + '\n',
  );
  console.log(
    `ok ${matrix.length} interaction/visual contracts: ${join(directory, 'matrix.json')}`,
  );
} finally {
  ui?.app.dispose();
  await releaseCache?.();
  globalThis.fetch = fetch;
}
