/** Keyboard-only form authoring and concurrent-edit recovery in real terminals. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createProject,
  openProject,
  removeBranch,
  saveProject,
} from '../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../src/project/storage/acquisitions.mjs';
import { terminalCapture, captureGallery } from './support/terminal-capture.mjs';

const args = process.argv.slice(2);
assert(args.length <= 1, 'Usage: node tools/capture-forms-workflow.mjs [new-output-directory]');
await mkdir('tmp', { recursive: true });
const output = args[0] ? resolve(args[0]) : await mkdtemp(resolve('tmp/forms-editor-'));
await mkdir(output, { recursive: true });
const fixtures = JSON.parse(
  await readFile(new URL('../test/support/theatre-acquisitions.json', import.meta.url)),
);
const sessions = [];
for (const [width, height] of [
  [180, 54],
  [120, 42],
  [80, 24],
]) {
  const path = join(output, `project-${width}`);
  let project = await createProject(path, 'Form review', 'Workshop');
  const data = structuredClone(project.data);
  data.concepts[0].passages = ['Sam repairs bicycles.'];
  project = await saveProject(project, data);
  await retainAcquisitions(
    project,
    fixtures.entries.map(({ text, acquisition }) => ({
      text,
      acquisition,
      penman: acquisition.penman,
      origin: { kind: 'frozen-form-capture' },
    })),
  );
  const external = async (edit) => {
    const current = await openProject(path),
      next = structuredClone(current.data);
    edit(next);
    return saveProject(current, next);
  };
  sessions.push(
    await terminalCapture(
      { project: path, output, name: `forms-${width}`, width, height, color: true },
      async ({ step }) => {
        const mark = (action, command = {}) => step({ action, ...command });
        await mark('roles.start', { expect: ['Workshop', 'Source statements'] });
        await mark('sources.read-legacy', {
          keys: ['TAB', 'ENTER'],
          expect: ['Language reading', 'Sam repairs bicycles.'],
          reject: ['Cannot read properties', 'Not applied'],
        });
        await mark('sources.edit-legacy', {
          keys: ['e'],
          expect: ['Edit statements', 'Sam repairs bicycles.'],
          reject: ['Problem:', 'Not applied'],
        });
        await mark('sources.edit-legacy-back', { keys: ['ESC'], expect: ['Language reading'] });
        await mark('sources.read-legacy-back', {
          keys: ['ESC', 'SHIFT_TAB'],
          expect: ['Source statements'],
        });
        await mark('role.edit', { keys: ['ENTER'], expect: ['Edit role', 'Role name:'] });
        await mark('role.required', {
          keys: ['ALT_U', 'CTRL_S'],
          expect: ['Role name is required.'],
        });
        await mark('role.draft', { text: 'My workshop', expect: ['My workshop'] });
        const latest = await external((data) => {
          data.concepts[0].name = 'Saved workshop';
        });
        await mark('role.conflict', {
          keys: ['CTRL_S'],
          waitFor: 'changed outside',
          expect: ['reload project'],
        });
        assert.equal((await openProject(path)).digest, latest.digest);
        await mark('role.reload', {
          keys: ['ALT_R'],
          expect: ['Saved role name: Saved workshop', 'My workshop'],
        });
        assert.equal((await openProject(path)).digest, latest.digest);
        await mark('role.save', {
          keys: ['CTRL_S'],
          waitFor: 'Source statements',
          expect: ['My workshop'],
        });
        assert.equal((await openProject(path)).data.concepts[0].name, 'My workshop');

        await mark('role.child-draft', {
          keys: ['c'],
          text: 'Temporary role',
          expect: ['Add child', 'Temporary role'],
        });
        await mark('role.child-save', {
          keys: ['CTRL_S'],
          waitFor: 'Source statements',
          expect: ['Temporary role'],
        });
        await mark('role.removed-draft', {
          keys: ['ENTER', 'ALT_U'],
          text: 'My removed draft',
          expect: ['Edit role', 'My removed draft'],
        });
        const withoutRole = await external((data) => {
          const role = data.concepts.find((item) => item.name === 'Temporary role'),
            placement = data.placements.find((item) => item.conceptId === role.id);
          Object.assign(data, removeBranch(data, placement.id).data);
        });
        await mark('role.removed-conflict', { keys: ['CTRL_S'], waitFor: 'changed outside' });
        await mark('role.removed-reload', {
          keys: ['ALT_R'],
          expect: ['Unsaved role draft', 'This role was removed', 'My removed draft'],
          reject: ['Edit role', 'save role'],
        });
        assert.equal((await openProject(path)).digest, withoutRole.digest);
        await mark('role.removed-back', {
          keys: ['ESC'],
          expect: ['Source statements', 'My workshop'],
          reject: ['Temporary role', 'My removed draft'],
        });

        await mark('sources.edit', {
          keys: ['e', 'ALT_U'],
          text: 'The technician inspects the rig.',
          expect: ['Edit statements'],
        });
        await external((data) => {
          data.concepts[0].description = 'External description retained';
        });
        await mark('sources.conflict-unrelated', {
          keys: ['CTRL_S'],
          waitFor: 'changed outside',
          expect: ['reload project'],
        });
        await mark('sources.reload-unrelated', {
          keys: ['ALT_R'],
          expect: ['The technician inspects the rig.'],
        });
        await mark('sources.save', {
          keys: ['CTRL_S'],
          waitFor: 'Source statements',
          expect: ['The technician inspects', 'the rig.'],
        });
        assert.equal(
          (await openProject(path)).data.concepts[0].description,
          'External description retained',
        );
        await mark('sources.draft-conflict', {
          keys: ['e', 'ALT_U'],
          text: 'Sam repairs bicycles.',
          expect: ['Edit statements'],
        });
        const theirs = await external((data) => {
          data.concepts[0].passages = ['The director coordinates the rehearsal.'];
          delete data.concepts[0].sourceRecords;
        });
        await mark('sources.conflict', { keys: ['CTRL_S'], waitFor: 'changed outside' });
        await mark('sources.reload-conflict', {
          keys: ['ALT_R'],
          expect: [
            'Unsaved statement draft',
            'saved statements changed',
            'Sam repairs bicycles.',
            'The director',
            'edit current statements',
          ],
        });
        assert.equal((await openProject(path)).digest, theirs.digest);
        await mark('sources.current', {
          keys: ['ALT_E'],
          expect: ['Edit statements', 'The director coordinates the rehearsal.'],
        });
        await mark('sources.current-back', {
          keys: ['ESC'],
          expect: ['saved statements changed', 'Sam repairs bicycles.'],
        });
        await mark('sources.draft-back', {
          keys: ['ESC'],
          expect: ['Source statements', 'The director coordinates'],
        });

        await mark('ask.draft', {
          keys: ['a'],
          text: 'Who repairs bicycles?',
          expect: ['Ask', 'Who repairs bicycles?'],
        });
        await mark('ask.case', { keys: ['ALT_C'], expect: ['Case', 'Write a case'] });
        await mark('case.write', {
          keys: ['HOME', 'DOWN', 'ENTER'],
          expect: ['Write a case', 'Saved with: This question'],
        });
        await mark('case.draft', {
          paste: 'My bicycle is broken. The rear wheel is stuck.',
          expect: ['My bicycle is broken.'],
        });
        await mark('case.save', {
          keys: ['ENTER'],
          expect: ['Ask', 'Who repairs bicycles?', 'Text: My bicycle', 'Sentences: 2'],
          reject: ['Concept:'],
        });
        await mark('ask.scope', { keys: ['ALT_S'], expect: ['Scope', 'My workshop'] });
        await mark('ask.scope-back', { keys: ['ESC'], expect: ['Ask', 'Who repairs bicycles?'] });
        await mark('case.clear', { keys: ['ALT_C', 'HOME', 'ENTER'], expect: ['Case: None'] });
        await mark('ask.no-hidden-purpose', {
          keys: ['ALT_I'],
          expect: ['Ask', 'Who repairs bicycles?'],
          reject: ['Purpose'],
        });
        await mark('ask.save-draft', {
          keys: ['CTRL_S'],
          expect: ['Ask', 'Who repairs bicycles?'],
        });
        await mark('ask.back', { keys: ['ESC'], expect: ['Development', 'Who repairs bicycles?'] });

        await mark('projects.open', {
          keys: ['SHIFT_TAB', 'w'],
          expect: ['Projects', 'New project', 'Open project'],
        });
        await mark('project.new', {
          keys: ['HOME', 'ENTER'],
          expect: ['New project', 'Project name:', 'Directory:'],
        });
        await mark('project.required', { keys: ['CTRL_S'], expect: ['Project name is required.'] });
        await mark('project.name', { text: `Created ${width}`, expect: [`Created ${width}`] });
        const directoryFrame = await mark('project.directory', {
          keys: ['ENTER'],
          expect: ['Directory:', `Created ${width}`],
        });
        assert(
          directoryFrame.screen.replace(/[│\s]/gu, '').includes(`/.proj/created-${width}`),
          'The generated directory remains complete across visual wrapping',
        );
        await mark('project.cancel', { keys: ['ESC'], expect: ['Projects', 'Open project'] });
        await mark('projects.list', { keys: ['DOWN', 'ENTER'], expect: ['Another location'] });
        await mark('projects.location', {
          keys: ['END', 'ENTER'],
          expect: ['Project location', 'Directory:'],
        });
        await mark('projects.location-invalid', {
          keys: ['ALT_U'],
          paste: join(output, 'missing-location'),
          expect: ['Project location'],
        });
        await mark('projects.location-error', {
          keys: ['ENTER'],
          waitFor: 'Directory not found:',
          expect: ['Directory not found:'],
          reject: ['ENOENT', 'scandir'],
        });
        await mark('projects.location-back', { keys: ['ESC'], expect: ['Another location'] });
        await mark('projects.list-back', { keys: ['ESC'], expect: ['Projects', 'Open project'] });
        await mark('projects.return', { keys: ['ESC'], expect: ['My workshop', 'Development'] });
        await mark('help.open', { keys: ['?'], expect: ['Help', 'Shortcuts'] });
        await mark('help.back', { keys: ['ESC'], expect: ['My workshop', 'Development'] });
        await mark('quit.prompt', { keys: ['q'], expect: ['Yes', 'No'] });
        await mark('quit.cancel', { keys: ['ENTER'], expect: ['My workshop', 'Development'] });
      },
    ),
  );
}
await captureGallery(output, sessions);
await writeFile(
  join(output, 'verification.json'),
  JSON.stringify(
    {
      modelRequests: 0,
      sessions: sessions.map(({ name, path, frames }) => ({
        name,
        path,
        frames: frames.length,
        checks: frames
          .filter((f) => f.command?.action)
          .map((f, i) => ({
            frame: frames.indexOf(f) + 1,
            action: f.command.action,
            checked: !f.error,
          })),
      })),
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    output,
    sessions: sessions.length,
    frames: sessions.reduce((n, s) => n + s.frames.length, 0),
  }),
);
