/** Public packet only. All corpus authoring and questions use the existing editor PTY. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalCapture, captureGallery } from './support/terminal-capture.mjs';
import {
  artifactHash,
  displayedAnswers,
  displayedValues,
  freezeRun,
  json,
  parseOptions,
  selectedSidebarRow,
  validatePacket,
} from './support/blind-holdout.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sentences = (text) =>
  [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
// A short visible prefix tolerates wrapping; exact bytes remain in paste frames and source checks.
const visible = (text) => text.trim().split('\n')[0].slice(0, 40);

export async function captureBlindHoldout({
  packet: packetPath,
  output: requested,
  authorOnly = false,
}) {
  const bytes = await readFile(resolve(packetPath));
  const packet = validatePacket(JSON.parse(bytes));
  const output = resolve(requested);
  const tmp = resolve(root, 'tmp');
  assert.equal(dirname(output), tmp, 'Output must be a new direct child of repository tmp/');
  // Packet and destination validation precede all creation, including the tmp parent.
  await mkdir(tmp, { recursive: true });
  assert.equal(await realpath(tmp), tmp, 'tmp must not redirect outside this copy');
  await mkdir(output);
  await writeFile(join(output, 'public.json'), bytes, { flag: 'wx' });
  const integration = {
    version: 1,
    status: 'capturing',
    mode: authorOnly ? 'author-only' : 'questions',
    packet: await artifactHash(output, 'public.json'),
    project: 'project',
    startedAt: new Date().toISOString(),
    acquisition:
      'Existing editor AMR acquisition and embeddings; no imported readings or second model pass.',
    roles: [],
    statements: [],
    sources: [],
    questions: packet.questions.map((question) => ({ ...question, state: 'not-asked' })),
    captures: [],
  };
  const projectPath = join(output, 'project');
  const sessions = [];
  let release;
  try {
    const { createProject, openProject, projectTree } =
      await import('../src/project/authoring/project.mjs');
    const { sourceCatalog } = await import('../src/project/authoring/sources.mjs');
    const { acquireEngineRunLease, listEngineRuns, readEngineArtifact } =
      await import('../src/project/storage/engine-runs.mjs');
    // Bootstrap an empty project only. Even the root role is named by a pasted editor action.
    const project = await createProject(projectPath, packet.title, packet.title);
    const rootRole = packet.roles.find((role) => role.parent === null);
    const placements = new Map([[rootRole.id, project.data.placements[0].id]]);
    release = await acquireEngineRunLease(project, randomUUID());
    const session = await terminalCapture(
      { project: projectPath, output, name: 'editor', live: true, color: true },
      async ({ step, screen, frames }) => {
        const evidence = () => ({ capture: 'editor.capture.jsonl', frame: frames.length - 1 });
        const select = async (id) => {
          const tree = projectTree((await openProject(projectPath)).data);
          const at = tree.findIndex(({ placement }) => placement.id === placements.get(id));
          assert(at >= 0, 'Authored role missing');
          // Click a real role row to focus, then navigate the current tree. The final mouse
          // selection is located anew from rendered cells, including after viewport scrolling.
          await step({ mouse: [selectedSidebarRow(screen())] });
          await step({ keys: ['HOME', ...Array(at).fill('DOWN')] });
          await step({ mouse: [selectedSidebarRow(screen())] });
          return evidence();
        };
        const author = async (role) => {
          if (role.parent === null) {
            await select(role.id);
            await step({
              keys: ['ENTER', 'ALT_U'],
              paste: role.name,
              waitFor: visible(role.name),
              expect: ['Edit role'],
            });
          } else {
            await select(role.parent);
            await step({
              keys: ['c'],
              paste: role.name,
              waitFor: visible(role.name),
              expect: ['Add child', 'Role name:'],
            });
          }
          const draft = evidence();
          const before = new Set((await openProject(projectPath)).data.placements.map((p) => p.id));
          await step({ keys: ['CTRL_S'], waitFor: 'Source statements', timeout: 150 });
          const saved = await openProject(projectPath);
          const placement =
            role.parent === null
              ? saved.data.placements.find((p) => p.id === placements.get(role.id))
              : saved.data.placements.find((p) => !before.has(p.id));
          assert(placement, `Role authoring failed for ID ${role.id}`);
          assert.equal(
            placement.parentId,
            role.parent === null ? null : placements.get(role.parent),
            'Authored hierarchy differs',
          );
          assert.equal(
            saved.data.concepts.find((c) => c.id === placement.conceptId)?.name,
            role.name,
            'Authored role name differs from exact packet text',
          );
          placements.set(role.id, placement.id);
          integration.roles.push({
            id: role.id,
            placementId: placement.id,
            parent: role.parent,
            name: role.name,
            draft,
            saved: evidence(),
          });
          for (const statement of role.statements) {
            await select(role.id);
            const prior = new Set(
              (await openProject(projectPath)).data.contributions?.map((c) => c.id),
            );
            await step({
              keys: ['n'],
              paste: statement.text,
              waitFor: visible(statement.text),
              expect: ['Add statements'],
            });
            const pasted = evidence();
            await step({ keys: ['CTRL_S'], waitFor: 'Source statements', timeout: 150 });
            const current = await openProject(projectPath);
            const added = current.data.contributions?.filter((c) => !prior.has(c.id)) ?? [];
            assert.equal(added.length, 1, `Statement authoring failed for ID ${statement.id}`);
            assert.equal(added[0].scopePlacementId, placement.id, 'Statement saved at wrong role');
            assert.deepEqual(
              added[0].responses.map((r) => r.text),
              sentences(statement.text),
              'Editor sentence retention differs from pasted language',
            );
            // Source statements are a table; the new statement may be below the viewport.
            // Reopen its exact editor field to require a visible post-save witness.
            await step({
              keys: [
                'e',
                ...Array(
                  (current.data.contributions ?? []).filter(
                    (c) => c.scopePlacementId === placement.id,
                  ).length - 1,
                ).fill('TAB'),
              ],
              waitFor: visible(statement.text),
              expect: ['Edit statements'],
            });
            const retained = evidence();
            await step({ keys: ['ESC'], waitFor: 'Source statements' });
            integration.statements.push({
              id: statement.id,
              roleId: role.id,
              text: statement.text,
              contributionId: added[0].id,
              pasted,
              retained,
              responses: added[0].responses,
            });
          }
          for (const child of packet.roles.filter((candidate) => candidate.parent === role.id))
            await author(child);
        };
        await step({ waitFor: 'Source statements' });
        await author(rootRole);
        const authored = await openProject(projectPath);
        assert.equal(authored.data.placements.length, packet.roles.length, 'Role count differs');
        integration.sources = sourceCatalog(authored.data);
        integration.contributions = authored.data.contributions ?? [];
        if (authorOnly) return;
        for (const question of integration.questions) {
          await select(rootRole.id);
          await step({
            keys: ['a', 'ALT_U'],
            paste: question.text,
            waitFor: visible(question.text),
            expect: ['Ask'],
          });
          question.draft = evidence();
          // Explicitly clear the previous question's case, including when this question has none.
          await step({ keys: ['ALT_C', 'HOME', 'ENTER'], expect: ['Case: None'] });
          const caseText = packet.cases.find((entry) => entry.id === question.caseId)?.text;
          if (caseText !== undefined) {
            await step({ keys: ['ALT_C', 'HOME', 'DOWN', 'ENTER'], expect: ['Write a case'] });
            await step({
              keys: ['ALT_U'],
              paste: caseText,
              waitFor: visible(caseText),
              expect: ['Write a case'],
            });
            question.caseDraft = evidence();
            await step({ keys: ['CTRL_S'], waitFor: 'Ask', expect: [visible(caseText)] });
            question.caseSaved = evidence();
          }
          const previousRuns = new Set(
            (await listEngineRuns(await openProject(projectPath))).map((run) => run.id),
          );
          await step({
            keys: ['ENTER'],
            waitForAny: ['Answer:', 'Could not check:', 'no answer established'],
            timeout: 180,
          });
          const answers = displayedAnswers(screen());
          assert(
            answers.length && answers.every(Boolean),
            `No visible answer for question ID ${question.id}`,
          );
          const normalize = (text) => text.replace(/\s+/gu, ' ').trim();
          assert(
            displayedValues(screen(), 'Question').some(
              (text) => normalize(text) === normalize(question.text),
            ),
            `No complete visible question for ID ${question.id}`,
          );
          const current = await openProject(projectPath);
          const runs = await listEngineRuns(current);
          const run = runs.find(
            (candidate) =>
              candidate.questions?.[0]?.text === question.text.trim() &&
              candidate.scopePlacementId === placements.get(rootRole.id) &&
              candidate.projectDigest === current.digest &&
              JSON.stringify(candidate.caseSelection?.sources?.map((s) => s.text) ?? []) ===
                JSON.stringify(caseText === undefined ? [] : sentences(caseText)),
          );
          assert(
            run && run.status !== 'running',
            `No retained run matching visible question ID ${question.id}`,
          );
          const input = run.inputRef ? await readEngineArtifact(current, run.inputRef) : null;
          const result = run.resultRef ? await readEngineArtifact(current, run.resultRef) : null;
          assert(
            input && result,
            `Missing retained acquisition/reasoning artifacts for question ID ${question.id}`,
          );
          const retained = run.answer ?? result?.answer ?? null;
          Object.assign(question, {
            state: 'captured',
            display: { ...evidence(), screen: screen(), answers },
            reusedRun: previousRuns.has(run.id),
            run,
            input,
            result,
            answer: retained,
            partial: retained?.partial ?? null,
            openings: retained?.openings ?? run.openings ?? [],
          });
        }
      },
    );
    sessions.push(session);
    await captureGallery(output, sessions);
    integration.captures = await Promise.all(
      ['editor.capture.jsonl', 'captures.html'].map((path) => artifactHash(output, path)),
    );
    integration.status = 'complete';
    integration.finishedAt = new Date().toISOString();
    await freezeRun(output, integration);
    return {
      output,
      questions: integration.questions.filter((q) => q.state === 'captured').length,
    };
  } catch (error) {
    integration.status = 'failed';
    integration.failure = error.message;
    await writeFile(join(output, 'failure.json'), json(integration), { flag: 'wx' });
    throw new Error(
      `Blind capture failed; unfrozen evidence at ${relative(root, output)}: ${error.message}`,
      { cause: error },
    );
  } finally {
    if (release) await release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(
      process.argv.slice(2),
      ['--packet', '--output'],
      ['--author-only'],
    );
    const result = await captureBlindHoldout({
      packet: options['--packet'],
      output: options['--output'],
      authorOnly: options['--author-only'],
    });
    console.log(`Frozen capture: ${result.output} (${result.questions} questions)`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
