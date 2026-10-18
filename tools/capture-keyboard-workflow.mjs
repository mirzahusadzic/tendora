/** The full authoring/review path using only keys in a real terminal. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createProject,
  openProject,
  projectTree,
  saveProject,
} from '../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../src/project/storage/acquisitions.mjs';
import { prepareProjectInquiry } from '../src/project/inquiries/inquiry.mjs';
import { matchQuestionRoles } from '../src/project/inquiries/role-matching.mjs';
import { theatre, theatreQuestions } from './harbour-theatre.mjs';
import { terminalCapture, captureGallery } from './support/terminal-capture.mjs';
import { keyboardScreenshots } from './support/keyboard-workflow-screenshots.mjs';

const args = process.argv.slice(2);
const screenshots = args.includes('--screenshots');
if (screenshots) args.splice(args.indexOf('--screenshots'), 1);
assert(
  args.length <= 1,
  'Usage: node tools/capture-keyboard-workflow.mjs [new-output-directory] [--screenshots]',
);
await mkdir('tmp', { recursive: true });
const output = args[0] ? resolve(args[0]) : await mkdtemp(resolve('tmp/keyboard-editor-'));
await mkdir(output, { recursive: true });
const path = join(output, 'theatre');
const project = await createProject(path, theatre.name, theatre.role);
const fixture = JSON.parse(
  await readFile(new URL('../test/support/theatre-acquisitions.json', import.meta.url)),
);
const embeddings = JSON.parse(
  await readFile(new URL('../test/support/theatre-embeddings.json', import.meta.url)),
);
await retainAcquisitions(
  project,
  fixture.entries.map(({ text, acquisition }) => ({
    text,
    penman: acquisition.penman,
    acquisition,
    origin: { kind: 'retained-test-reading' },
  })),
);
async function retainMatches() {
  const project = await openProject(path);
  const embed = async (texts) => ({
    ...embeddings,
    vectors: texts.map((text) => {
      const at = embeddings.texts.indexOf(text);
      assert(at >= 0, `Frozen embedding for ${text}`);
      return embeddings.vectors[at];
    }),
  });
  for (const role of project.data.placements)
    for (const question of theatreQuestions)
      await matchQuestionRoles(project, prepareProjectInquiry(project, role.id, question).asset, {
        embed,
      });
}
const reject = ['Earlier assessment', 'Check pending', 'Press a to begin', 'Read which text?'];
const sessions = [];
const flows = ({ step, screen }) => {
  const role = async (label) => {
    for (let i = 0; i < 4 && !screen().includes('c add child'); i++) await step({ keys: ['TAB'] });
    assert(screen().includes('c add child'), 'Roles footer is keyboard reachable');
    const at = projectTree((await openProject(path)).data).findIndex(
      (entry) => entry.concept.name === label,
    );
    assert(at >= 0, label);
    await step({ keys: ['HOME', ...Array(at).fill('DOWN')], expect: [label] });
  };
  const ask = async (text, answer) => {
    await step({ keys: ['a', 'ALT_U'], text, expect: ['Ask', text] });
    await step({
      keys: ['ENTER'],
      timeout: 120,
      waitFor: `Answer: ${answer}`,
      expect: [`Question: ${text}`],
      reject,
    });
  };
  const development = async (text, answer) => {
    await step({ keys: ['o', 'HOME'], expect: ['Development'] });
    for (let i = 0; i < 30; i++) {
      if (
        screen()
          .split('\n')
          .some((line) => line.split('│')[1]?.includes('● ' + text))
      ) {
        await step({
          keys: ['ENTER'],
          timeout: 120,
          waitFor: `Answer: ${answer}`,
          expect: [`Question: ${text}`],
          reject,
        });
        return;
      }
      await step({ keys: ['DOWN'] });
    }
    throw new Error(`Question missing from Development: ${text}`);
  };
  return { role, ask, development };
};
sessions.push(
  await terminalCapture(
    { project: path, output, color: true, name: 'keyboard-authoring', width: 180, height: 54 },
    async (capture) => {
      const { step } = capture,
        { role, ask } = flows(capture);
      await step({ expect: ['Roles', 'Development'], reject });
      await step({ keys: ['c'], text: 'Cancelled role', expect: ['Role name:'] });
      await step({ keys: ['ESC'], reject: ['Cancelled role'] });
      await step({ keys: ['c'], text: 'Temporary role', expect: ['Role name:'] });
      await step({ keys: ['ENTER'], expect: ['Temporary role'] });
      await step({ keys: ['ENTER', 'ALT_U'], text: 'Renamed role', expect: ['Edit role'] });
      await step({ keys: ['CTRL_S'], expect: ['Renamed role'] });
      await step({ keys: ['CTRL_Z'], expect: ['Temporary role'], reject: ['Renamed role'] });
      await step({ keys: ['CTRL_Y'], expect: ['Renamed role'] });
      await role('Renamed role');
      await step({ keys: ['x'], expect: ['Yes', 'No'] });
      await step({ keys: ['ENTER'], expect: ['Renamed role'] });
      await step({ keys: ['x', 'LEFT', 'ENTER'], reject: ['Renamed role'] });
      async function author(node, parent) {
        if (parent) {
          await role(parent);
          await step({ keys: ['c'], text: node.role, expect: ['Role name:'] });
          await step({ keys: ['ENTER'], expect: [node.role] });
        }
        await step({
          keys: ['n'],
          paste: node.statements.join('\n'),
          waitFor: node.statements[0].slice(0, 45),
          expect: ['Add statements'],
        });
        await step({
          keys: ['CTRL_S'],
          waitFor: 'Source statements',
          expect: [node.statements[0].slice(0, 30)],
          reject,
        });
        for (const child of node.children ?? []) await author(child, node.role);
      }
      await author(theatre);
      await retainMatches();
      await role('Workshop');
      await step({
        keys: ['TAB', 'HOME', 'ENTER'],
        expect: ['Language reading', 'Sam repairs bicycles.'],
        reject,
      });
      await step({ keys: ['e'], expect: ['Edit statements', 'Sam repairs bicycles.'] });
      await step({
        keys: ['ALT_U'],
        text: 'Unsaved changed source.',
        expect: ['Unsaved changed source.'],
      });
      await step({
        keys: ['ESC'],
        expect: ['Language reading', 'Sam repairs bicycles.'],
        reject: ['Unsaved changed source.'],
      });
      await step({ keys: ['ESC'], expect: ['Source statements'] });
      await role('Production');
      await ask(theatreQuestions[0], 'technician');
      await step({ keys: ['i'], expect: ['Language reading'], reject });
      await step({ keys: ['ESC'], expect: ['Answer: technician'] });
      await role('Rigging');
      await step({
        keys: ['TAB'],
        expect: ['The technician inspects the rig.', 'Used in the answer proof'],
      });
      await step({ keys: ['i'], expect: ['Language reading'], reject });
      await step({ keys: ['ESC'], expect: ['Answer: technician'] });
      await role('Production');
      await ask(theatreQuestions[3], 'Still open.');
      await step({ keys: ['i'], expect: ['Language reading', theatreQuestions[3]], reject });
      await step({ keys: ['e'], expect: ['Ask', theatreQuestions[3]] });
      await step({ keys: ['ESC'], expect: ['Language reading', theatreQuestions[3]] });
      await step({ keys: ['ESC'], expect: ['Why no answer', 'Answer: Still open.'] });
      await role('Workshop');
      await ask(theatreQuestions[4], 'Still open.');
      await step({ keys: ['d'], expect: ['Clarify connection', 'Keep open'] });
      await step({ keys: ['ESC'], expect: ['Answer: Still open.'] });
      await step({ keys: ['d', 'DOWN'], expect: ['Confirm Sam'] });
      await step({ keys: ['ENTER'], timeout: 120, waitFor: 'Answer: Sam', reject });
      await ask(theatreQuestions[5], 'Yes');
      await step({ keys: ['u', 'ENTER'], expect: ['Withdraw connection', 'Yes', 'No'] });
      await step({ keys: ['ENTER'], expect: ['Confirmed connections'] });
      await step({ keys: ['ESC'], expect: ['Answer: Yes'] });
      await step({
        keys: ['u', 'ENTER', 'LEFT', 'ENTER'],
        timeout: 120,
        waitFor: 'Answer: Still open.',
        reject,
      });
      await ask(theatreQuestions[6], 'Yes');
      await role('Workshop');
      await step({ keys: ['?'], expect: ['Help', 'move role'] });
      await step({ keys: ['ESC'], expect: ['Roles'] });
      await step({ keys: ['w'], expect: ['Projects'] });
      await step({ keys: ['ESC'], expect: ['Workshop', 'Development'] });
      await step({ keys: ['q'], expect: ['Yes', 'No'] });
      await step({ keys: ['ENTER'], expect: ['Workshop', 'Development'] });
    },
  ),
);
sessions.push(
  await terminalCapture(
    { project: path, output, color: true, name: 'keyboard-cold-compact', width: 120, height: 38 },
    async (capture) => {
      const { step } = capture,
        { development } = flows(capture);
      await development(theatreQuestions[5], 'Still open.');
      await step({ keys: ['i'], expect: ['Language reading', theatreQuestions[5]], reject });
      await step({ keys: ['ESC'], expect: ['Answer: Still open.'] });
      await development(theatreQuestions[6], 'Yes');
      await step({ keys: ['f'], expect: ['Develop question', 'Answer: Yes'] });
      await step({ keys: ['f'], expect: ['Roles', 'Development'] });
      for (const [width, height] of [
        [80, 24],
        [60, 20],
        [180, 54],
      ]) {
        await step({ resize: { width, height }, expect: ['Develop question'] });
        await step({ keys: ['TAB'], expect: ['Development'] });
        await step({ keys: ['TAB'], expect: ['Roles'] });
        await step({ keys: ['TAB'], expect: ['Develop question'] });
      }
    },
  ),
);
sessions.push(
  await terminalCapture(
    { project: path, output, color: true, name: 'keyboard-gap-and-source', width: 180, height: 54 },
    async (capture) => {
      const { step } = capture,
        { development, role } = flows(capture);
      await development(theatreQuestions[3], 'Still open.');
      await step({ keys: ['HOME', 'DOWN'], expect: ['enter inspect gap'] });
      await step({ keys: ['ENTER'], expect: ['Connection gap', 'Readings for this connection'] });
      await step({ keys: ['i'], expect: ['Language reading', theatreQuestions[3]] });
      await step({ keys: ['ESC'], expect: ['Connection gap'] });
      await step({ keys: ['ESC'], expect: ['Why no answer', 'Answer: Still open.'] });
      await development(theatreQuestions[0], 'technician');
      await role('Production');
      await step({ keys: ['TAB'], expect: ['Question: ' + theatreQuestions[0]] });
      await step({ keys: ['HOME', 'DOWN'], expect: ['enter follow selected role'] });
      await step({ keys: ['ENTER'], expect: ['At Technical production', 'Answer: technician'] });
      await step({
        keys: ['ESC'],
        expect: [
          'Question: ' + theatreQuestions[0],
          'Answer: technician',
          'enter follow selected role',
        ],
      });
      await role('Workshop');
      await step({ keys: ['ESC'], expect: ['Source statements'] });
      await step({
        keys: ['TAB', 'HOME', 'ENTER'],
        expect: ['Language reading', 'Sam repairs bicycles.'],
      });
      await step({ keys: ['g'], expect: ['/ repair-01', 'g relationship table'] });
      await step({
        keys: ['g'],
        expect: ['Subject', 'Relationship', 'Participant'],
        reject: ['/ repair-01'],
      });
      await step({ keys: ['ESC'], expect: ['Source statements', 'Sam repairs bicycles.'] });
    },
  ),
);
let legacy = await createProject(join(output, 'legacy'), 'Retained language', 'Workshop');
const legacyData = structuredClone(legacy.data);
legacyData.concepts[0].passages = ['Sam repairs bicycles.', 'An unacquired source sentence.'];
legacy = await saveProject(legacy, legacyData);
const retained = fixture.entries.find((entry) => entry.text === legacyData.concepts[0].passages[0]);
await retainAcquisitions(legacy, [
  {
    text: retained.text,
    penman: retained.acquisition.penman,
    acquisition: retained.acquisition,
    origin: { kind: 'retained-test-reading' },
  },
]);
sessions.push(
  await terminalCapture(
    {
      project: join(output, 'legacy'),
      output,
      name: 'keyboard-retained-reading',
      color: true,
      width: 120,
      height: 38,
    },
    async ({ step }) => {
      await step({
        keys: ['TAB', 'HOME', 'i'],
        expect: ['Language reading', 'Sam repairs bicycles.', 'Subject', 'Participant'],
        reject,
      });
      await step({ keys: ['g'], expect: ['/ repair-01'] });
      await step({
        keys: ['ESC', 'DOWN', 'i'],
        expect: ['An unacquired source sentence.', 'No retained reading for this exact text'],
        reject: ['g original reading', 'g relationship table'],
      });
      await step({ keys: ['e'], expect: ['Edit statements', 'An unacquired source sentence.'] });
      await step({
        keys: ['ESC'],
        expect: ['Language reading', 'No retained reading for this exact text'],
      });
      await step({ keys: ['ESC'], expect: ['Source statements'] });
    },
  ),
);
assert(
  sessions.every((session) => session.frames.every((frame) => !frame.command?.mouse)),
  'No mouse input in this audit',
);
await captureGallery(output, sessions);
if (screenshots) await keyboardScreenshots(output, sessions);
await writeFile(
  join(output, 'verification.json'),
  JSON.stringify(
    {
      modelRequests: 0,
      mouseActions: 0,
      sessions: sessions.map(({ name, path, frames }) => ({
        name,
        path,
        checkedFrames: frames.filter((f) => f.command?.expect || f.command?.waitFor).length,
        errors: frames.filter((f) => f.error),
      })),
    },
    null,
    2,
  ) + '\n',
);
console.log(`Keyboard workflow verified: ${join(output, 'captures.html')}`);
