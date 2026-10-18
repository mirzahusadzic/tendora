/** Select distinct observed keyboard states for independent visual review. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { terminalScreenshot } from './terminal-screenshots.mjs';

export async function keyboardScreenshots(output, sessions) {
  const has = (needle) => (frame) =>
    (frame.command?.expect ?? []).includes(needle) || frame.command?.waitFor === needle;
  const choices = [
    ['keyboard-authoring', 'roles-empty', has('Roles')],
    ['keyboard-authoring', 'role-add', has('Role name:')],
    ['keyboard-authoring', 'role-edit', has('Edit role')],
    [
      'keyboard-authoring',
      'role-remove',
      (frame) => frame.command?.keys?.[0] === 'x' && has('Yes')(frame),
    ],
    ['keyboard-authoring', 'statements-add', has('Add statements')],
    ['keyboard-authoring', 'statements-saved', has('Source statements')],
    [
      'keyboard-authoring',
      'source-reading',
      (frame) => has('Language reading')(frame) && has('Sam repairs bicycles.')(frame),
    ],
    ['keyboard-authoring', 'source-revise', has('Edit statements')],
    ['keyboard-authoring', 'question-ask', has('Ask')],
    ['keyboard-authoring', 'answer-attributed', has('Answer: technician')],
    ['keyboard-authoring', 'source-role', has('Used in the answer proof')],
    ['keyboard-authoring', 'question-open', has('Answer: Still open.')],
    [
      'keyboard-authoring',
      'question-revise',
      (frame) => frame.command?.keys?.[0] === 'e' && has('Ask')(frame),
    ],
    ['keyboard-authoring', 'proposal', has('Keep open')],
    ['keyboard-authoring', 'proposal-selected', has('Confirm Sam')],
    ['keyboard-authoring', 'proposal-confirmed', has('Answer: Sam')],
    ['keyboard-authoring', 'transfer', has('Answer: Yes')],
    ['keyboard-authoring', 'withdraw-confirmation', has('Withdraw connection')],
    ['keyboard-authoring', 'withdraw-cancelled', has('Confirmed connections')],
    [
      'keyboard-authoring',
      'withdrawn',
      (frame) => frame.command?.keys?.[0] === 'u' && has('Answer: Still open.')(frame),
    ],
    ['keyboard-authoring', 'help', has('Help')],
    ['keyboard-authoring', 'projects', has('Projects')],
    ['keyboard-authoring', 'quit-confirmation', (frame) => frame.command?.keys?.[0] === 'q'],
    ['keyboard-cold-compact', 'cold-open', has('Answer: Still open.')],
    [
      'keyboard-cold-compact',
      'expanded',
      (frame) => frame.command?.keys?.[0] === 'f' && has('Answer: Yes')(frame),
    ],
    ['keyboard-cold-compact', 'compact-80', (frame) => frame.command?.resize?.width === 80],
    ['keyboard-cold-compact', 'compact-60', (frame) => frame.command?.resize?.width === 60],
    ['keyboard-gap-and-source', 'selected-gap', has('enter inspect gap')],
    ['keyboard-gap-and-source', 'gap-detail', has('Readings for this connection')],
    ['keyboard-gap-and-source', 'selected-role', has('enter follow selected role')],
    ['keyboard-gap-and-source', 'followed-role', has('At Technical production')],
    ['keyboard-gap-and-source', 'raw-reading', has('/ repair-01')],
    ['keyboard-gap-and-source', 'relationship-table', has('Relationship')],
    ['keyboard-retained-reading', 'retained-reading', has('Subject')],
    [
      'keyboard-retained-reading',
      'missing-reading',
      has('No retained reading for this exact text'),
    ],
  ];
  const manifest = [];
  for (const [sessionName, name, predicate] of choices) {
    const session = sessions.find((item) => item.name === sessionName);
    const index = session.frames.findIndex(predicate);
    assert(index >= 0, `Representative capture exists: ${name}`);
    const frame = session.frames[index];
    const files = await terminalScreenshot(frame, { output: join(output, 'screenshots'), name });
    manifest.push({
      name,
      purpose: name.replaceAll('-', ' '),
      capture: session.path,
      frame: index + 1,
      command: frame.command,
      ...files,
    });
  }
  await writeFile(
    join(output, 'screenshots', 'manifest.json'),
    JSON.stringify({ captures: manifest }, null, 2) + '\n',
  );
}
