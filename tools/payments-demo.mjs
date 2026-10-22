/** Create the ignored working copy of the payments demo; --reset starts it over from the snapshot. */
import { cp, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '.proj/payments-on-call');
const { values } = parseArgs({
  options: {
    reset: { type: 'boolean', default: false },
    target: { type: 'string', default: join(root, '.proj/payments-demo') },
  },
});
const target = resolve(values.target),
  shown = relative(process.cwd(), target) || '.';
const within = (parent, child) => !relative(parent, child).startsWith('..');
if (within(target, source) || within(source, target))
  throw new Error('The working copy cannot replace the bundled snapshot.');
const exists = await stat(target).then(
  () => true,
  (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  },
);
if (exists && !values.reset) {
  console.log(
    `${shown} already exists and was left unchanged. Run \`npm run demo -- --reset\` to discard it and start again.`,
  );
} else {
  // Copy beside the target first, so an interrupted reset never leaves half a project.
  const staged = join(dirname(target), `.${randomUUID()}.demo`);
  try {
    await cp(source, staged, { recursive: true, errorOnExist: true, force: false });
    if (exists) await rm(target, { recursive: true });
    await rename(staged, target);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  console.log(`${exists ? 'Reset' : 'Created'} ${shown} from the bundled payments snapshot.`);
}
