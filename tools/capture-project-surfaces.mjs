/** Review every actual project's surfaces on isolated copies, entirely by keyboard. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openProject, projectTree } from '../src/project/authoring/project.mjs';
import { sourceCatalog } from '../src/project/authoring/sources.mjs';
import { listInvestigations } from '../src/project/inquiries/investigation.mjs';
import {
  acquireEngineRunLease,
  listEngineRuns,
  saveEngineRun,
} from '../src/project/storage/engine-runs.mjs';
import { terminalCapture, captureGallery } from './support/terminal-capture.mjs';
import { terminalScreenshot } from './support/terminal-screenshots.mjs';

const args = process.argv.slice(2),
  screenshots = !args.includes('--no-png'),
  homeOnly = args.includes('--only-home');
if (!screenshots) args.splice(args.indexOf('--no-png'), 1);
if (homeOnly) args.splice(args.indexOf('--only-home'), 1);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const projectsRoot = resolve(option('--projects', '.proj')),
  onlyProject = option('--only-project', null);
if (args.length > 1)
  throw new Error(
    'Usage: node tools/capture-project-surfaces.mjs [output] [--projects directory] [--only-project name] [--no-png] [--only-home]',
  );
await mkdir('tmp', { recursive: true });
const output = args[0] ? resolve(args[0]) : await mkdtemp(resolve('tmp/project-surfaces-'));
assert(
  relative(resolve('tmp'), output) && !relative(resolve('tmp'), output).startsWith('..'),
  'Captures and project copies must be beneath repository tmp/',
);
await mkdir(output, { recursive: true });
const projectNames = (await readdir(projectsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .filter((entry) => !onlyProject || entry.name === onlyProject)
  .map((entry) => entry.name)
  .sort();
const names = [];
for (const name of projectNames)
  try {
    await readFile(join(projectsRoot, name, 'project.json'));
    names.push(name);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
assert(
  names.length,
  onlyProject
    ? `Actual project not found: ${onlyProject}`
    : 'At least one actual project is required',
);
async function manifest(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(path, entry.name),
        name = relative(directory, full);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isSymbolicLink()) files.push({ path: name, link: await readlink(full) });
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        files.push({
          path: name,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
  await visit(directory);
  return files;
}
const originalBefore = {};
for (const name of names) originalBefore[name] = await manifest(join(projectsRoot, name));
await writeFile(
  join(output, 'originals-before.json'),
  JSON.stringify(originalBefore, null, 2) + '\n',
);

const networkLog = join(output, 'network-attempts.jsonl'),
  preload = fileURLToPath(new URL('./support/offline-terminal.mjs', import.meta.url)),
  oldNodeOptions = process.env.NODE_OPTIONS,
  oldNetworkLog = process.env.TENDORA_CAPTURE_NETWORK_LOG;
process.env.NODE_OPTIONS = [oldNodeOptions, `--import=${pathToFileURL(preload).href}`]
  .filter(Boolean)
  .join(' ');
process.env.TENDORA_CAPTURE_NETWORK_LOG = networkLog;
const sessions = [],
  inventory = [],
  failures = [],
  surfaces = [];

try {
  for (const name of names) {
    const copied = join(output, 'projects', name);
    await cp(join(projectsRoot, name), copied, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const project = await openProject(copied),
      roles = projectTree(project.data),
      sources = sourceCatalog(project.data).filter(
        (source) => source.development?.asserted !== false,
      ),
      runs = await listEngineRuns(project),
      investigations = await listInvestigations(project);
    const questions = new Set(
      [
        ...runs
          .filter((run) => !run.purpose || ['inquiry', 'question-refresh'].includes(run.purpose))
          .map((run) => run.questions?.[0]?.text),
        ...investigations.flatMap((entry) => entry.data.asks.map((ask) => ask.question)),
      ].filter(Boolean),
    );
    inventory.push({
      name,
      original: join(projectsRoot, name),
      copy: copied,
      roles: roles.length,
      sources: sources.length,
      questions: questions.size,
    });
    // This only rebases the copied cache. Its inputs, conclusions and source text
    // remain retained evidence; the TUI must never follow a path into the original.
    for (const run of runs)
      if (run.recording?.path) {
        run.recording.path = join(copied, 'recordings', basename(run.recording.path));
        await saveEngineRun(project, run);
      }
    const release = await acquireEngineRunLease(project, randomUUID());
    try {
      for (const [width, height] of [
        [180, 54],
        [120, 38],
        [80, 24],
      ]) {
        const sessionName = `${name}-${width}`,
          marks = [];
        try {
          const session = await terminalCapture(
            { project: copied, output, name: sessionName, width, height, color: true },
            async ({ step: rawStep, screen, frames }) => {
              const step = (command) =>
                rawStep({
                  ...command,
                  reject: ['Not applied', 'Cannot read properties', ...(command.reject ?? [])],
                });
              const mark = (state, purpose, result = 'observed') => {
                marks.push({ state, purpose, result, frame: frames.length - 1, review: null });
              };
              await step({ expect: ['Roles', 'Development'] });
              if (!homeOnly)
                mark('roles', 'Show the saved hierarchy and available authoring actions.');
              await step({ keys: ['w'], expect: ['New project', 'Open project'] });
              mark('home', 'Switch projects with an explicit keyboard return.');
              await step({ keys: ['ESC'], expect: ['Roles', 'Development'] });
              if (homeOnly) return;
              const firstReadable = sources[0],
                sourceRole =
                  firstReadable &&
                  roles.findIndex((item) => item.placement.id === firstReadable.nodeId);
              if (firstReadable && sourceRole >= 0) {
                await step({
                  keys: ['HOME', ...Array(sourceRole).fill('DOWN'), 'TAB', 'HOME'],
                  expect: ['Source statements'],
                });
                // Source statements precede child roles in an ordinary role view.
                // Reach the first retained source reading without mouse or a picker.
                const local = sources.filter((source) => source.nodeId === firstReadable.nodeId),
                  index = local.findIndex((source) => source.id === firstReadable.id);
                if (index) await step({ keys: Array(index).fill('DOWN') });
                mark('source-selection', 'Select an attributed source directly in its role.');
                await step({ keys: ['i'], expect: ['Language reading', 'e revise wording'] });
                mark(
                  'source-reading',
                  'Inspect the selected source meaning and reach its exact wording.',
                );
                await step({ keys: ['e'], expect: ['Edit statements'] });
                mark(
                  'source-edit',
                  'Revise the exact selected source, with cancellation preserving it.',
                );
                await step({ keys: ['ESC'], expect: ['Language reading'] });
                await step({ keys: ['ESC'], expect: ['Source statements'] });
              } else {
                await step({ keys: ['TAB'], expect: ['Source statements'] });
                mark(
                  'sources-unavailable',
                  'Expose an empty role or missing saved reading.',
                  firstReadable ? 'selection unavailable' : 'no retained source reading',
                );
              }
              await step({ keys: ['o'], expect: ['Development'] });
              mark(
                'development',
                'Find retained questions without changing their wording or scope.',
              );
              if (questions.size) {
                await step({
                  keys: ['HOME', 'ENTER'],
                  timeout: 120,
                  waitForAny: [
                    'Answer:',
                    'Could not check:',
                    'Ask',
                    'Saved; not checked yet.',
                    'role where this question started was removed',
                  ],
                });
                if (screen().includes('Answer:')) {
                  mark(
                    'saved-question',
                    'Reopen a saved question and expose its current supported answer or gap.',
                  );
                  await step({ keys: ['HOME', 'i'], expect: ['Language reading'] });
                  mark(
                    'question-reading',
                    'Inspect the selected question reading without choosing from unrelated texts.',
                  );
                  await step({ keys: ['ESC'], expect: ['Develop question'] });
                } else if (screen().includes('Could not check:')) {
                  mark(
                    'question-error',
                    'Report a saved question that cannot be checked from retained evidence.',
                    'check failed',
                  );
                } else {
                  mark(
                    'question-draft-or-removed-scope',
                    'Keep incomplete work reachable without claiming an answer.',
                  );
                  if (screen().includes('Ask'))
                    await step({ keys: ['ESC'], expect: ['Development'] });
                }
              }
              await step({ keys: ['TAB'], expect: ['Roles'] });
              mark('return', 'Return to hierarchy navigation with saved work retained.');
            },
          );
          sessions.push(session);
          for (const mark of marks) {
            const frame = session.frames[mark.frame],
              id = `${sessionName}-${mark.state}`;
            const paths = screenshots
              ? await terminalScreenshot(frame, { output: join(output, 'screenshots'), name: id })
              : {};
            surfaces.push({
              id,
              project: name,
              width,
              height,
              capture: session.path,
              ...mark,
              ...paths,
            });
          }
          console.log(
            `Captured ${sessionName}: ${session.frames.length} frames, ${marks.length} review surfaces`,
          );
        } catch (error) {
          failures.push({
            project: name,
            width,
            message: error.message,
            capture: join(output, `${sessionName}.capture.jsonl`),
          });
          console.error(`Failed ${sessionName}: ${error.message.split('\n')[0]}`);
        }
      }
    } finally {
      await release();
    }
  }
} finally {
  if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = oldNodeOptions;
  if (oldNetworkLog === undefined) delete process.env.TENDORA_CAPTURE_NETWORK_LOG;
  else process.env.TENDORA_CAPTURE_NETWORK_LOG = oldNetworkLog;
  const originalAfter = {};
  for (const name of names) originalAfter[name] = await manifest(join(projectsRoot, name));
  await writeFile(
    join(output, 'originals-after.json'),
    JSON.stringify(originalAfter, null, 2) + '\n',
  );
  const originalsUnchanged = JSON.stringify(originalBefore) === JSON.stringify(originalAfter);
  let networkAttempts = [];
  try {
    networkAttempts = (await readFile(networkLog, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await captureGallery(output, sessions);
  await writeFile(join(output, 'review-surfaces.json'), JSON.stringify(surfaces, null, 2) + '\n');
  await writeFile(
    join(output, 'verification.json'),
    JSON.stringify(
      {
        coverage: homeOnly
          ? 'All discovered actual projects: Home entry and keyboard return at each size.'
          : onlyProject
            ? 'Selected actual project; representative first source and first saved question at each size. Other projects retain their separately declared evidence.'
            : 'All discovered actual projects; representative first source and first saved question at each size. State/action exhaustive tests are a separate artifact.',
        keyboardOnly: true,
        projectsRoot,
        onlyProject,
        inventory,
        originalsUnchanged,
        networkRequests: 0,
        preventedAcquisitionAttempts: networkAttempts,
        sessions: sessions.map(({ name, path, frames }) => ({ name, path, frames: frames.length })),
        surfaces: surfaces.length,
        failures,
      },
      null,
      2,
    ) + '\n',
  );
  if (!originalsUnchanged || failures.length || networkAttempts.length) process.exitCode = 1;
  console.log(`Project surface evidence: ${output}`);
}
