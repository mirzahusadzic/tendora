/** Offline acceptance on the real hand snapshot. Only the PTY authors corpus material. */
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
import { openProject, saveProject } from '../src/project/authoring/project.mjs';
import { reviseContribution } from '../src/engine/develop.mjs';
import { developedConcepts } from '../src/engine/concepts.mjs';
import { acquiredTexts, retainAcquisitions } from '../src/project/storage/acquisitions.mjs';
import {
  acquireEngineRunLease,
  listEngineRuns,
  readEngineArtifact,
} from '../src/project/storage/engine-runs.mjs';
import { compactEngineStorage } from '../src/project/inquiries/engine-storage.mjs';
import { terminalCapture, captureGallery } from './support/terminal-capture.mjs';
import { originalHandQuestion } from '../test/support/original-hand-question.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
export const language = {
  compound: originalHandQuestion,
  observation: 'The programmer recognizes their intention in the workbench.',
  independentObservation: 'A simulation rehearses possibilities in the digital work.',
  supported: 'Who recognizes their intention in the workbench?',
  alternate: 'What is recognized by the programmer?',
  open: 'Does the programmer recognize their intention in the interface?',
  elaborate: 'How does the design of the interface participate in recognizing intention?',
  independent: 'What rehearses possibilities in the digital work?',
};
export const criteria = [
  [
    'C1',
    'Persist the question and a concrete anchored aporia with identity, scope and source revision.',
  ],
  [
    'C2',
    'Author supported parts without closing unrelated connections or affirming the whole question.',
  ],
  [
    'C3',
    'Independent questions revisit the same supported meaning and unresolved connection with evidence and ambiguity.',
  ],
  [
    'C4',
    'Elaborate an anchored connection; withdraw only dependent support and retain revisitable openings.',
  ],
  [
    'C5',
    'Reload, sentence order and cache rebuild preserve identity; changed context is reported.',
  ],
];
export function acceptanceStatus(checks) {
  return checks.length > 0 && checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';
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

export async function captureHandContract({
  output: requested,
  source = process.env.HAND_CONTRACT_SOURCE,
} = {}) {
  if (!source)
    throw new Error('Set HAND_CONTRACT_SOURCE to your retained hand project; it is not bundled.');
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
  } else output = await mkdtemp(join(tmp, 'hand-contract-'));
  const original = resolve(root, source);
  const projectPath = join(output, 'project');
  const manifest = {
    version: 1,
    contract: 'docs/development.md#external-research-profiles',
    startedAt: new Date().toISOString(),
    output,
    command: { executable: process.execPath, argv: process.argv.slice(1), cwd: process.cwd() },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    acquisition: { mode: 'retained-only', liveAllowed: false, imported: [], missing: [] },
    criteria: criteria.map(([id, requirement]) => ({
      id,
      requirement,
      status: 'blocked',
      checks: [],
    })),
    checks: [],
    sessions: [],
    snapshots: [],
    failures: [],
    operations: [],
  };
  const save = () => writeFile(join(output, 'manifest.json'), json(manifest));
  const check = (id, label, ok, detail, evidence = null) => {
    const result = { id, label, status: ok ? 'pass' : 'fail', detail, evidence };
    manifest.checks.push(result);
    return result;
  };
  const assign = (id, checks) => {
    const item = manifest.criteria.find((c) => c.id === id);
    item.checks = checks.map((c) => c.id);
    item.status = acceptanceStatus(checks);
    item.failures = checks.filter((c) => c.status !== 'pass').map((c) => c.detail);
  };
  const previousEnv = {
    options: process.env.NODE_OPTIONS,
    log: process.env.TENDORA_CAPTURE_NETWORK_LOG,
    pythonBytecode: process.env.PYTHONDONTWRITEBYTECODE,
  };
  const sessions = [];
  let before, baseline, authored, withdrawn, release;
  const snapshot = async (name) => {
    const project = await openProject(projectPath);
    const data = { data: project.data, runs: await listEngineRuns(project) };
    const path = join(output, `${name}.evidence.json`);
    await writeFile(path, json(data));
    manifest.snapshots.push({ name, path, sha256: digest(json(data)) });
    return data;
  };
  const contribution = (state) =>
    state.data.contributions?.find((c) => c.question?.text === language.compound);
  const identity = (state) => {
    const c = contribution(state);
    return {
      id: c?.id,
      scope: c?.scopePlacementId,
      questionRevision: c?.partial?.questionRevision,
      openings: c?.partial?.openings?.map((o) => ({ id: o.id, anchor: o.anchor })),
    };
  };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
          await step({ keys: ['a', 'ALT_U'], text, expect: ['Ask'] });
          await step({
            keys: ['ENTER'],
            waitForAny: ['Answer:', 'Could not check:'],
            timeout: 120,
          });
          const screen = api.screen();
          const answer = screen.match(/Answer: ([^│┃┆\n]+)/u)?.[1]?.trim() ?? null;
          const p = await openProject(projectPath);
          const run = (await listEngineRuns(p)).find((r) => r.questions?.[0]?.text === text);
          const result = run?.resultRef ? await readEngineArtifact(p, run.resultRef) : null;
          const evidence = {
            text,
            answer,
            run,
            result,
            frame: api.frames.length - 1,
            capture: path,
          };
          await writeFile(join(output, `${label}.answer.json`), json(evidence));
          check(
            `ask-${label}`,
            `Check ${text}`,
            Boolean(answer && run && result),
            answer
              ? `Editor: ${answer}; engine: ${run?.status}; result retained: ${Boolean(result)}`
              : screen,
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
      session.finishedAt = new Date().toISOString();
      sessions.push({ name, path, frames });
      await save();
    }
    return session;
  };
  try {
    assert.equal(await realpath(original), original, 'Original ancestors must not be symlinks');
    assert(!(await lstat(original)).isSymbolicLink(), 'Original must not be a symlink');
    before = await treeHashes(original);
    manifest.originalBefore = before;
    manifest.source = { src: await treeHashes(join(root, 'src')), files: [] };
    for (const path of [
      'package.json',
      'package-lock.json',
      'docs/development.md',
      'tools/capture-hand-contract.mjs',
      'tools/capture-workbench.mjs',
      'tools/support/terminal-capture.mjs',
      'tools/support/offline-terminal.mjs',
      'test/support/terminal-driver.py',
      'test/support/original-hand-question.mjs',
      'test/support/qa-development-acquisitions.json',
      'test/acceptance/hand-contract.mjs',
      'test/suites.mjs',
      'test/run.mjs',
    ]) {
      const bytes = await readFile(join(root, path));
      manifest.source.files.push({ path, sha256: digest(bytes), bytes: bytes.length });
    }
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
    assert.equal(
      before.sha256,
      manifest.copiedBefore.sha256,
      'Disposable copy differs from original',
    );
    let project = await openProject(projectPath);
    baseline = await snapshot('baseline');
    // These are existing unedited parser captures, never constructed graphs or premises.
    const captures = JSON.parse(
      await readFile(join(root, 'test/support/qa-development-acquisitions.json')),
    ).entries;
    for (const text of Object.values(language)) {
      const retained = (await acquiredTexts(project, [text]))?.[0];
      if (retained?.status === 'retained') continue;
      const entry = captures.find((e) => e.text === text && e.acquisition?.penman);
      if (!entry) {
        manifest.acquisition.missing.push(text);
        continue;
      }
      await retainAcquisitions(project, [
        {
          text,
          penman: entry.acquisition.penman,
          acquisition: entry.acquisition,
          origin: {
            kind: 'original-parser-capture',
            path: 'test/support/qa-development-acquisitions.json',
            sha256: digest(JSON.stringify(entry)),
          },
        },
      ]);
      manifest.acquisition.imported.push({
        text,
        sha256: digest(JSON.stringify(entry)),
        model: entry.acquisition.model,
        revision: entry.acquisition.revision,
        inputTokens: entry.acquisition.input_tokens,
        outputTokens: entry.acquisition.output_tokens,
      });
    }
    process.env.NODE_OPTIONS = `--import=${pathToFileURL(join(root, 'tools/support/offline-terminal.mjs')).href}`;
    process.env.PYTHONDONTWRITEBYTECODE = '1';
    process.env.TENDORA_CAPTURE_NETWORK_LOG = join(output, 'network-attempts.jsonl');
    await writeFile(process.env.TENDORA_CAPTURE_NETWORK_LOG, '');
    release = await acquireEngineRunLease(project, randomUUID());
    const compoundContributionId = contribution(baseline)?.id;
    let anchorCheck,
      compoundBefore,
      compoundAfter,
      probeBefore,
      probeAfter,
      alternate,
      open,
      elaboration,
      independentBefore,
      anchored;
    const contextPath = join(output, 'context-project');
    await capture('01-develop', async ({ step, ask, screen, clickText, frames }) => {
      compoundBefore = await ask(language.compound, 'compound-before');
      probeBefore = await ask(language.supported, 'probe-before');
      compoundBefore = await ask(language.compound, 'compound-before-gap');
      await clickText('intercede / on behalf of: interfaces');
      await step({ expect: ['Connection gap'] });
      const gapScreen = screen();
      const canElaborate =
        /(?:elaborate|develop (?:this|open|selected) (?:connection|part)|add (?:observation|support))/iu.test(
          gapScreen,
        );
      anchorCheck = check(
        'anchored-language-action',
        'Elaborate the selected concrete interface connection',
        canElaborate,
        canElaborate
          ? 'The relation exposes an elaboration action and the capture exercises it.'
          : 'Selected interface connection exposes reading inspection and back only; no language elaboration action is available.',
        { capture: '01-develop.capture.jsonl', frame: frames.length - 1 },
      );
      if (canElaborate) {
        // The action must be exercised; a visible footer entry alone is not evidence.
        await step({ keys: ['n'], paste: language.observation, expect: ['Add statements'] });
        await step({
          keys: ['CTRL_S'],
          waitForAny: ['Source statements', 'Answer:', 'Could not check:'],
          timeout: 120,
        });
        anchored = await snapshot('anchored');
        const anchoredContribution = anchored?.data.contributions?.find((entry) =>
          entry.responses?.some((response) => response.text === language.observation),
        );
        check(
          'anchored-elaboration',
          'Persist an elaboration on the selected connection',
          Boolean(
            anchoredContribution?.anchor?.edgeId &&
            anchoredContribution.anchor.contributionId === compoundContributionId,
          ),
          anchoredContribution?.anchor?.edgeId
            ? 'The authored statement is attached to the selected concrete edge.'
            : 'The selected connection action did not persist a concrete edge anchor.',
          'anchored.evidence.json',
        );
      } else {
        const elaborationCheck = check(
          'anchored-elaboration',
          'Persist an elaboration on the selected connection',
          false,
          anchorCheck.detail,
        );
        elaborationCheck.status = 'blocked';
        await step({ keys: ['ESC'], expect: ['Develop question'] });
      }
      probeAfter = await ask(language.supported, 'probe-after');
      await step({
        keys: ['n'],
        paste: language.independentObservation,
        expect: ['Add statements'],
      });
      await step({
        keys: ['CTRL_S'],
        waitForAny: ['Source statements', 'Answer:', 'Could not check:'],
        timeout: 30,
      });
      independentBefore = await ask(language.independent, 'independent-before');
      alternate = await ask(language.alternate, 'alternate');
      open = await ask(language.open, 'interface-open');
      elaboration = await ask(language.elaborate, 'elaboration-as-question');
      compoundAfter = await ask(language.compound, 'compound-after');
      authored = await snapshot('authored');
      await cp(projectPath, contextPath, { recursive: true });
    });
    const stored = contribution(baseline);
    const concrete =
      stored?.partial?.openings?.filter(
        (o) =>
          o.anchor?.kind === 'edge' &&
          [o.anchor.from, o.anchor.to].every((id) =>
            stored.question.graph.nodes.some((n) => n.id === id && n.concept !== 'amr-unknown'),
          ),
      ) ?? [];
    const persisted = check(
      'persisted-concrete-aporia',
      'Snapshot retains concrete aporias',
      Boolean(
        stored?.id &&
        stored.scopePlacementId &&
        stored.partial?.questionRevision &&
        stored.partial?.dependenciesRevision &&
        concrete.length,
      ),
      `${concrete.length} concrete anchored openings retained; this is pre-existing snapshot evidence.`,
      'baseline.evidence.json',
    );
    assign('C1', [
      persisted,
      check(
        'question-persistence',
        'Language Ask preserves the existing compound identity and uncertainty',
        Boolean(
          authored &&
          equal(identity(baseline), identity(authored)) &&
          compoundAfter?.answer === 'Still open.',
        ),
        'Compared question, scope, revision and concrete anchors after language authoring; the existing snapshot supplies the initial contribution.',
        'authored.evidence.json',
      ),
    ]);
    const authoredContribution = authored?.data.contributions?.find((c) =>
      c.responses?.some((r) => r.text === language.observation && !r.withdrawn),
    );
    const independentContribution = authored?.data.contributions?.find((c) =>
      c.responses?.some((r) => r.text === language.independentObservation && !r.withdrawn),
    );
    const independentPart = independentContribution?.responses.find(
      (r) => r.text === language.independentObservation,
    );
    const independentSource =
      independentPart && `contribution:${independentContribution.id}:${independentPart.id}`;
    // Distinct simulation occurrences can yield honest ambiguity. Require the exact
    // independent source's chart witness, not a falsely unique displayed answer.
    const hasIndependentProof = (evidence) => {
      const answer = evidence?.run?.answer;
      const proofs = [...(answer?.answers ?? []), ...(answer?.candidates ?? [])];
      return Boolean(
        independentSource &&
        ['supported', 'ambiguous'].includes(evidence?.run?.status) &&
        (evidence.run.status !== 'ambiguous' ||
          evidence.answer === 'Several answers remain possible.') &&
        proofs.some((p) => p.sourceIds?.includes(independentSource) && p.derivation?.tree),
      );
    };
    const supportedCheck = check(
      'authored-support',
      'Observation establishes support with a chart witness',
      Boolean(
        authoredContribution &&
        probeAfter?.run?.status === 'supported' &&
        probeAfter?.run?.answer?.answers?.some((a) => a.derivation?.tree),
      ),
      `Before: ${probeBefore?.answer}; after: ${probeAfter?.answer}; authored contribution: ${authoredContribution?.id ?? 'absent'}`,
      'probe-after.answer.json',
    );
    const incomplete = check(
      'unrelated-stays-open',
      'Compound and interface remain open',
      Boolean(
        compoundBefore?.answer === 'Still open.' &&
        compoundAfter?.answer === 'Still open.' &&
        open?.answer === 'Still open.' &&
        contribution(authored ?? baseline)?.partial?.openings?.length > 0,
      ),
      `Compound before: ${compoundBefore?.answer}; after: ${compoundAfter?.answer}; interface after: ${open?.answer}`,
      'interface-open.answer.json',
    );
    const anchoredSupport = check(
      'partial-authoring-link',
      'Authored support belongs to the persistent compound contribution',
      Boolean(authoredContribution?.anchor?.contributionId === stored?.id),
      authoredContribution?.anchor?.contributionId === stored?.id
        ? 'The observation is attached to the compound contribution with a concrete edge anchor.'
        : authoredContribution
          ? 'The observation was saved without the compound anchor.'
          : 'Observation was not saved.',
      'authored.evidence.json',
    );
    assign('C2', [supportedCheck, incomplete, anchoredSupport]);
    const aporiaIds = (evidence) =>
      new Set(
        (evidence?.run?.answer?.openings ?? [])
          .filter((opening) => opening.kind === 'aporia' && opening.contributionId === stored?.id)
          .map((opening) => opening.id),
      );
    const commonOpenings = [...aporiaIds(open)].filter((id) => aporiaIds(elaboration).has(id));
    const sameOpening = commonOpenings.length > 0;
    assign('C3', [
      check(
        'independent-revisit',
        'Independent questions reach the stored anchored connection',
        sameOpening,
        `Interface and elaboration share aporia ${commonOpenings.join(', ') || 'none'}. Alternate remains open at acquisition: recognize-01 vs recognize-02.`,
        ['interface-open.answer.json', 'elaboration-as-question.answer.json'],
      ),
      check(
        'alternate-acquisition-limit',
        'Alternate predicate sense is disclosed rather than silently merged',
        alternate?.run?.status === 'open',
        `Alternate: ${alternate?.answer}; its acquired predicate does not match the hand source sense.`,
        'alternate.answer.json',
      ),
    ]);

    const rootPlacement = authored.data.placements.find((placement) => placement.parentId === null);
    const rootPassages = authored.data.concepts
      .find((concept) => concept.id === rootPlacement.conceptId)
      .passages.slice(0, 2);
    // Reorder only the root source block. The anchored contribution is a separate
    // object and must not be rewritten while testing sentence order.
    const editRootOrder = async (api) => {
      await api.step({ keys: ['ESC', 'HOME', 'e'], expect: ['Edit statements'] });
      await api.step({ keys: ['ALT_U'], paste: rootPassages[1] });
      await api.step({ keys: ['TAB'] });
      await api.step({ keys: ['ALT_U'], paste: rootPassages[0] });
      await api.step({
        keys: ['CTRL_S'],
        waitForAny: ['Source statements', 'Answer:', 'Could not check:'],
        timeout: 30,
      });
    };
    const withdrawAnchoredObservation = async (api) => {
      // Two unchanged root passages precede the anchored material contribution.
      await api.step({ keys: ['ESC', 'HOME', 'e', 'TAB', 'TAB'], expect: ['Edit statements'] });
      await api.step({ keys: ['ALT_U'] });
      await api.step({
        keys: ['CTRL_S'],
        waitForAny: ['Source statements', 'Answer:', 'Could not check:'],
        timeout: 30,
      });
    };
    let reordered, probeWithdrawn, independentWithdrawn;
    await capture('02-order-withdraw', async (api) => {
      await editRootOrder(api);
      reordered = await snapshot('reordered');
      await api.ask(language.supported, 'probe-reordered');
      await api.step({ keys: ['ESC'] });
      await withdrawAnchoredObservation(api);
      probeWithdrawn = await api.ask(language.supported, 'probe-withdrawn');
      independentWithdrawn = await api.ask(language.independent, 'independent-withdrawn');
      await api.ask(language.compound, 'compound-withdrawn');
      withdrawn = await snapshot('withdrawn');
    });
    const withdrawal = check(
      'withdrawal',
      'Withdrawal retracts dependent support and keeps independent support',
      Boolean(
        probeAfter?.run?.status === 'supported' &&
        probeWithdrawn?.answer === probeBefore?.answer &&
        hasIndependentProof(independentBefore) &&
        hasIndependentProof(independentWithdrawn),
      ),
      `Dependent: ${probeAfter?.answer} -> ${probeWithdrawn?.answer}; baseline: ${probeBefore?.answer}; independent: ${independentWithdrawn?.answer}`,
      'probe-withdrawn.answer.json',
    );
    assign(
      'C4',
      [
        anchorCheck,
        manifest.checks.find((c) => c.id === 'anchored-elaboration'),
        withdrawal,
      ].filter(Boolean),
    );
    let reloaded, coldProbe, coldIndependent;
    await capture('03-cold-reload', async (api) => {
      coldProbe = await api.ask(language.supported, 'probe-cold');
      coldIndependent = await api.ask(language.independent, 'independent-cold');
      await api.ask(language.compound, 'compound-cold');
      reloaded = await snapshot('cold');
    });
    check(
      'cold-reload',
      'Cold editor process preserves contribution and opening identities',
      Boolean(
        withdrawn &&
        reloaded &&
        equal(identity(withdrawn), identity(reloaded)) &&
        coldProbe?.answer === probeWithdrawn?.answer &&
        hasIndependentProof(coldIndependent),
      ),
      'Compared durable compound identity, scope, question revision and concrete opening identities.',
      'cold.evidence.json',
    );
    check(
      'sentence-order',
      'Sentence reorder preserves authored response identities',
      Boolean(
        authoredContribution &&
        reordered &&
        equal(
          authoredContribution.responses.map((r) => [r.id, r.text]).sort(),
          reordered.data.contributions
            .find((c) => c.id === authoredContribution.id)
            ?.responses.map((r) => [r.id, r.text])
            .sort(),
        ),
      ),
      'Compared response identities and exact language before and after a PTY sentence reorder.',
      'reordered.evidence.json',
    );
    await release();
    release = null;
    project = await openProject(projectPath);
    // Maintenance only, after editor exit: evict derived results via the existing cache API.
    for (const budget of [64, 128, 256].map((kib) => kib * 1024)) {
      const operation = { operation: 'compactEngineStorage', args: { force: true, budget } };
      manifest.operations.push(operation);
      try {
        operation.result = await compactEngineStorage(project, operation.args);
        break;
      } catch (error) {
        operation.failure = error.message;
        if (error.code !== 'ENGINE_STORAGE_REQUIRED' || budget === 256 * 1024) throw error;
      }
    }
    const compactedRuns = await listEngineRuns(project);
    const evicted = compactedRuns.filter((r) => !r.resultRef).length;
    const compoundEvicted = compactedRuns.some(
      (r) => r.questions?.[0]?.text === language.compound && !r.resultRef,
    );
    release = await acquireEngineRunLease(project, randomUUID());
    let rebuilt, rebuiltAnswer;
    await capture('04-cache-rebuild', async (api) => {
      rebuiltAnswer = await api.ask(language.compound, 'compound-rebuilt');
      rebuilt = await snapshot('rebuilt');
    });
    const rebuildCheck = check(
      'cache-rebuild',
      'Evicted result rebuild preserves compound identities',
      Boolean(
        compoundEvicted &&
        rebuiltAnswer?.run?.resultRef &&
        reloaded &&
        rebuilt &&
        equal(identity(reloaded), identity(rebuilt)),
      ),
      `${evicted} saved results evicted; compound evicted: ${compoundEvicted}; compared persisted identities after a fresh editor check.`,
      'rebuilt.evidence.json',
    );
    const contextProject = await openProject(contextPath);
    const compound = contextProject.data.contributions.find(
      (entry) => entry.id === compoundContributionId,
    );
    const revised = await reviseContribution(contextProject, {
      contributionId: compound.id,
      question: language.supported,
      responses: [],
    });
    await saveProject(contextProject, revised.data);
    const contextual = await openProject(contextPath);
    const anchoredRoots = [...developedConcepts(contextual.data).byContribution.entries()]
      .filter(([id]) => contextual.data.contributions.find((entry) => entry.id === id)?.anchor)
      .flatMap(([, roots]) => roots);
    const contextNote = anchoredRoots.find((root) => root.contextNote)?.contextNote;
    await writeFile(
      join(output, 'changed-context.evidence.json'),
      json({
        revisedContribution: compound.id,
        newQuestion: language.supported,
        contextNotes: anchoredRoots.map((root) => root.contextNote).filter(Boolean),
      }),
    );
    const context = check(
      'changed-context',
      'Changed context is reported on the anchored elaboration',
      Boolean(contextNote && /no unique current attachment|withdrawn|deleted/u.test(contextNote)),
      contextNote ?? 'The anchored development was silently retargeted or lost.',
      'changed-context.evidence.json',
    );
    assign('C5', [
      manifest.checks.find((c) => c.id === 'cold-reload'),
      manifest.checks.find((c) => c.id === 'sentence-order'),
      rebuildCheck,
      context,
    ]);
  } catch (error) {
    manifest.failures.push({ message: error.message, stack: error.stack });
  } finally {
    if (release)
      await release().catch((error) => manifest.failures.push({ message: error.message }));
    if (previousEnv.options === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousEnv.options;
    if (previousEnv.pythonBytecode === undefined) delete process.env.PYTHONDONTWRITEBYTECODE;
    else process.env.PYTHONDONTWRITEBYTECODE = previousEnv.pythonBytecode;
    if (previousEnv.log === undefined) delete process.env.TENDORA_CAPTURE_NETWORK_LOG;
    else process.env.TENDORA_CAPTURE_NETWORK_LOG = previousEnv.log;
    if (before) {
      manifest.originalAfter = await treeHashes(original);
      check(
        'original-bytes',
        'Original project bytes unchanged',
        equal(before, manifest.originalAfter),
        'Compared all original paths, byte lengths and SHA-256 hashes before and after.',
      );
    }
    let attempts = [];
    try {
      attempts = (await readFile(join(output, 'network-attempts.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
    } catch (error) {
      if (error.code !== 'ENOENT') manifest.failures.push({ message: error.message });
    }
    manifest.acquisition.preventedRequests = attempts;
    check(
      'offline',
      'No live acquisition required',
      !attempts.some((a) => !a.url.endsWith('/embed/texts')) &&
        !manifest.acquisition.missing.length,
      `${attempts.length} prevented fetch requests (optional embedding attempts are reported, never sent); ${manifest.acquisition.missing.length} missing retained texts.`,
    );
    for (const criterion of manifest.criteria)
      if (criterion.status === 'blocked')
        criterion.failures = ['Not reached; see failures and session frames. This is not a pass.'];
    manifest.status = acceptanceStatus([
      ...manifest.criteria,
      ...manifest.checks,
      ...manifest.sessions,
      { status: manifest.failures.length ? 'fail' : 'pass' },
    ]);
    manifest.frameCount = manifest.sessions.reduce((n, s) => n + (s.frames ?? 0), 0);
    manifest.finishedAt = new Date().toISOString();
    await captureGallery(output, sessions);
    await save();
  }
  console.log(
    `Hand acceptance: ${manifest.status.toUpperCase()} | ${manifest.frameCount} PTY frames | ${join(output, 'manifest.json')}`,
  );
  for (const c of manifest.criteria)
    console.log(`${c.id}: ${c.status} ${c.failures?.join(' ') ?? ''}`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((a) => a.startsWith('--'))) {
    console.error(
      'Usage: HAND_CONTRACT_SOURCE=/path/to/project node tools/capture-hand-contract.mjs [tmp/new-evidence-directory] (offline only)',
    );
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = (await captureHandContract({ output: args[0] })).status === 'pass' ? 0 : 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
