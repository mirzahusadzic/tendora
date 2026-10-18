/** Fixed offline Tendora acceptance. Only real PTY actions author or withdraw material. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openProject } from '../src/project/authoring/project.mjs';
import { acquiredTexts, retainAcquisitions } from '../src/project/storage/acquisitions.mjs';
import {
  acquireEngineRunLease,
  listEngineRuns,
  readEngineArtifact,
} from '../src/project/storage/engine-runs.mjs';
import { terminalCapture, captureGallery } from './support/terminal-capture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
export const language = Object.freeze({
  question: 'Which team should handle this ticket?',
  case: 'My payouts have failed three times.',
  statement: 'If my payouts fail, the billing team should handle this ticket.',
  independent: 'Who should handle this ticket?',
});
const requirements = [
  'root-scope',
  'initial-open',
  'concrete-aporia',
  'keyboard-anchor',
  'anchored-statement',
  'supported-billing',
  'independent-billing',
  'independent-identity',
  'withdrawn-statement',
  'answer-retracted',
  'withdrawn-open-identity',
  'cold-persistence',
  'cold-open-answer',
  'fixture-readings',
  'original-bytes',
  'protected-inputs',
  'offline',
  'pty-frames',
];
export function acceptanceStatus(checks) {
  return checks.length > 0 && checks.every((c) => c.status === 'pass') ? 'pass' : 'fail';
}

/** Hash physical files without opening the original through any storage API. */
export async function treeHashes(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(path, entry.name);
      assert(!entry.isSymbolicLink(), `Refusing symlink in evidence input: ${full}`);
      if (entry.isDirectory()) {
        if (
          (path.includes(`${sep}.proj${sep}`) || path.endsWith(`${sep}.proj`)) &&
          ['engine', 'recordings'].includes(entry.name)
        )
          continue;
        await visit(full);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.sqlite')) continue;
        const bytes = await readFile(full);
        files.push({ path: relative(directory, full), bytes: bytes.length, sha256: digest(bytes) });
      }
    }
  }
  await visit(directory);
  return { sha256: digest(JSON.stringify(files)), files };
}

