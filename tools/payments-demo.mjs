/** Create the ignored working copy of the payments demo; --reset starts it over from the snapshot. */
import { cp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { refuseTarget } from './demo-target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'demo/payments-on-call');
const usage = `Usage: npm run demo -- [--reset] [--target <directory>]

Copy the bundled demo (demo/payments-on-call) to .proj/payments-demo.

Options:
  --reset               Renew an existing copy; it replaces only a copy of the demo.
  --target <directory>  Copy somewhere else.
  -h, --help            Show this help.`;
let values;
try {
  ({ values } = parseArgs({
    options: {
      reset: { type: 'boolean', default: false },
      target: { type: 'string', default: join(root, '.proj/payments-demo') },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (error) {
  console.error(
    `Error: ${error.message.replace(/\. To specify a positional.*$/su, '.')}\n\n${usage}`,
  );
  process.exit(2);
}
if (values.help) {
  console.log(usage);
  process.exit(0);
}
const target = resolve(values.target),
  shown = relative(process.cwd(), target) || '.';
const exists = await stat(target).then(
  () => true,
  (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  },
);
const bundledManifest = await readFile(join(source, 'project.json'), 'utf8');
const refused = refuseTarget({
  target,
  root,
  source,
  demoId: JSON.parse(bundledManifest).id,
  // What is there matters only when a reset would delete it.
  exists: exists && values.reset,
  manifest: exists ? await readFile(join(target, 'project.json'), 'utf8').catch(() => null) : null,
  entries: exists ? await readdir(target) : [],
});
if (refused) throw new Error(`${shown}: ${refused}`);
const same = async () => {
  const [copy, bundled] = await Promise.all(
    [target, source].map((at) => readFile(join(at, 'project.json'), 'utf8').catch(() => null)),
  );
  return copy !== null && copy === bundled;
};
if (exists && !values.reset) {
  console.log(
    (await same())
      ? `${shown} already exists, the same as the bundled demo.`
      : `${shown} differs from the bundled demo (edited, or made from an older one) and was left unchanged. The tour expects the bundled demo: run \`npm run demo -- --reset\` to replace it (its changes are discarded).`,
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
