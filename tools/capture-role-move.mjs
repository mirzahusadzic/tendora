/** Keyboard-only role reparenting, including cancellation and persisted undo. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  addConcept,
  createProject,
  editConcept,
  openProject,
  saveProject,
} from '../src/project/authoring/project.mjs';
import { terminalCapture, captureGallery } from './support/terminal-capture.mjs';
import { terminalScreenshot } from './support/terminal-screenshots.mjs';

await mkdir('tmp', { recursive: true });
const output = await mkdtemp(resolve('tmp/role-move-'));
const sessions = [],
  captures = [],
  checks = [];
for (const [width, height] of [
  [180, 54],
  [80, 24],
]) {
  const path = join(output, `project-${width}`);
  let project = await createProject(path, 'Theatre operations', 'Production');
  const root = project.data.placements[0].id;
  const workshop = addConcept(project.data, root, 'Workshop');
  const bench = addConcept(workshop.data, workshop.placementId, 'Repair bench');
  const technical = addConcept(bench.data, root, 'Technical production');
  const benchConcept = technical.data.placements.find((p) => p.id === bench.placementId).conceptId;
  project = await saveProject(
    project,
    editConcept(technical.data, benchConcept, 'Repair bench', [
      'The workshop repairs stage furniture.',
    ]),
  );
  const original = structuredClone(project.data);
  const verify = async (parent, label) => {
    const current = (await openProject(path)).data;
    assert.equal(current.placements.find((p) => p.id === workshop.placementId).parentId, parent);
    assert.equal(
      current.placements.find((p) => p.id === bench.placementId).parentId,
      workshop.placementId,
    );
    assert.deepEqual(
      current.concepts,
      original.concepts,
      'Move preserves source material and role identity',
    );
    assert.deepEqual(
      current.placements.map((p) => p.id).sort(),
      original.placements.map((p) => p.id).sort(),
    );
    checks.push({
      width,
      label,
      workshopParent: parent,
      subtreePreserved: true,
      sourceMaterialUnchanged: true,
    });
  };
  const selected = [];
  const session = await terminalCapture(
    { project: path, output, name: `role-move-${width}`, width, height, color: true },
    async ({ step, frames }) => {
      const save = (name, purpose) =>
        selected.push({ name: `${width}-${name}`, purpose, index: frames.length - 1 });
      await step({ keys: ['HOME', 'DOWN'], expect: ['Workshop'] });
      const selector = await step({
        keys: ['m'],
        expect: ['Move Workshop - choose parent', 'Project root', 'Technical production'],
      });
      const destinations = selector.screen
        .split('\n')
        .map((line) => line.split('│').slice(2).join('│'))
        .join('\n');
      assert(!destinations.includes('Repair bench'), 'A descendant cannot be selected as parent');
      save(
        'move-selector',
        'Choose a new parent; the selected role and descendants are excluded from destinations.',
      );
      await step({ keys: ['ESC'], expect: ['Roles', 'Workshop'], reject: ['choose parent'] });
      await verify(root, 'cancel');
      save('move-cancelled', 'Escape restores the unchanged hierarchy and selected role.');
      await step({
        keys: ['m', 'END', 'ENTER'],
        expect: ['Roles', 'Workshop'],
        reject: ['choose parent'],
      });
      await verify(technical.placementId, 'moved');
      save('move-saved', 'The complete Workshop subtree is persisted below Technical production.');
      await step({ keys: ['CTRL_Z'], expect: ['Roles', 'Workshop'] });
      await verify(root, 'undo');
      save('move-undone', 'Undo restores the original parent without changing sources.');
      await step({ keys: ['CTRL_Y'], expect: ['Roles', 'Workshop'] });
      await verify(technical.placementId, 'redo');
      await step({ keys: ['CTRL_Z'], expect: ['Roles', 'Workshop'] });
      await verify(root, 'undo-again');
    },
  );
  sessions.push(session);
  for (const { name, purpose, index } of selected) {
    const frame = session.frames[index];
    const files = await terminalScreenshot(frame, { output: join(output, 'screenshots'), name });
    captures.push({
      name,
      purpose,
      ...files,
      capture: session.path,
      frame: index + 1,
      command: frame.command,
      scope:
        'Actual keyboard-only role authoring; generated fixture with exact persisted parent, subtree and source invariants. No model requests or answer claims.',
    });
  }
}
await captureGallery(output, sessions);
await writeFile(
  join(output, 'screenshots', 'manifest.json'),
  JSON.stringify({ captures, checks }, null, 2) + '\n',
);
console.log(join(output, 'screenshots', 'manifest.json'));
