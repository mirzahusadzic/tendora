/** Author a substantial hierarchy in the editor and follow its questions, offline or live. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProject, openProject, projectTree } from '../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../src/project/storage/acquisitions.mjs';
import { projectInquiryAsset } from '../src/project/inquiries/inquiry.mjs';
import { matchQuestionRoles } from '../src/project/inquiries/role-matching.mjs';
import { listEngineRuns, acquireEngineRunLease } from '../src/project/storage/engine-runs.mjs';
import { compactProjectStorage } from '../src/project/inquiries/project-storage.mjs';
import { theatre, theatreQuestions } from './harbour-theatre.mjs';
import { terminalCapture, captureGallery } from './support/terminal-capture.mjs';

const args = process.argv.slice(2),
  live = args.includes('--live');
if (live) args.splice(args.indexOf('--live'), 1);
if (args.length > 1)
  throw new Error('Usage: node tools/capture-question-journey.mjs [output-directory] [--live]');
await mkdir('tmp', { recursive: true });
const output = args[0] ? resolve(args[0]) : await mkdtemp(resolve('tmp/question-journey-'));
await mkdir(output, { recursive: true });
const path = join(output, 'theatre');
const project = await createProject(path, theatre.name, theatre.role);
let chain;
if (!live) {
  const fixture = JSON.parse(
    await readFile(new URL('../test/support/theatre-acquisitions.json', import.meta.url)),
  );
  await retainAcquisitions(
    project,
    fixture.entries.map((e) => ({
      text: e.text,
      penman: e.acquisition.penman,
      acquisition: e.acquisition,
      origin: { kind: 'parser', profile: 'amr-text-acquisition-v1' },
    })),
  );
}
const embeddings = JSON.parse(
  await readFile(new URL('../test/support/theatre-embeddings.json', import.meta.url)),
);
async function retainRoleMatches() {
  if (live) return;
  const project = await openProject(path);
  const embed = async (texts) => ({
    ...embeddings,
    vectors: texts.map((text) => {
      const at = embeddings.texts.indexOf(text);
      assert(at >= 0, `Retained embedding for: ${text}`);
      return embeddings.vectors[at];
    }),
  });
  for (const role of project.data.placements)
    for (const question of theatreQuestions)
      await matchQuestionRoles(project, projectInquiryAsset(project, role.id, question), { embed });
}
const sessions = [];
const rejectedClutter = [
  'Earlier assessment',
  'Check pending',
  '[Material]',
  '[History]',
  'Saved result:',
];
async function flowSteps(capture) {
  const { step, screen } = capture;
  const role = async (name) => {
    const project = await openProject(path);
    const at = projectTree(project.data).findIndex(({ concept }) => concept.name === name);
    assert(at >= 0, name);
    await step({ keys: ['o', 'TAB', 'HOME', ...Array(at).fill('DOWN')], expect: [name] });
  };
  const development = async (question) => {
    await step({
      keys: ['o', 'HOME'],
      expect: ['Development'],
      reject: ['Continue a question', 'Open question at'],
    });
    for (let i = 0; i < 20; i++) {
      if (
        screen()
          .split('\n')
          .some((line) => line.split('│')[1]?.includes('● ' + question))
      ) {
        await step({ keys: ['ENTER'], expect: ['Question: ' + question] });
        return;
      }
      await step({ keys: ['DOWN'] });
    }
    throw new Error(`Question not found in Development: ${question}`);
  };
  const ask = async (text, answer) => {
    await retainRoleMatches();
    await step({ keys: ['a', 'ALT_U'], text, expect: ['Ask', text] });
    return step({
      keys: ['ENTER'],
      waitFor: `Answer: ${answer}`,
      expect: [`Question: ${text}`],
      reject: rejectedClutter,
      timeout: 120,
    });
  };
  return { role, ask, development };
}
sessions.push(
  await terminalCapture(
    { project: path, output, name: 'author-and-follow', live },
    async (capture) => {
      const { step } = capture;
      const { role, ask } = await flowSteps(capture);
      await step({ expect: ['Roles', 'Development', 'No questions yet'] });
      await step({ keys: ['o', 'a'], expect: ['Ask'] });
      await step({ keys: ['ESC'], expect: ['Development', 'Source statements'] });
      async function author(node, parent) {
        if (parent) {
          await role(parent);
          await step({ keys: ['c'], text: node.role, expect: ['Role name'] });
          await step({ keys: ['ENTER'], expect: [node.role, 'Source statements'] });
        }
        await step({ keys: ['n'], text: node.statements.join(' '), expect: ['Add statements'] });
        await step({
          keys: ['CTRL_S'],
          waitFor: 'Source statements',
          expect: [node.statements[0]],
          reject: rejectedClutter,
          timeout: 120,
        });
        for (const child of node.children ?? []) await author(child, node.role);
      }
      await author(theatre);
      await role('Production');
      await ask(theatreQuestions[0], 'technician');
      await role('Technical production');
      await step({
        keys: ['TAB'],
        expect: ['Who approves the rehearsal?', 'Used in the answer proof'],
      });
      await role('Rigging');
      await step({
        keys: ['TAB'],
        expect: [
          'The technician inspects the rig.',
          'Used in the answer proof',
          'Needed on arrival',
          'approver',
          'answer sought',
        ],
      });
      await role('Lighting');
      await step({
        keys: ['TAB'],
        expect: ['If the technician inspects the rig', 'Carried from above'],
      });
      await role('Front of house');
      await step({
        keys: ['TAB'],
        expect: ['Who approves the rehearsal?', 'Answer: technician'],
        reject: ['Statements at this role did not contribute to the answer'],
      });
      await role('Production');
      await ask(theatreQuestions[3], 'Still open.');
      await role('Technical production');
      await step({ keys: ['TAB'], expect: ['Who approves the curtain?', 'Why no answer'] });
      await role('Production');
      await ask(theatreQuestions[2], 'No');
      await role('Workshop');
      await ask(theatreQuestions[5], 'Still open.');
      await ask(theatreQuestions[4], 'Still open.');
      await step({ keys: ['d'], expect: ['Clarify connection', 'Keep open'] });
      await step({ keys: ['DOWN'], expect: ['Confirm Sam'] });
      await step({
        keys: ['ENTER'],
        waitFor: 'Answer: Sam',
        expect: ['Who repairs bikes?'],
        timeout: 120,
      });
      await ask(theatreQuestions[5], 'Yes');
    },
  ),
);
sessions.push(
  await terminalCapture(
    { project: path, output, name: 'reload-and-withdraw', live },
    async (capture) => {
      const { step } = capture;
      const { role, ask } = await flowSteps(capture);
      await role('Workshop');
      await ask(theatreQuestions[5], 'Yes');
      await step({ keys: ['u'], expect: ['Confirmed connections'] });
      await step({ keys: ['ENTER'], expect: ['Withdraw connection'] });
      await step({
        keys: ['LEFT', 'ENTER'],
        waitFor: 'Answer: Still open.',
        expect: [theatreQuestions[5]],
        reject: rejectedClutter,
        timeout: 120,
      });
      await ask(theatreQuestions[6], 'Yes');
      await role('Production');
      await ask(theatreQuestions[0], 'technician');
    },
  ),
);
sessions.push(
  await terminalCapture(
    { project: path, output, name: 'cold-reload', live, width: 120, height: 38 },
    async (capture) => {
      const { role, ask } = await flowSteps(capture);
      await role('Workshop');
      await ask(theatreQuestions[5], 'Still open.');
      await ask(theatreQuestions[6], 'Yes');
    },
  ),
);
sessions.push(
  await terminalCapture(
    { project: path, output, name: 'development-at-role', live, width: 100, height: 30 },
    async (capture) => {
      const { step } = capture;
      const { role, development } = await flowSteps(capture);
      await development(theatreQuestions[0]);
      await role('Rigging');
      await step({
        keys: ['TAB'],
        expect: ['At Rigging', 'The technician inspects the rig.', 'Used in the answer proof'],
      });
      await step({
        resize: { width: 80, height: 24 },
        keys: ['HOME'],
        expect: ['Development', 'Question:', 'Answer: technician'],
      });
      await step({
        resize: { width: 60, height: 20 },
        expect: ['Develop question', 'Question:'],
      });
      await step({ keys: ['o'], expect: ['Development', 'Who approves the rehearsal?'] });
      await step({ keys: ['ENTER'], expect: ['Develop question', 'Question:'] });
      await step({
        keys: ['HOME', 'DOWN'],
        expect: ['The technician inspects the rig.'],
      });
      await step({
        resize: { width: 120, height: 38 },
        keys: ['HOME'],
        expect: ['Question: Who approves the rehearsal?', 'Answer: technician'],
      });
      await role('Production');
      await step({
        keys: ['TAB'],
        expect: ['Roles matched to the question', 'Technical production'],
      });
      await development(theatreQuestions[6]);
      await step({ expect: ['Workshop', 'Answer: Yes'], reject: rejectedClutter });
      // Reopen the attributed chain after visiting other questions, including cache eviction.
      await development(theatreQuestions[0]);
      await step({
        waitFor: 'Answer: technician',
        expect: ['Question: ' + theatreQuestions[0]],
        timeout: 120,
      });
      // Capture the proof of an editor action without depending on diagnostic retention.
      const current = await openProject(path);
      const release = await acquireEngineRunLease(current, randomUUID());
      try {
        await step({ keys: ['r'], waitFor: 'Answer: technician', timeout: 120 });
        chain = (await listEngineRuns(current)).find(
          (run) => run.questions?.[0]?.text === theatreQuestions[0] && run.status === 'supported',
        );
      } finally {
        await release();
      }
    },
  ),
);
await captureGallery(output, sessions);
assert(chain.answer.answers[0].sourceIds.length >= 3);
assert(chain.answer.answers[0].ruleIds.length >= 2);
assert(chain.answer.answers[0].derivation.tree);
await writeFile(
  join(output, 'verification.json'),
  JSON.stringify(
    {
      acquisitions: live
        ? 'Fresh eGemma AMR and embeddings'
        : 'Unmodified AMRs and embeddings replayed offline',
      statements: 19,
      roles: 8,
      chain: {
        runId: chain.id,
        sources: chain.answer.answers[0].sourceIds,
        rules: chain.answer.answers[0].ruleIds,
        derivation: chain.answer.answers[0].derivation,
      },
      sessions: sessions.map(({ name, path, frames }) => ({
        name,
        path,
        frames: frames.length,
        errors: frames.filter((frame) => frame.error).length,
      })),
    },
    null,
    2,
  ) + '\n',
);
await compactProjectStorage(await openProject(path), { force: true });
console.log(`Verified editor walkthrough: ${join(output, 'captures.html')}`);