export async function captureTendoraContract({
  output: requested,
  source = process.env.TENDORA_CONTRACT_SOURCE,
} = {}) {
  if (!source)
    throw new Error(
      'Set TENDORA_CONTRACT_SOURCE to your retained service project; it is not bundled.',
    );
  const tmp = join(root, 'tmp');
  await mkdir(tmp, { recursive: true });
  assert.equal(
    await realpath(tmp),
    tmp.replace(/\/$/u, ''),
    'tmp must not redirect outside worktree',
  );
  let output;
  if (requested) {
    output = resolve(root, requested);
    const rel = relative(tmp, output);
    assert(rel && !rel.startsWith('..') && !rel.startsWith('/'), 'Output must be beneath tmp/');
    // Only one new direct child: no symlink parents, overwrites or stale evidence.
    assert(!rel.includes('/'), 'Output must be a new direct child of tmp/');
    await mkdir(output);
  } else output = await mkdtemp(join(tmp, 'tendora-contract-'));
  const original = resolve(root, source);
  const projectPath = join(output, 'project');
  const manifest = {
    version: 1,
    contract: 'fixed-tendora-ticket-v1',
    language,
    rootRole: 'Tendora',
    original,
    sourceOverride: true,
    startedAt: new Date().toISOString(),
    output,
    command: {
      executable: process.execPath,
      argv: process.argv.slice(1),
      cwd: process.cwd(),
      npmScript: process.env.npm_lifecycle_event ?? null,
      environment: { TENDORA_CONTRACT_SOURCE: process.env.TENDORA_CONTRACT_SOURCE ?? null },
    },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    acquisition: { mode: 'retained-only', liveAllowed: false, imported: [], missing: [] },
    checks: requirements.map((id) => ({ id, status: 'blocked', detail: 'Not reached.' })),
    sessions: [],
    snapshots: [],
    failures: [],
    operations: [],
  };
  const save = () => writeFile(join(output, 'manifest.json'), json(manifest));
  const check = (id, label, ok, detail, evidence = null) => {
    const result = { id, label, status: ok ? 'pass' : 'fail', detail, evidence };
    const prior = manifest.checks.find((c) => c.id === id);
    if (prior) Object.assign(prior, result);
    else manifest.checks.push(result);
    return result;
  };
  const previousEnv = {
    options: process.env.NODE_OPTIONS,
    log: process.env.TENDORA_CAPTURE_NETWORK_LOG,
    pythonBytecode: process.env.PYTHONDONTWRITEBYTECODE,
  };
  const sessions = [];
  let before, protectedBefore, baseline, authored, withdrawn, release;
  let initial, supported, independent, retracted, coldAnswer, selectedOpening, rootPlacement;
  const expectedReadings = new Map();
  const observedReadings = [];
  const snapshot = async (name) => {
    const project = await openProject(projectPath);
    const data = { data: project.data, runs: await listEngineRuns(project) };
    const path = join(output, `${name}.evidence.json`);
    await writeFile(path, json(data));
    manifest.snapshots.push({ name, path, sha256: digest(json(data)) });
    return data;
  };
  const contribution = (state) =>
    state?.data.contributions?.find(
      (c) => c.question?.text === language.question && c.scopePlacementId === rootPlacement?.id,
    );
  const aporias = (c) => c?.partial?.aporias ?? c?.partial?.openings ?? [];
  const identity = (state) => {
    const c = contribution(state);
    return {
      id: c?.id,
      scope: c?.scopePlacementId,
      revision: c?.partial?.questionRevision,
      aporia: aporias(c).find((o) => o.id === selectedOpening?.id)?.id,
      anchor: aporias(c).find((o) => o.id === selectedOpening?.id)?.anchor,
    };
  };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const authoredContribution = (state) =>
    state?.data.contributions?.find((c) => c.responses?.some((r) => r.text === language.statement));
  const statementPart = (state) =>
    authoredContribution(state)?.responses?.find((r) => r.text === language.statement);
  const billingProof = (evidence) => {
    const c = authoredContribution(authored),
      part = statementPart(authored);
    const source = c && part && `contribution:${c.id}:${part.id}`;
    return Boolean(
      source &&
      evidence?.run?.status === 'supported' &&
      evidence.run.answer?.answers?.some(
        (a) =>
          /\bbilling\b/iu.test(a.text ?? '') &&
          evidence.answer === a.text &&
          a.derivation?.tree &&
          a.sourceIds?.includes(source),
      ),
    );
  };
  const capture = async (name, flow) => {
    const path = join(output, `${name}.capture.jsonl`);
    const session = {
      name,
      path,
      status: 'running',
      commands: [],
      startedAt: new Date().toISOString(),
      launch: {
        executable: process.execPath,
        argv: [
          join(root, 'tools/capture-workbench.mjs'),
          '--project',
          projectPath,
          '--out',
          path,
          '--width',
          '180',
          '--height',
          '54',
          '--check',
        ],
        cwd: output,
        environment: {
          EGEMMA_URL: 'http://127.0.0.1:1',
          PYTHONDONTWRITEBYTECODE: process.env.PYTHONDONTWRITEBYTECODE,
          NODE_OPTIONS: process.env.NODE_OPTIONS,
          TENDORA_CAPTURE_NETWORK_LOG: process.env.TENDORA_CAPTURE_NETWORK_LOG,
        },
      },
    };
    manifest.sessions.push(session);
    await save();
    try {
      await terminalCapture({ project: projectPath, output, name }, async (api) => {
        const step = async (command) => {
          const at = performance.now();
          const entry = { ...command, timeout: command.timeout ?? 30 };
          session.commands.push(entry);
          await save();
          try {
            return await api.step(command);
          } finally {
            entry.elapsedMs = performance.now() - at;
          }
        };
        const ask = async (text, label) => {
          await step({ keys: ['a', 'ALT_U'], paste: text, expect: ['Ask', text] });
          await step({
            keys: ['ALT_C', 'HOME', 'DOWN', 'ENTER'],
            waitForAny: ['Write a case', 'Edit case'],
          });
          await step({ keys: ['ALT_U'], paste: language.case, expect: [language.case] });
          await step({ keys: ['CTRL_S'], expect: ['Ask', language.case] });
          await step({
            keys: ['ENTER'],
            waitForAny: ['Answer:', 'Could not check:'],
            timeout: 120,
          });
          const screen = api.screen();
          const answer = screen.match(/Answer: ([^│┃┆\n]+)/u)?.[1]?.trim() ?? null;
          const p = await openProject(projectPath);
          const run = (await listEngineRuns(p)).find(
            (r) =>
              r.questions?.[0]?.text === text &&
              r.scopePlacementId === rootPlacement.id &&
              r.caseSelection?.sources?.map((s) => s.text).join(' ') === language.case,
          );
          const result = run?.resultRef ? await readEngineArtifact(p, run.resultRef) : null;
          const evidence = {
            text,
            case: language.case,
            answer,
            run,
            result,
            frame: api.frames.length - 1,
            capture: path,
          };
          await writeFile(join(output, `${label}.answer.json`), json(evidence));
          for (const input of result?.inputs ?? []) {
            if (expectedReadings.has(input.text))
              observedReadings.push({
                label,
                text: input.text,
                penman:
                  input.acquisition?.penman ??
                  input.acquisition?.inputs?.find((entry) => entry.text === input.text)?.penman,
                preparedPenman: input.penman,
                acquisition: input.acquisition,
              });
          }
          check(
            `ask-${label}`,
            `Check ${text} with the fixed case`,
            Boolean(answer && run && result && run.projectDigest === p.digest),
            `Editor: ${answer}; engine: ${run?.status}; result retained: ${Boolean(result)}`,
            `${label}.answer.json`,
          );
          return evidence;
        };
        await flow({ ...api, step, ask });
      });
      session.status = 'pass';
    } catch (error) {
      session.status = 'fail';
      session.failure = error.message;
      manifest.failures.push({ session: name, message: error.message, capture: path });
    } finally {
      let frames = [];
      try {
        frames = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
      } catch (error) {
        session.readFailure = error.message;
      }
      session.frames = frames.length;
      session.actions = frames.filter((frame) => frame.command).map((frame) => frame.command);
      session.frameErrors = frames
        .filter((f) => f.error)
        .map((f, index) => ({ index, error: f.error }));
      session.editorExitCode = frames.at(-1)?.exitCode ?? null;
      if (!frames.length || session.frameErrors.length || session.editorExitCode !== 0)
        session.status = 'fail';
      session.sha256 = digest(await readFile(path).catch(() => Buffer.from('')));
      session.finishedAt = new Date().toISOString();
      sessions.push({ name, path, frames });
      await save();
    }
    return session;
  };
  try {
    protectedBefore = {
      projects: await treeHashes(join(root, '.proj')),
      handHarness: digest(await readFile(join(root, 'tools/capture-hand-contract.mjs'))),
    };
    manifest.protectedBefore = protectedBefore;
    manifest.source = { src: await treeHashes(join(root, 'src')), files: [] };
    for (const path of [
      'AGENTS.md',
      'docs/architecture.md',
      'docs/development.md',
      'package.json',
      'package-lock.json',
      'tools/capture-tendora-contract.mjs',
      'tools/capture-workbench.mjs',
      'tools/support/terminal-capture.mjs',
      'tools/support/offline-terminal.mjs',
      'test/support/terminal-driver.py',
      'test/support/qa-domain-fixtures.json',
      'test/support/qa-grammar-fixtures.json',
      'test/support/tendora-service-acquisitions.json',
      'test/acceptance/tendora-contract.mjs',
      'test/tui/inquiries/open-gap-authoring.mjs',
      'test/suites.mjs',
      'test/run.mjs',
    ]) {
      const bytes = await readFile(join(root, path));
      manifest.source.files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
    }
    assert.equal(await realpath(original), original, 'Original ancestors must not be symlinks');
    assert(!(await lstat(original)).isSymbolicLink(), 'Original must not be a symlink');
    before = await treeHashes(original);
    manifest.originalBefore = before;
    await cp(original, projectPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (path) =>
        path === original ||
        (!path.endsWith('.sqlite') &&
          !['engine', 'recordings'].includes(relative(original, path).split(sep)[0])),
    });
    manifest.copiedBefore = await treeHashes(projectPath);
    assert.equal(before.sha256, manifest.copiedBefore.sha256, 'Disposable copy differs');
    const project = await openProject(projectPath);
    rootPlacement = project.data.placements.find((p) => p.parentId === null);
    const rootConcept = project.data.concepts.find((c) => c.id === rootPlacement?.conceptId);
    check('root-scope', 'Actual Tendora root role', rootConcept?.name === 'Tendora', {
      placement: rootPlacement,
      concept: rootConcept?.name,
    });
    assert.equal(rootConcept?.name, 'Tendora');
    await snapshot('original-copy');
    // Import exact retained PENMAN only. Do not import fixture rules or expected answers.
    for (const [text, path, collection] of [
      [language.question, 'test/support/qa-domain-fixtures.json', 'graphs'],
      [language.case, 'test/support/qa-domain-fixtures.json', 'graphs'],
      [language.statement, 'test/support/qa-grammar-fixtures.json', 'entries'],
      [language.independent, 'test/support/qa-grammar-fixtures.json', 'entries'],
    ]) {
      const fixture = JSON.parse(await readFile(join(root, path)));
      const entry = fixture[collection].find((e) => e.text === text);
      const penman = entry?.acquisition?.penman ?? entry?.penman;
      if (!penman) {
        manifest.acquisition.missing.push({ text, path });
        continue;
      }
      expectedReadings.set(text, penman);
      const retained = (await acquiredTexts(project, [text]))?.[0];
      if (retained?.status === 'retained') {
        assert.equal(retained.penman, penman, `Existing acquisition differs for ${text}`);
      } else {
        await retainAcquisitions(project, [
          {
            text,
            penman,
            ...(entry.acquisition ? { acquisition: entry.acquisition } : {}),
            origin: {
              kind: 'retained-fixture',
              path,
              collection,
              entrySha256: digest(json(entry)),
            },
          },
        ]);
      }
      manifest.acquisition.imported.push({
        text,
        path,
        collection,
        entrySha256: digest(json(entry)),
        penmanSha256: digest(penman),
        penman,
        existing: retained?.status === 'retained',
        provenance: entry.acquisition ?? fixture.origin,
        retained: (await acquiredTexts(project, [text]))[0],
      });
    }
    assert.equal(manifest.acquisition.missing.length, 0, 'Required frozen acquisition missing');
    process.env.NODE_OPTIONS = `--import=${pathToFileURL(join(root, 'tools/support/offline-terminal.mjs')).href}`;
    process.env.PYTHONDONTWRITEBYTECODE = '1';
    process.env.TENDORA_CAPTURE_NETWORK_LOG = join(output, 'network-attempts.jsonl');
    await writeFile(process.env.TENDORA_CAPTURE_NETWORK_LOG, '');
    release = await acquireEngineRunLease(project, randomUUID());

    await capture('01-anchor-and-reask', async ({ step, ask, screen, frames }) => {
      initial = await ask(language.question, 'initial');
      baseline = await snapshot('baseline');
      check(
        'initial-open',
        'Question is initially open',
        initial.run?.status === 'open' && initial.answer === 'Still open.',
        { answer: initial.answer, status: initial.run?.status },
        'initial.answer.json',
      );
      const reading = initial.result?.inputs.find((i) => i.kind === 'question');
      const initialOpenings = initial.run?.answer?.partial?.openings ?? [];
      // Select a concrete relation in the acquired question, using only the
      // visible keyboard workflow to author its elaboration.
      const target = initialOpenings.find(
        (o) =>
          o.anchor?.kind === 'edge' &&
          reading.graph.nodes.find((n) => n.id === o.anchor.from)?.concept === 'handle-01' &&
          reading.graph.nodes.find((n) => n.id === o.anchor.to)?.concept === 'ticket',
      );
      assert(target, 'No concrete handling/ticket opening exists');
      await step({ keys: ['HOME'] });
      let selected = false;
      for (let i = 0; i < 50; i++) {
        if (
          screen()
            .split('\n')
            .some((line) => /›\s+handle\s*\/.*ticket/u.test(line))
        ) {
          selected = true;
          break;
        }
        await step({ keys: ['DOWN'] });
      }
      assert(selected, 'Keyboard could not select the visible handling/ticket gap');
      await step({ keys: ['ENTER'], expect: ['Connection gap'] });
      manifest.selectedConnection = {
        opening: target,
        frame: frames.length - 1,
        capture: '01-anchor-and-reask.capture.jsonl',
        screen: screen(),
      };
      check(
        'keyboard-anchor',
        'Keyboard opens the exact concrete gap',
        /handle.*ticket/iu.test(screen()) && /add statement here/u.test(screen()),
        manifest.selectedConnection,
        '01-anchor-and-reask.capture.jsonl',
      );
      await step({
        keys: ['n'],
        paste: language.statement,
        expect: ['Add statements', language.statement],
      });
      await step({
        keys: ['CTRL_S'],
        waitForAny: ['Source statements', 'Answer:', 'Could not check:'],
        timeout: 120,
      });
      authored = await snapshot('authored');
      const c = contribution(authored);
      selectedOpening = aporias(c).find((o) => equal(o.anchor, target.anchor));
      check(
        'concrete-aporia',
        'Persist the selected concrete aporia on explicit elaboration',
        Boolean(c?.id && c.partial?.questionRevision && selectedOpening?.id),
        { contributionId: c?.id, opening: selectedOpening },
        'authored.evidence.json',
      );
      const a = authoredContribution(authored)?.anchor;
      check(
        'anchored-statement',
        'Statement persists at the selected connection',
        Boolean(
          a &&
          a.contributionId === c?.id &&
          a.edgeId === target.anchor.edgeId &&
          a.from === target.anchor.from &&
          a.to === target.anchor.to &&
          a.role === target.anchor.role &&
          !statementPart(authored)?.withdrawn,
        ),
        { expected: target.anchor, actual: a },
        'authored.evidence.json',
      );
      supported = await ask(language.question, 'supported');
      check(
        'supported-billing',
        'Re-ask yields billing with an anchored-source chart derivation',
        billingProof(supported),
        { answer: supported.answer, status: supported.run?.status },
        'supported.answer.json',
      );
      independent = await ask(language.independent, 'independent');
      check(
        'independent-billing',
        'Independent question yields billing with a chart derivation',
        billingProof(independent),
        { answer: independent.answer, status: independent.run?.status },
        'independent.answer.json',
      );
      const openings = independent.run?.answer?.openings ?? [];
      check(
        'independent-identity',
        'Independent question reaches the same stored aporia',
        Boolean(c?.id && selectedOpening?.id) &&
          openings.some(
            (o) =>
              o.kind === 'aporia' && o.contributionId === c?.id && o.id === selectedOpening?.id,
          ),
        { expectedContribution: c?.id, expectedOpening: selectedOpening?.id, observed: openings },
        'independent.answer.json',
      );
      await snapshot('after-independent');
    });
    // Separate sessions ensure a failed support assertion never hides withdrawal or reload.
    await capture('02-withdraw', async ({ step, ask }) => {
      const p = await snapshot('before-withdraw');
      assert(
        statementPart(p) && !statementPart(p).withdrawn,
        'Anchored statement was not authored',
      );
      // The root source fields precede the anchored material field. Tab through the
      // ordinary source editor, then clear only that exact statement.
      const { roleStatements } = await import('../src/engine/statements.mjs');
      const blocks = roleStatements(p.data, rootPlacement.id);
      const at = blocks.findIndex((b) => b.contributionId === authoredContribution(p).id);
      assert(at >= 0, 'Anchored statement missing from root source editor');
      const tabs = blocks.slice(0, at).reduce((n, b) => n + b.texts.length, 0);
      await step({
        keys: ['e', ...Array(tabs).fill('TAB')],
        expect: ['Edit statements', language.statement],
      });
      await step({ keys: ['ALT_U'] });
      await step({
        keys: ['CTRL_S'],
        waitForAny: ['Source statements', 'Answer:', 'Could not check:'],
        timeout: 120,
      });
      retracted = await ask(language.question, 'withdrawn');
      withdrawn = await snapshot('withdrawn');
      check(
        'withdrawn-statement',
        'Editor withdraws the exact anchored response',
        Boolean(
          statementPart(withdrawn)?.withdrawn &&
          statementPart(withdrawn)?.id === statementPart(authored)?.id,
        ),
        statementPart(withdrawn),
        'withdrawn.evidence.json',
      );
      check(
        'answer-retracted',
        'Dependent supported answer retracts to open',
        billingProof(supported) &&
          retracted.run?.status === 'open' &&
          retracted.answer === 'Still open.' &&
          !retracted.run?.answer?.answers?.length,
        {
          before: supported?.answer,
          after: retracted.answer,
          beforeStatus: supported?.run?.status,
          afterStatus: retracted.run?.status,
        },
        'withdrawn.answer.json',
      );
      check(
        'withdrawn-open-identity',
        'Contribution and selected aporia remain open and revisitable',
        Boolean(
          selectedOpening &&
          equal(identity(authored), identity(withdrawn)) &&
          aporias(contribution(withdrawn)).some(
            (o) => o.id === selectedOpening.id && o.state === 'open',
          ),
        ),
        { before: identity(authored), after: identity(withdrawn) },
        'withdrawn.evidence.json',
      );
    });
    await capture('03-cold-reload', async ({ ask }) => {
      const beforeAsk = await snapshot('cold-before-ask');
      coldAnswer = await ask(language.question, 'cold');
      const cold = await snapshot('cold');
      check(
        'cold-persistence',
        'Cold reload retains contribution, aporia and withdrawal',
        Boolean(
          withdrawn &&
          selectedOpening &&
          equal(identity(withdrawn), identity(beforeAsk)) &&
          equal(identity(withdrawn), identity(cold)) &&
          statementPart(beforeAsk)?.withdrawn &&
          statementPart(cold)?.withdrawn &&
          statementPart(cold)?.id === statementPart(withdrawn)?.id &&
          aporias(contribution(cold)).some(
            (o) => o.id === selectedOpening.id && o.state === 'open',
          ),
        ),
        { withdrawn: identity(withdrawn), beforeAsk: identity(beforeAsk), cold: identity(cold) },
        ['cold-before-ask.evidence.json', 'cold.evidence.json'],
      );
      check(
        'cold-open-answer',
        'Cold re-ask is open with no dependent answer',
        Boolean(
          retracted?.run?.status === 'open' &&
          coldAnswer.run?.status === 'open' &&
          coldAnswer.answer === 'Still open.' &&
          !coldAnswer.run?.answer?.answers?.length,
        ),
        { answer: coldAnswer.answer, status: coldAnswer.run?.status },
        'cold.answer.json',
      );
    });
    manifest.acquisition.observed = observedReadings;
    check(
      'fixture-readings',
      'Actual engine inputs preserve the exact frozen acquisitions',
      [...expectedReadings].every(([text, penman]) =>
        observedReadings.some((r) => r.text === text && r.penman === penman),
      ) && observedReadings.every((r) => r.penman === expectedReadings.get(r.text)),
      observedReadings.map(({ label, text, penman }) => ({
        label,
        text,
        matchesFixture: penman === expectedReadings.get(text),
      })),
      'manifest.json',
    );
  } catch (error) {
    manifest.failures.push({ message: error.message, stack: error.stack });
  } finally {
    if (release)
      await release().catch((error) => manifest.failures.push({ message: error.message }));
    for (const [key, value] of Object.entries({
      NODE_OPTIONS: previousEnv.options,
      PYTHONDONTWRITEBYTECODE: previousEnv.pythonBytecode,
      TENDORA_CAPTURE_NETWORK_LOG: previousEnv.log,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (before) {
      manifest.originalAfter = await treeHashes(original);
      check(
        'original-bytes',
        'Original Tendora bytes unchanged',
        equal(before, manifest.originalAfter),
        'All paths, byte lengths and SHA-256 hashes compared.',
      );
    }
    if (protectedBefore) {
      manifest.protectedAfter = {
        projects: await treeHashes(join(root, '.proj')),
        handHarness: digest(await readFile(join(root, 'tools/capture-hand-contract.mjs'))),
      };
      check(
        'protected-inputs',
        'All original projects and the hand harness remain byte-identical',
        equal(protectedBefore, manifest.protectedAfter),
        'Physical input hashes compared.',
      );
    }
    const attempts = (
      await readFile(join(output, 'network-attempts.jsonl'), 'utf8').catch(() => '')
    )
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    manifest.acquisition.preventedRequests = attempts;
    check(
      'offline',
      'Only retained acquisition used; no live eGemma',
      !attempts.some((a) => !a.url.endsWith('/embed/texts')) &&
        !manifest.acquisition.missing.length,
      `${attempts.length} prevented fetches (including optional embeddings); none were sent.`,
    );
    check(
      'pty-frames',
      'All three real PTY sessions complete without frame errors',
      manifest.sessions.length === 3 &&
        manifest.sessions.every(
          (s) => s.status === 'pass' && s.frames > 0 && s.editorExitCode === 0,
        ),
      manifest.sessions.map(({ name, status, frames, editorExitCode }) => ({
        name,
        status,
        frames,
        editorExitCode,
      })),
    );
    manifest.frameCount = manifest.sessions.reduce((n, s) => n + (s.frames ?? 0), 0);
    manifest.failures.push(
      ...manifest.checks
        .filter((c) => c.status !== 'pass')
        .map((c) => ({ check: c.id, status: c.status, detail: c.detail })),
    );
    manifest.status = acceptanceStatus([
      ...manifest.checks,
      ...manifest.sessions,
      { status: manifest.failures.length ? 'fail' : 'pass' },
    ]);
    manifest.finishedAt = new Date().toISOString();
    try {
      manifest.copiedAfter = await treeHashes(projectPath);
    } catch (error) {
      manifest.copyUnavailable = { code: error.code, message: error.message };
    }
    await captureGallery(output, sessions);
    await save();
  }
  console.log(
    `Tendora acceptance: ${manifest.status.toUpperCase()} | ${manifest.frameCount} PTY frames | ${join(output, 'manifest.json')}`,
  );
  for (const c of manifest.checks) console.log(`${c.id}: ${c.status}`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((a) => a.startsWith('--'))) {
    console.error(
      'Usage: TENDORA_CONTRACT_SOURCE=/path/to/project node tools/capture-tendora-contract.mjs [tmp/new-evidence-directory] (offline only)',
    );
    process.exitCode = 2;
  } else {
    try {
      process.exitCode =
        (await captureTendoraContract({ output: args[0] })).status === 'pass' ? 0 : 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
