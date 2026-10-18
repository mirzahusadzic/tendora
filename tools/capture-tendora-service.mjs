/** Build the decomposed Tendora example using the real terminal editor, then check its case proofs. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProject, openProject, projectTree } from '../src/project/authoring/project.mjs';
import { sourceCatalog } from '../src/project/authoring/sources.mjs';
import { retainAcquisitions } from '../src/project/storage/acquisitions.mjs';
import { prepareProjectInquiry } from '../src/project/inquiries/inquiry.mjs';
import { authorCase } from '../src/project/inquiries/investigation.mjs';
import { matchQuestionRoles } from '../src/project/inquiries/role-matching.mjs';
import {
  listEngineRuns,
  readEngineArtifact,
  acquireEngineRunLease,
} from '../src/project/storage/engine-runs.mjs';
import { compactProjectStorage } from '../src/project/inquiries/project-storage.mjs';
import { terminalCapture, captureGallery } from './support/terminal-capture.mjs';
import { tendora, tendoraQuestions, tendoraCases } from './tendora-service.mjs';
const args = process.argv.slice(2),
  live = args.includes('--live');
if (live) args.splice(args.indexOf('--live'), 1);
const projectAt = args.indexOf('--project');
let projectPath;
if (projectAt >= 0) {
  projectPath = args[projectAt + 1];
  if (!projectPath || projectPath.startsWith('--')) throw new Error('--project requires a path');
  args.splice(projectAt, 2);
}
if (args.length > 1)
  throw new Error(
    'Usage: node tools/capture-tendora-service.mjs [output-directory] [--live] [--project new-project-directory]',
  );
await mkdir('tmp', { recursive: true });
const output = args[0] ? resolve(args[0]) : await mkdtemp(resolve('tmp/tendora-service-'));
await mkdir(output, { recursive: true });
const path = projectPath ? resolve(projectPath) : join(output, 'tendora');
const project = await createProject(path, tendora.name, tendora.role);
const fixture = JSON.parse(
  await readFile(new URL('../test/support/tendora-service-acquisitions.json', import.meta.url)),
);
const embeddings = JSON.parse(
  await readFile(new URL('../test/support/tendora-service-embeddings.json', import.meta.url)),
);
if (!live)
  await retainAcquisitions(
    project,
    fixture.entries.map((e) => ({
      text: e.text,
      penman: e.acquisition.penman,
      acquisition: e.acquisition,
      origin: { kind: 'parser', profile: 'amr-text-acquisition-v1' },
    })),
  );
async function retainMatches() {
  if (live) return;
  const p = await openProject(path),
    root = p.data.placements[0].id;
  const embed = async (texts) => ({
    ...embeddings,
    vectors: texts.map((text) => {
      const at = embeddings.texts.indexOf(text);
      assert(at >= 0, `Retained embedding: ${text}`);
      return embeddings.vectors[at];
    }),
  });
  for (const question of tendoraQuestions)
    await matchQuestionRoles(p, prepareProjectInquiry(p, root, question).asset, { embed });
  for (const text of tendoraCases)
    await matchQuestionRoles(
      p,
      prepareProjectInquiry(p, root, 'Who offers human assistance?', {
        caseSelection: authorCase(p, text),
      }).asset,
      { embed },
    );
}
const reject = ['Earlier assessment', 'Check pending', '[History]', '[Material]'];
const sessions = [];
let finalCase, finalResult;
sessions.push(
  await terminalCapture(
    { project: path, output, name: 'author-and-follow', live },
    async ({ step, screen, clickText }) => {
      const role = async (label) => {
        const rows = screen().split('\n');
        const y = rows.findIndex(
          (line) => line.split('│')[1]?.replace(/[●▾▸]/gu, '').trim() === label,
        );
        if (y >= 0) return step({ mouse: [{ x: 8, y: y + 1 }], expect: [label] });
        const at = projectTree((await openProject(path)).data).findIndex(
          (n) => n.concept.name === label,
        );
        assert(at >= 0, label);
        const title = rows.findIndex((line) => line.split('│')[1]?.trim() === 'Roles');
        await step({
          mouse: [{ x: 5, y: title + 1 }],
          keys: ['HOME', ...Array(at).fill('DOWN')],
          expect: [label],
        });
      };
      const author = async (node, parent) => {
        if (parent) {
          await role(parent);
          await step({ keys: ['c'], text: node.role, expect: ['Role name:', node.role] });
          await step({ keys: ['ENTER'], expect: [node.role] });
        }
        await step({
          keys: ['n'],
          paste: node.statements.join('\n'),
          expect: ['Add statements'],
          waitFor: node.statements[0].slice(0, 55),
        });
        await step({
          keys: ['CTRL_S'],
          timeout: live ? 150 : 30,
          waitFor: 'Source statements',
          expect: ['Source statements', node.statements[0].slice(0, 55)],
          reject,
        });
        for (const child of node.children ?? []) await author(child, node.role);
      };
      await author(tendora);
      await role('Tendora');
      await retainMatches();
      const ask = async (text, answer, caseText) => {
        await role('Tendora');
        await step({ keys: ['a', 'ALT_U'], paste: text, waitFor: text, expect: ['Ask', text] });
        if (caseText) {
          await step({ keys: ['ALT_C', 'DOWN', 'ENTER'], expect: ['Write a case'] });
          await step({ paste: caseText, waitFor: caseText, expect: [caseText] });
          await step({ keys: ['CTRL_S'], expect: ['Ask', caseText] });
        }
        return step({
          keys: ['ENTER'],
          timeout: live ? 150 : 60,
          waitFor: `Answer: ${answer}`,
          expect: ['Question: ' + text, `Answer: ${answer}`],
          reject,
        });
      };
      await ask(tendoraQuestions[0], 'billing team');
      await role('Payments');
      await step({ expect: ['The billing team processes payments.', 'Used in the answer proof.'] });
      await ask(tendoraQuestions[2], 'account team');
      await role('Login failures');
      await step({ expect: ['The account team handles login failures.'] });
      await ask(tendoraQuestions[4], 'Still open');
      await ask(tendoraQuestions[5], 'Still open');
      await ask(tendoraQuestions[5], 'billing team', tendoraCases[0]);
      await role('Payout failures');
      await step({ expect: ['Used in the answer proof.'], reject });
      await role('Human assistance');
      await step({
        expect: ['If a ticket concerns an urgent failure', 'Used in the answer proof.'],
      });
      await ask(tendoraQuestions[5], 'account team', tendoraCases[1]);
      await role('Login failures');
      await step({
        expect: ['These sources complete the answer', 'Needed on arrival', 'entity offering'],
      });
      await clickText('If a ticket concerns a login failure', {
        expect: ['Check the language reading', 'log-on-02', 'e revise wording'],
      });
      await step({
        keys: ['e'],
        expect: ['Edit statements', 'If a ticket concerns a login failure'],
      });
      await step({ keys: ['ESC'], expect: ['Check the language reading'] });
      await step({
        resize: { width: 80, height: 24 },
        keys: ['HOME'],
        expect: ['Meaning to review', 'Reading: log-on-02', 'e revise wording'],
      });
      await step({
        keys: ['ESC'],
        resize: { width: 180, height: 54 },
        expect: ['Answer: account team'],
      });
      await role('Login failures');
      // One statements editor, with metadata kept out of it.
      await step({
        keys: ['ENTER'],
        expect: ['Edit role', 'Role name:', 'Description:'],
        reject: ['Sentence 1:'],
      });
      await step({
        keys: ['ESC', 'e'],
        expect: ['Edit statements', 'The account team handles login failures.'],
      });
      await step({
        keys: ['ALT_U'],
        text: 'The account team handles login failures.',
        expect: ['Edit statements'],
      });
      await step({
        keys: ['ESC'],
        expect: ['Question: Who offers human assistance?', 'Answer: account team'],
      });
      await step({ resize: { width: 100, height: 32 }, expect: ['Development', 'Question:'] });
    },
  ),
);
sessions.push(
  await terminalCapture(
    { project: path, output, name: 'cold-reopen', width: 120, height: 38 },
    async ({ step, screen }) => {
      // An evicted assessment is rebuilt from retained language when selected.
      await step({ keys: ['o', 'HOME'], waitFor: 'Answer:', expect: ['Development'] });
      let found = false;
      for (let i = 0; i < 15; i++) {
        if (
          screen().includes('Answer: account team') &&
          screen().includes('Question: Who offers human assistance?') &&
          screen().includes(tendoraCases[1])
        ) {
          found = true;
          break;
        }
        await step({ keys: ['DOWN'], waitFor: 'Answer:' });
      }
      assert(found, 'The independent case reopens with its attributed answer');
      await step({
        keys: ['ENTER'],
        expect: ['Answer: account team', 'Question: Who offers human assistance?'],
        reject,
      });
      await step({
        keys: ['END'],
        expect: ['If a ticket concerns a login failure', 'This case', tendoraCases[1]],
      });
      await step({
        keys: ['HOME'],
        resize: { width: 80, height: 24 },
        expect: ['Answer: account team', 'Who offers human assistance?'],
      });
      // Retain this visible check's proof before normal cache maintenance can evict diagnostics.
      const current = await openProject(path);
      const release = await acquireEngineRunLease(current, randomUUID());
      try {
        await step({ keys: ['r'], waitFor: 'Answer: account team', timeout: 120 });
        finalCase = (await listEngineRuns(current)).find(
          (run) => run.case === tendoraCases[1] && run.status === 'supported',
        );
        finalResult = await readEngineArtifact(current, finalCase.resultRef);
      } finally {
        await release();
      }
    },
  ),
);
await captureGallery(output, sessions);
const saved = await openProject(path),
  expected = [];
const pending = [tendora];
while (pending.length) {
  const node = pending.pop();
  expected.push(...node.statements);
  pending.push(...(node.children ?? []));
}
assert.deepEqual(
  sourceCatalog(saved.data)
    .map((s) => s.text)
    .sort(),
  expected.sort(),
  'All source statements survive paste, cancellation and reload verbatim',
);
assert.equal(finalCase.answer.answers[0].sourceIds.length, 3);
assert.equal(finalCase.answer.answers[0].ruleIds.length, 2);
assert(finalCase.answer.answers[0].derivation.tree);
await writeFile(
  join(output, 'verification.json'),
  JSON.stringify(
    {
      roles: 12,
      statements: 17,
      acquisition: live ? 'Fresh local AMR and embeddings' : 'Unmodified AMR and embedding replay',
      caseProof: finalCase.answer.answers[0],
      exploration: finalResult.exploration.checks.map((c) => ({
        nodeId: c.nodeId,
        visitedRoles: c.visitedRoles,
        sources: c.sourceIds.length,
        answers: c.answers.map((a) => a.text),
      })),
      sessions: sessions.map(({ name, path, frames }) => ({
        name,
        path,
        frames: frames.length,
        errors: frames.filter((f) => f.error).length,
      })),
    },
    null,
    2,
  ) + '\n',
);
await compactProjectStorage(saved, { force: true });
console.log(
  `Verified Tendora editor: ${join(output, 'captures.html')}\nOpen: npm run workbench -- --project ${path}`,
);
