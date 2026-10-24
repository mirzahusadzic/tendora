/** The decomposed service example, including independent cases and attributed conditional proofs. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createProject, openProject } from '../../../src/project/authoring/project.mjs';
import {
  journeyWorkbench,
  authorHierarchy,
  capturedParser,
} from '../../support/journey-workbench.mjs';
import { tendora, tendoraQuestions, tendoraCases } from '../../../tools/tendora-service.mjs';
import {
  compactEngineStorage,
  engineStorageUsage,
  engineStorageBudget,
} from '../../../src/project/inquiries/engine-storage.mjs';
import { readEngineRun } from '../../../src/project/storage/engine-runs.mjs';
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/tendora-tree-'));
const fixture = JSON.parse(
  await readFile(new URL('../../support/tendora-service-acquisitions.json', import.meta.url)),
);
const embed = JSON.parse(
  await readFile(new URL('../../support/tendora-service-embeddings.json', import.meta.url)),
);
const original = globalThis.fetch,
  requests = [];
globalThis.fetch = capturedParser(fixture.entries, requests, embed);
let ui = journeyWorkbench(
  await createProject(join(directory, 'project'), tendora.name, tendora.role),
  directory,
);
try {
  await authorHierarchy(ui, tendora);
  await ui.selectRole('Tendora');
  assert.equal(ui.state.project.data.placements.length, 12);
  assert.equal(ui.state.project.data.contributions.flatMap((c) => c.responses).length, 17);
  for (const [q, answer] of [
    [tendoraQuestions[0], 'billing team'],
    [tendoraQuestions[1], 'billing team'],
    [tendoraQuestions[2], 'account team'],
  ]) {
    const c = await ui.ask(q);
    assert.equal(c.run.answer.answers[0].text, answer);
    assert(c.run.answer.answers[0].derivation.tree);
    assert.equal(c.result.exploration.visits.length, 12);
  }
  // “Returns” is read return-01 in the question and return-02 in the source:
  // the question's sense is read in the source's sense, and cited.
  const returns = await ui.ask(tendoraQuestions[3]);
  assert.equal(returns.run.answer.answers[0].text, 'customer service');
  assert.equal(returns.run.answer.answers[0].readAs, 'word-form');
  // These current acquisition/binding limitations remain explicit; no fixture repair or alias.
  for (const q of tendoraQuestions.slice(4)) assert.equal((await ui.ask(q)).run.status, 'open', q);
  const askCase = async (text) => {
    await ui.key('a');
    await ui.key('ALT_U');
    await ui.text('Who offers human assistance?');
    await ui.key('ALT_C');
    await ui.choose('Write a case');
    await ui.text(text);
    await ui.submit();
    await ui.submit('ENTER');
    return ui.state.workflow.current();
  };
  const caseAnswers = [];
  for (const [i, text] of tendoraCases.entries()) {
    const c = await askCase(text),
      answer = c.run.answer.answers[0];
    caseAnswers.push(c);
    assert.equal(answer.text, i ? 'account team' : 'billing team');
    assert.equal(answer.ruleIds.length, 2);
    assert.equal(answer.sourceIds.length, 3);
    assert(answer.derivation.tree);
    assert.equal(c.input.cases.length, 1);
    const sourceRows = (section) => [
      ...(section.table?.entries ?? []),
      ...(section.groups ?? []).flatMap(sourceRows),
    ];
    assert.equal(
      ui.state.workflow
        .readingView()
        .sections.flatMap(sourceRows)
        .filter((row) => row.source?.kind === 'case' && row.source.text === text).length,
      1,
      'The attributed case remains directly reviewable without a repeated Case readings row',
    );
    assert(
      !ui.state.project.data.contributions.some((c) => c.responses.some((r) => r.text === text)),
      'The case never becomes a corpus assertion',
    );
  }
  assert.notEqual(caseAnswers[0].run.id, caseAnswers[1].run.id);
  assert(
    ui.state.workflow
      .developmentItems()
      .filter((i) => i.question === 'Who offers human assistance?').length === 3,
    'No-case and both cases remain distinct questions',
  );
  await ui.selectRole('Login failures');
  const arriving = ui.state.workflow
    .readingView()
    .sections[0].groups.find((group) => group.heading === 'Needed on arrival');
  assert.deepEqual(
    arriving.table.entries.map((e) => e.cells),
    [
      ['offer', 'entity offering', 'answer sought'],
      ['offer', 'commodity', 'assist'],
      ['assist', 'assistant', 'answer sought ↩'],
      ['assist', 'assisted', 'human'],
    ],
    'The table retains argument roles and the shared answer participant',
  );
  assert.match(ui.term.frame, /These sources complete the answer/u);
  assert.match(ui.term.frame, /Source statement.*Contribution.*Reading/u);
  assert.match(ui.term.frame, /│ Review/u);
  assert.doesNotMatch(ui.term.frame, /Meaning:|Why flagged:/u);
  const row = ui.state.workflow
    .readingView()
    .sections[0].groups.find((g) => g.heading === 'At Login failures').table.entries[0];
  const hit = ui.state.viewport.choiceHits.find((h) => h.index === row.choiceIndex);
  assert(hit, 'The source row has a visible review target');
  ui.term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', {
    x: ui.state.viewport.sidebarWidth + 8,
    y: hit.y,
  });
  await ui.app.idle();
  assert.match(ui.term.frame, /Check the language reading/u);
  assert.equal(
    ui.state.workflow.readingView().sections[0].rows[0][1],
    row.source.text,
    'Clicking a source row reviews that exact source',
  );
  assert.match(ui.term.frame, /to enter into a computer/u);
  await ui.key('ESCAPE');
  await ui.selectReading(tendoraCases[1]);
  await ui.key('i');
  await ui.key('e');
  assert.equal(ui.state.form.title, 'Edit case');
  assert.equal(ui.state.form.fields[0].value, tendoraCases[1]);
  assert.equal(ui.state.form.returnForm.fields[0].value, 'Who offers human assistance?');
  await ui.key('ESCAPE');
  await ui.key('ESCAPE');
  await ui.key('ESCAPE');
  await ui.selectRole('Tendora');
  await ui.selectReading(
    'If a ticket concerns a login failure, customer service routes the ticket to the account team.',
  );
  await ui.key('i');
  await ui.key('e');
  assert.equal(
    ui.state.workflow.role().label,
    'Login failures',
    'A supporting source is edited at its own role, not the role being inspected',
  );
  assert(
    ui.state.form.fields[ui.state.form.index].value.includes(
      'If a ticket concerns a login failure',
    ),
  );
  const field = ui.state.form.fields[ui.state.form.index];
  assert(
    Array.from(field.value)
      .slice(field.cursor)
      .join('')
      .startsWith('If a ticket concerns a login failure'),
    'The cursor goes to the reviewed statement within a multi-statement field',
  );
  await ui.key('ESCAPE');
  await ui.key('ESCAPE');
  const calls = requests.length;
  ui.app.dispose();
  ui = journeyWorkbench(await openProject(join(directory, 'project')), directory);
  await ui.key('o');
  await ui.choose(
    (item) =>
      item.question === caseAnswers[1].input.question.text &&
      item.caseSelection?.placementId === caseAnswers[1].input.caseSelection.placementId,
  );
  assert.equal(ui.state.workflow.current().run.answer.answers[0].text, 'account team');
  assert.equal(requests.length, calls);
  assert((await engineStorageUsage(ui.state.project)).bytes <= engineStorageBudget);
  // Force an actual cache miss, then reopen through Development without acquiring text again.
  ui.app.dispose();
  await compactEngineStorage(await openProject(join(directory, 'project')), {
    force: true,
    budget: 96 * 1024,
  });
  const evicted = [];
  for (const prior of caseAnswers)
    if ((await readEngineRun(prior.project, prior.run.id)).cache === 'recheck') evicted.push(prior);
  assert(evicted.length, 'An independent-case result was evicted by the smaller cache');
  const prior = evicted[0];
  ui = journeyWorkbench(await openProject(join(directory, 'project')), directory);
  await ui.key('o');
  await ui.choose(
    (item) =>
      item.question === prior.input.question.text &&
      item.caseSelection?.placementId === prior.input.caseSelection.placementId,
  );
  const rebuilt = ui.state.workflow.current();
  assert(rebuilt, 'Reopening a retained question rebuilds an evicted check');
  assert.deepEqual(rebuilt.input.caseSelection, prior.input.caseSelection);
  assert.equal(rebuilt.run.answer.answers[0].text, prior.run.answer.answers[0].text);
  assert.deepEqual(rebuilt.run.answer.answers[0].sourceIds, prior.run.answer.answers[0].sourceIds);
  assert.deepEqual(rebuilt.run.answer.answers[0].ruleIds, prior.run.answer.answers[0].ruleIds);
  assert(rebuilt.run.answer.answers[0].derivation.tree);
  assert.equal(requests.length, calls, 'Cache eviction never causes another AMR request');
  assert((await engineStorageUsage(ui.state.project)).bytes <= engineStorageBudget);
  console.log(
    'ok Tendora: 12 roles, 17 ordinary statements, matched exploration, two independently grounded two-rule proofs, controls and cold reopen',
  );
} finally {
  ui.app.dispose();
  globalThis.fetch = original;
}
