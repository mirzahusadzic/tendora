/** Complete language authoring and top-down question flow through the actual shell. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, openProject } from '../../../src/project/authoring/project.mjs';
import { listEngineRuns } from '../../../src/project/storage/engine-runs.mjs';
import { checkAnswer } from '../../../src/engine/answer.mjs';
import {
  checkCheckpoint,
  explorationPlan,
  explorationRecordProfile,
  exploreRoles,
} from '../../../src/engine/role-exploration.mjs';
import { theatre } from '../../../tools/harbour-theatre.mjs';
import {
  journeyWorkbench,
  authorHierarchy,
  capturedParser,
} from '../../support/journey-workbench.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/theatre-workflow-'));
const fixture = JSON.parse(
  await readFile(new URL('../../support/theatre-acquisitions.json', import.meta.url)),
);
const oldFetch = globalThis.fetch,
  requests = [];
const embeddings = JSON.parse(
  await readFile(new URL('../../support/theatre-embeddings.json', import.meta.url)),
);
globalThis.fetch = capturedParser(fixture.entries, requests, embeddings);
let ui;
try {
  const project = await createProject(join(directory, 'project'), theatre.name, theatre.role);
  ui = journeyWorkbench(project, directory);
  await ui.app.idle();
  assert(ui.state.viewport.developmentHeight > 0);
  assert.match(ui.term.frame, /No questions yet/u);
  await ui.key('o');
  assert.equal(ui.state.form, null, 'Development is a working pane, not a picker');
  await ui.key('a');
  await ui.text('Who approves the rehearsal?');
  await ui.key('ESCAPE');
  assert(
    ui.state.workflow
      .developmentItems()
      .some((item) => item.question === 'Who approves the rehearsal?' && !item.run),
    'Unsubmitted wording stays in Development',
  );
  await ui.key('o');
  await ui.key('ENTER');
  assert(ui.state.form.workspace);
  assert.equal(ui.state.form.fields[0].value, 'Who approves the rehearsal?');
  await ui.key('ESCAPE');
  await ui.selectRole('Production');
  await authorHierarchy(ui, theatre);
  assert.equal(ui.state.project.data.placements.length, 8);
  assert.equal(ui.state.project.data.contributions.flatMap((c) => c.responses).length, 19);
  assert(ui.state.project.data.contributions.every((c) => c.question === null));
  await ui.selectRole('Production');
  assert(ui.state.viewport.developmentHeight > 0);
  assert.equal(ui.state.viewport.recordingsHeight, 0);
  assert.doesNotMatch(ui.term.frame, /Earlier assessment|Check pending|\[Material\]|\[History\]/u);
  const approval = await ui.ask('Who approves the rehearsal?');
  await writeFile(join(directory, 'approval-screen.txt'), ui.term.frame);
  await writeFile(join(directory, 'approval.json'), JSON.stringify(approval, null, 2));
  assert.equal(
    approval.run.status,
    'supported',
    'The engine composes the three attributed premises',
  );
  assert.equal(approval.recording.visits.length, 8, 'Ask actually traverses every role in scope');
  assert(
    approval.run.answer.answers[0].ruleIds.length >= 2,
    'Both generated conditional rules contribute',
  );
  assert.match(ui.term.frame, /Answer: technician/u);
  assert.match(ui.term.frame, /Technical production/u);
  assert.match(ui.term.frame, /Rigging/u);
  assert.match(ui.term.frame, /Lighting/u);
  assert.equal(approval.recording.routing.status, 'matched');
  assert.match(approval.recording.routing.model, /embeddinggemma/u);
  const rootVisit = approval.recording.visits[0];
  const firstChild = approval.recording.visits.find(
    (v) => v.id === rootVisit.return.childVisitIds[0],
  );
  assert.equal(
    approval.recording.nodes.find((n) => n.id === firstChild.nodeId).label,
    'Technical production',
  );
  const exploration = approval.result.exploration;
  assert.equal(exploration.ordering, 'embedding-ranked');
  assert.equal(exploration.visits.length, 8);
  assert(exploration.complete);
  const introduced = new Set();
  for (const visit of exploration.visits) {
    for (const id of visit.sourceIds) introduced.add(id);
    const check = exploration.checks[visit.outgoingCheck];
    if (check?.nodeId !== visit.nodeId) continue;
    assert.deepEqual(new Set(check.sourceIds), introduced);
    for (const answer of check.answers) {
      assert(
        answer.sourceIds.every((id) => introduced.has(id)),
        'Unvisited roles cannot supply a proof',
      );
      assert(answer.derivation?.tree, 'Every early answer has its actual chart proof');
    }
  }
  // Checkpoints are independent: each checked again alone, in reverse order and
  // with views of its own, gives the record the exploration kept.
  const plan = explorationPlan(approval.input, approval.result);
  const record = ({ id: _id, elapsedMs: _elapsed, ...check }) => JSON.parse(JSON.stringify(check));
  assert.equal(exploration.profile, explorationRecordProfile);
  for (const check of [...exploration.checks].reverse())
    assert.deepEqual(
      record(
        checkCheckpoint(ui.state.project, approval.input, approval.result, plan, check.level).check,
      ),
      record(check),
      `Checkpoint ${check.level} checked alone`,
    );
  const firstProof = exploration.checks.find((c) => c.answers.length);
  assert(
    firstProof.visitedRoles < exploration.visits.length,
    'A binding is found during ranked exploration',
  );
  assert.equal(approval.recording.nodes.find((n) => n.id === firstProof.nodeId).label, 'Lighting');
  assert(
    exploration.checks.slice(0, firstProof.id).every((c) => c.openings.length && !c.answers.length),
  );
  assert.equal(
    exploration.checks.at(-1).sourceIds.length,
    19,
    'Final check includes every scoped source',
  );
  const bindings = (answer) =>
    answer.answers.map((a) => ({
      text: a.text,
      sources: [...a.sourceIds].sort(),
      rules: [...a.ruleIds].sort(),
    }));
  assert.deepEqual(
    bindings(checkAnswer(ui.state.project, approval.input, approval.result)),
    bindings(approval.run.answer),
  );
  const reversed = structuredClone(approval.input);
  for (const node of reversed.exploration.nodes) node.children.reverse();
  const reverseResult = await exploreRoles(ui.state.project, reversed, approval.result);
  assert.notDeepEqual(
    reverseResult.exploration.visits.map((v) => v.nodeId),
    exploration.visits.map((v) => v.nodeId),
  );
  assert.deepEqual(
    bindings(reverseResult.answer),
    bindings(approval.run.answer),
    'Ordering changes discovery, not attributed truth',
  );
  const count = requests.length;
  await ui.selectRole('Rigging');
  assert.match(ui.term.frame, /Who approves the rehearsal\?/u, 'Changing role keeps the question');
  assert.match(ui.term.frame, /The technician inspects the rig\./u);
  assert.match(ui.term.frame, /Used in the answer proof/u);
  assert.match(ui.term.frame, /Needed on arrival/u);
  const arriving = ui.state.workflow
    .readingView()
    .sections[0].groups.find((group) => group.heading === 'Needed on arrival');
  assert(
    arriving.table.entries.some(
      (entry) =>
        JSON.stringify(entry.cells) === JSON.stringify(['approve', 'approver', 'answer sought']),
    ),
    'The parent’s unresolved relation travels with the whole question, in separate columns',
  );
  assert.doesNotMatch(ui.term.frame, /Carried opening:/u);
  assert.equal(requests.length, count, 'Following the recorded visits never reparses text');
  await ui.selectRole('Front of house');
  assert.equal(ui.state.workflow.role().label, 'Front of house');
  assert(
    !ui.state.workflow
      .readingView()
      .sections[0].groups.some((group) => group.heading === 'At Front of house'),
    'Unrelated local statements do not crowd the working question',
  );
  assert.doesNotMatch(ui.term.frame, /Nora.*Used in the answer proof/u);
  await ui.selectRole('Production');
  const unknown = await ui.ask('Who approves the curtain?');
  assert.equal(unknown.run.status, 'open');
  assert.match(ui.term.frame, /Answer: Still open/u);
  assert.match(ui.term.frame, /Why no answer/u);
  await ui.selectRole('Technical production');
  assert.match(ui.term.frame, /Who approves the curtain/u);
  const negative = await ui.ask('Does the rig support the curtain?');
  assert.equal(negative.run.status, 'supported');
  assert.equal(negative.run.answer.answers[0].text, 'No');
  assert.match(ui.term.frame, /Answer: No/u, 'Polarity survives the hierarchy');
  await ui.selectRole('Workshop');
  const workshop = await ui.ask('Does Sam repair bicycles?');
  await ui.selectRole('Rigging');
  const rigging = ui.state.placementId;
  const beforeOpen = {
    requests: requests.length,
  };
  await ui.key('o');
  assert.equal(ui.state.form, null);
  assert.equal(ui.state.focus, 'development');
  assert.equal(
    ui.state.workflow.developmentItems().length,
    4,
    'One item per question, without repeated check entries',
  );
  await ui.choose('Who approves the rehearsal?');
  // Selecting a Workshop question navigates to Workshop; the scope is never hidden.
  await ui.selectRole('Rigging');
  assert.equal(ui.state.placementId, rigging);
  const reopened = ui.state.workflow.current();
  assert.equal(reopened.input.question.text, approval.input.question.text);
  assert.deepEqual(
    reopened.run.answer.answers,
    approval.run.answer.answers,
    'A bounded-cache recheck preserves the attributed answer and proof',
  );
  const reopenedRuns = (await listEngineRuns(ui.state.project)).length;
  assert.match(ui.term.frame, /At Rigging/u);
  assert.match(ui.term.frame, /Asked at: Production/u);
  assert(ui.term.frame.indexOf('At Rigging') < ui.term.frame.indexOf('Answer comes from'));
  await ui.key('o');
  assert.equal(ui.state.workflow.selectedQuestion().run.id, reopened.run.id);
  await ui.key('ENTER');
  assert.equal(
    requests.length,
    beforeOpen.requests,
    'Browsing and reopening do not request acquisition',
  );
  assert.equal(
    (await listEngineRuns(ui.state.project)).length,
    reopenedRuns,
    'Opening a current question does not resubmit it',
  );
  const path = ui.state.project.path;
  ui.app.dispose();
  ui = journeyWorkbench(await openProject(join(directory, 'project')), directory);
  await ui.key('o');
  await ui.choose((item) => item.label === 'Who approves the rehearsal?');
  assert.equal(ui.state.workflow.current().input.question.text, approval.input.question.text);
  assert.deepEqual(ui.state.workflow.current().run.answer.answers, approval.run.answer.answers);
  assert.equal(requests.length, beforeOpen.requests, 'Cold reopening retains acquisition');
  assert.match(ui.term.frame, /Answer: technician/u);
  assert.equal(ui.state.workflow.current().recording.visits.length, 8);
  console.log(
    `PASS hierarchy workflow: 19 statements, eight roles, attributed rule chain, negative and unknown controls, reload. ${path}`,
  );
} finally {
  ui?.app.dispose();
  globalThis.fetch = oldFetch;
}
