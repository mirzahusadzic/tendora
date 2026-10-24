/** One source interpretation, transfer to a new question, withdrawal and cold reload. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, openProject } from '../../../src/project/authoring/project.mjs';
import { listEngineRuns, readEngineRun } from '../../../src/project/storage/engine-runs.mjs';
import { frozenParser } from '../../support/development-acquisition.mjs';
import { journeyWorkbench } from '../../support/journey-workbench.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/question-reuse-'));
const oldFetch = globalThis.fetch,
  requests = [];
globalThis.fetch = frozenParser(requests);
let ui;
try {
  for (const [name, statements, question, transfer, independent, answer] of [
    [
      'Workshop',
      ['Sam repairs bicycles.'],
      'Who repairs bikes?',
      'Does Sam repair bikes?',
      'Does Sam repair bicycles?',
      'Sam',
    ],
    [
      'Hand',
      [
        'A simulation rehearses possibilities in the digital work.',
        'If a simulation rehearses possibilities in digital work, it supports exploration.',
        'If a simulation supports exploration, the simulation helps the programmer.',
      ],
      'Who is helped by a simulation?',
      'Does a simulation help the programmer?',
      'What rehearses possibilities in the digital work?',
      'programmer',
    ],
  ]) {
    const path = join(directory, name);
    ui = journeyWorkbench(await createProject(path, name, name), directory);
    await ui.key('n');
    await ui.text(statements.join(' '));
    await ui.submit();
    const source = structuredClone(ui.state.project.data.contributions[0]);
    const baseline = await ui.ask(transfer);
    assert.equal(baseline.run.status, 'open');
    if (name === 'Workshop') {
      const candidate = baseline.run.answer.clarifications.find((item) => !item.answerNodeId);
      assert(candidate, 'The real polar query offers a source correspondence, not a participant');
      const before = ui.state.project.digest;
      await ui.key('d');
      const index = ui.state.form.move.findIndex((choice) => choice.candidate === candidate);
      assert(index > 0);
      for (let i = 0; i < index; i++) await ui.key('DOWN');
      assert.match(ui.term.frame, /Confirm source connection/u);
      assert.doesNotMatch(ui.term.frame, /This relationship|Would answer/u);
      assert(
        ui.state.form
          .contextDetails()
          .some(([label, text]) => label === 'Question' && text === transfer),
      );
      assert(
        ui.state.form
          .contextDetails()
          .some(([label, text]) => label === 'Source' && text === candidate.source.text),
      );
      await ui.key('ESCAPE');
      assert.equal(
        ui.state.project.digest,
        before,
        'Reviewing a polar connection adds no evidence',
      );
    }
    const teach = await ui.ask(question);
    assert.equal(teach.run.status, 'open');
    assert(teach.run.answer.clarifications.length);
    assert.match(ui.term.frame, /A connection needs your interpretation/u);
    const digest = ui.state.project.digest;
    await ui.key('d');
    assert.equal(ui.state.form.move[0].label, 'Keep open');
    await ui.submit('ENTER');
    assert.equal(ui.state.project.digest, digest, 'Default selection never authors evidence');
    await ui.key('d');
    await ui.choose((choice) => choice.candidate?.answerLabel === answer);
    const confirmed = ui.state.workflow.current();
    assert.equal(confirmed.run.status, 'supported');
    assert.equal(confirmed.run.answer.answers[0].text, answer);
    const c = ui.state.project.data.contributions.find((c) =>
      c.wordings.some((w) => w.kind === 'clarification'),
    );
    assert(
      c && !c.responses.length,
      'Confirmation supplies a correspondence, not an answer statement',
    );
    const { confirmation } = c.wordings.find((w) => w.kind === 'clarification');
    assert.equal(confirmation.via, 'editor', 'Confirmed in the workbench');
    assert.equal(confirmation.actor, 'local-workbench-user', 'By the declared actor');
    assert.deepEqual(ui.state.project.data.contributions[0], source);
    assert(
      confirmed.recording.sources.every((source) => source.development?.asserted !== false),
      'Questions and declarations never become traversal evidence',
    );
    const gained = await ui.ask(transfer);
    assert.equal(gained.run.status, 'supported');
    assert(gained.run.answer.answers[0].ruleIds.some((id) => id.includes(c.id)));
    assert(
      gained.run.answer.answers[0].derivation.tree,
      'The grammar chart supplies the binding proof',
    );
    const snapshot = structuredClone(await readEngineRun(ui.state.project, gained.run.id));
    const runCount = (await listEngineRuns(ui.state.project)).length;
    await ui.key('o');
    await ui.choose(transfer);
    assert.equal(
      (await listEngineRuns(ui.state.project)).length,
      runCount,
      'Reopening a current question is read only',
    );
    const acquired = requests.length;
    ui.app.dispose();
    ui = journeyWorkbench(await openProject(path), directory);
    await ui.key('o');
    await ui.choose(transfer);
    assert.equal(ui.state.workflow.current().run.status, 'supported');
    await ui.key('u');
    await ui.choose((item) => item.contributionId === c.id);
    assert.equal(ui.state.form.title, 'Withdraw connection');
    assert.equal(ui.state.form.yesNo.yes, false);
    await ui.submit('ENTER');
    assert(
      !ui.state.project.data.contributions.find((item) => item.id === c.id).wordings[0].withdrawn,
    );
    await ui.key('u');
    await ui.choose((item) => item.contributionId === c.id);
    const withdrawal = ui.state.form;
    await ui.key('y', true);
    await withdrawal.execution;
    await ui.app.idle();
    assert.equal(
      ui.state.workflow.current().run.status,
      'open',
      'Withdrawal refreshes the working question',
    );
    assert.equal(
      ui.state.workflow.current().input.question.text,
      transfer,
      'Withdrawal keeps the question being explored',
    );
    assert.match(ui.term.frame, /Answer: Still open\./u);
    assert.equal(requests.length, acquired, 'Withdrawal and refresh use frozen readings only');
    assert.deepEqual(
      await readEngineRun(ui.state.project, gained.run.id),
      snapshot,
      'The earlier proof record is unchanged',
    );
    assert.equal((await ui.ask(independent)).run.status, 'supported');
    ui.app.dispose();
    ui = journeyWorkbench(await openProject(path), directory);
    assert.equal((await ui.ask(transfer)).run.status, baseline.run.status);
    assert.equal((await ui.ask(independent)).run.status, 'supported');
    assert(
      ui.state.project.data.contributions.find((item) => item.id === c.id).wordings[0].withdrawn,
    );
    assert(ui.state.viewport.developmentHeight > 0);
    ui.app.dispose();
  }
  console.log(
    'ok two-domain language confirmation, actual chart transfer, current question reuse, default No, automatic withdrawal refresh and cold reload',
  );
} finally {
  ui?.app.dispose();
  globalThis.fetch = oldFetch;
}
