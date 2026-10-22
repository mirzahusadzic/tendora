/** Evaluate projects on independent questions, in place or on disposable copies under tmp/. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProject } from '../src/project/authoring/project.mjs';
import { sourceCatalog } from '../src/project/authoring/sources.mjs';
import { acquiredTexts, retainAcquisitions } from '../src/project/storage/acquisitions.mjs';
import { parseTexts } from '../src/models/acquisition.mjs';
import { inputFromProject } from '../src/engine/input.mjs';
import { authorCase } from '../src/project/inquiries/investigation.mjs';
import { runEngine } from '../src/engine/run.mjs';
import { checkAnswer } from '../src/engine/answer.mjs';
import { readEngineArtifact } from '../src/project/storage/engine-runs.mjs';
import { createRetainedPreparation } from './support/deterministic-reuse.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  manifest: join(root, 'test/support/current-project-benchmark.json'),
  acquisitions: join(root, 'test/support/current-project-acquisitions.json'),
  sourceRoot: join(root, '.proj'),
  engineOptions: {},
};
const flags = new Map([
  ['--manifest', 'manifest'],
  ['--acquisitions', 'acquisitions'],
  ['--source-root', 'sourceRoot'],
  ['--output', 'output'],
  ['--compare', 'compare'],
  ['--project', 'project'],
  ['--replay', 'replay'],
  ['--resume', 'resume'],
  ['--cases', 'cases'],
  ['--report', 'report'],
  ['--copy-to', 'copyTo'],
]);
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--acquire') options.acquire = true;
  else if (arg === '--deterministic-reuse') options.deterministicReuse = true;
  else if (arg === '--in-place') options.inPlace = true;
  else if (arg === '--prepare-only') options.prepareOnly = true;
  else if (arg === '--engine-options')
    options.engineOptions = { ...options.engineOptions, ...JSON.parse(process.argv[++i]) };
  else if (flags.has(arg)) options[flags.get(arg)] = process.argv[++i];
  else if (arg === '--help') {
    console.log(
      'Usage: node tools/evaluate-projects.mjs [--manifest FILE] [--copy-to tmp/DIR] [--prepare-only] [--acquire] [--acquisitions FILE] [--source-root DIR] [--output DIR] [--compare REPORT] [--replay REPORT | --resume REPORT] [--project NAME] [--engine-options JSON]\n' +
        'Projects are evaluated in place and Ask history is retained in .proj, unless --copy-to evaluates disposable copies beneath tmp/; manifest sourceDirectory entries require --copy-to. Reasoning is deterministic and runs with network forbidden. --acquire captures missing original AMRs separately before reasoning. --cases selects predeclared case IDs. Expected answers never enter the engine.',
    );
    process.exit(0);
  } else throw new Error(`Unknown argument: ${arg}`);
}
assert(
  options.engineOptions &&
    typeof options.engineOptions === 'object' &&
    !Array.isArray(options.engineOptions),
);
for (const forbidden of [
  'input',
  'clients',
  'acquireMissing',
  'semantic',
  'acquireSemantic',
  'questionAlignment',
  'semanticTimeoutMs',
])
  assert(!(forbidden in options.engineOptions), `Evaluation owns engine option ${forbidden}`);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const manifestBytes = await readFile(resolve(options.manifest));
const manifest = JSON.parse(manifestBytes);
const projects = manifest.projects
  .filter((p) => !options.project || p.name === options.project)
  .map((project) => ({
    ...project,
    cases: project.cases.filter(
      (test) => !options.cases || options.cases.split(',').includes(test.id),
    ),
  }));
assert(projects.length, 'No benchmark projects selected');
assert(
  projects.every((project) => project.cases.length),
  'No requested cases exist in this project',
);
const replayPath = options.replay ?? options.resume;
const replay = replayPath ? JSON.parse(await readFile(resolve(replayPath), 'utf8')) : null;
if (replay) {
  assert.equal(
    replay.manifestHash,
    hash(manifestBytes),
    'Replay requires the exact frozen benchmark',
  );
}
const beneath = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'));
};
const copyRoot = options.copyTo ? resolve(options.copyTo) : null;
if (copyRoot)
  assert(
    beneath(join(root, 'tmp'), copyRoot) && copyRoot !== join(root, 'tmp'),
    'Disposable evaluation copies belong beneath tmp/',
  );
const evidenceRoot = join(root, 'evaluations/automatic-semantics');
const output = options.output
  ? resolve(options.output)
  : copyRoot
    ? join(copyRoot, 'evidence')
    : evidenceRoot;
assert(
  beneath(evidenceRoot, output) || (copyRoot && beneath(copyRoot, output)),
  'Evaluation evidence belongs under evaluations/automatic-semantics/ or the --copy-to directory',
);
await mkdir(output, { recursive: true });
const reportPath = join(
  output,
  options.report ??
    `report-${options.project ?? 'current-projects'}-${new Date().toISOString().replaceAll(':', '-')}.json`,
);
const capturePath = resolve(options.acquisitions);
let bundle = {
  version: 1,
  purpose: 'Unedited acquisition evidence; never corpus premises',
  entries: [],
};
try {
  bundle = JSON.parse(await readFile(capturePath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
assert(Array.isArray(bundle.entries), 'Acquisition bundle requires entries');
const captured = new Map(bundle.entries.map((entry) => [entry.text, entry]));
const prepared = [];
const missing = new Set();
for (const descriptor of projects) {
  const originalPath = descriptor.sourceDirectory
    ? resolve(root, descriptor.sourceDirectory)
    : resolve(
        options.sourceRoot,
        descriptor.name === 'archive' ? 'editor-archive' : descriptor.name,
      );
  let projectPath = originalPath;
  if (copyRoot) {
    // Acquisition and engine history land in the copy; the source stays byte-identical.
    projectPath = join(copyRoot, 'projects', descriptor.name);
    await mkdir(dirname(projectPath), { recursive: true });
    await cp(originalPath, projectPath, { recursive: true, errorOnExist: true, force: false });
  } else
    assert(
      originalPath.startsWith(join(root, '.proj') + '/'),
      'Evaluate actual repository projects in place, or pass --copy-to tmp/DIR',
    );
  const originalFileHash = hash(await readFile(join(originalPath, 'project.json')));
  const original = await openProject(projectPath);
  const specification = {
    ...descriptor,
    scopePlacementId:
      descriptor.scopePlacementId ?? original.data.placements.find((p) => p.parentId === null)?.id,
  };
  const project = original;
  const catalog = sourceCatalog(project.data);
  // Expected evidence validates the evaluation label; it is never sent to acquisition or reasoning.
  for (const test of specification.cases)
    for (const evidence of test.expected.evidenceAll ?? test.expected.supportedEvidence ?? [])
      assert(
        catalog.some((source) => source.text.includes(evidence)),
        `${test.id}: expected evidence is absent from the CURRENT corpus: ${evidence}`,
      );
  const inputs = await Promise.all(
    specification.cases.map((test) =>
      inputFromProject(project, {
        scopePlacementId: specification.scopePlacementId,
        question: test.question,
        caseSelection: test.case ? authorCase(project, test.case) : null,
      }),
    ),
  );
  const needed = new Set(
    inputs
      .flatMap((input) => [...input.sources, ...input.cases, input.question])
      .filter((entry) => !entry.graph)
      .map((entry) => entry.text),
  );
  const retained =
    (await acquiredTexts(project, [...needed])) ?? [...needed].map(() => ({ status: 'missing' }));
  for (let i = 0; i < retained.length; i++) {
    const text = [...needed][i];
    if (retained[i].status === 'retained') continue;
    if (!captured.has(text)) missing.add(text);
  }
  prepared.push({
    specification,
    project,
    originalPath,
    originalDigest: original.digest,
    originalFileHash,
    needed: [...needed],
    catalog: catalog.map(({ text, sentenceId, revision, nodeId }) => ({
      text,
      sentenceId,
      revision,
      nodeId,
    })),
  });
}
await writeFile(
  join(output, 'acquisition-request.json'),
  JSON.stringify(
    {
      version: 1,
      manifestHash: hash(manifestBytes),
      texts: [...missing],
      policy:
        'Acquire these exact texts only. Questions are held out from source-only paraphrase generation.',
    },
    null,
    2,
  ) + '\n',
);
console.log(`Evaluation workspace: ${output}`);
console.log(
  `${projects.length} current projects, ${projects.reduce((n, p) => n + p.cases.length, 0)} predeclared questions, ${missing.size} missing readings`,
);
if (options.prepareOnly) process.exit(0);
if (options.acquire && missing.size) {
  const texts = [...missing];
  const acquisition = await parseTexts(texts, (progress) => console.log(progress));
  const at = new Date().toISOString();
  for (let i = 0; i < texts.length; i++) {
    const result = acquisition.results[i];
    assert.equal(result.decode_status, 'ok', `Acquisition failed for ${texts[i]}`);
    assert(result.penman, `Acquisition returned no PENMAN for ${texts[i]}`);
    captured.set(texts[i], {
      text: texts[i],
      acquisition: result,
      origin: { kind: 'live-evaluation-acquisition', at, manifestHash: hash(manifestBytes) },
    });
  }
  bundle = { ...bundle, entries: [...captured.values()] };
  await mkdir(dirname(capturePath), { recursive: true });
  await writeFile(capturePath, JSON.stringify(bundle, null, 2) + '\n');
}
for (const item of prepared) {
  const retained =
    (await acquiredTexts(item.project, item.needed)) ??
    item.needed.map(() => ({ status: 'missing' }));
  const additions = item.needed.flatMap((text, i) => {
    const entry = captured.get(text);
    return retained[i].status !== 'retained' && entry
      ? [
          {
            text,
            penman: entry.acquisition?.penman ?? entry.penman,
            acquisition: entry.acquisition ?? entry,
            origin: entry.origin ?? { kind: 'retained-evaluation-acquisition', file: capturePath },
          },
        ]
      : [];
  });
  if (additions.length) await retainAcquisitions(item.project, additions);
}
const normalized = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[.!?]+$/u, '')
    .trim();
function assess(expected, run) {
  const answers = run.answer?.answers ?? [];
  const supported = ['supported', 'conditional'].includes(run.status);
  if (expected.kind === 'unknown')
    return {
      passed: run.status === 'open' && !answers.length,
      falseSupport: supported && answers.length > 0,
    };
  if (expected.kind === 'partial')
    return {
      passed: run.answer?.partial?.parts?.length ? null : false,
      falseSupport: supported && answers.some((answer) => normalized(answer.text) === 'yes'),
      supportedParts: run.answer?.partial?.parts?.length ?? 0,
      supportedEvidence: expected.supportedEvidence.every((fragment) =>
        (run.answer?.partial?.parts ?? []).some((part) =>
          part.dependencies?.some((source) => source.text?.includes(fragment)),
        ),
      ),
      locatedOpenings: (run.answer?.partial?.openings ?? []).filter((opening) => opening.anchor)
        .length,
      review:
        'Inspect retained partial proof and located gaps against the predeclared supportedEvidence/unresolved list. A bare open status is not completion.',
    };
  const textMatch =
    answers.length > 0 &&
    answers.every((answer) =>
      expected.answerExact
        ? normalized(answer.text) === normalized(expected.answerExact)
        : expected.answerIncludesAny.some((fragment) =>
            normalized(answer.text).includes(normalized(fragment)),
          ),
    );
  const evidence = (run.answer?.sources ?? []).map((source) => source.text);
  const evidenceMatch = expected.evidenceAll.every((fragment) =>
    evidence.some((text) => text.includes(fragment)),
  );
  return { passed: supported && textMatch && evidenceMatch, supported, textMatch, evidenceMatch };
}
const report = {
  version: 1,
  mode: copyRoot ? 'disposable-copy' : 'in-place',
  at: new Date().toISOString(),
  manifest: resolve(options.manifest),
  manifestHash: hash(manifestBytes),
  acquisitionBundle: capturePath,
  engineOptions: options.engineOptions,
  ...(options.deterministicReuse ? { experiment: 'deterministic-source-reuse-experiment-v1' } : {}),
  previousEvaluation: replayPath ? resolve(replayPath) : null,
  policy: manifest.policy,
  projects: prepared.map(
    ({ specification, originalPath, originalDigest, originalFileHash, catalog }) => ({
      name: specification.name,
      originalPath,
      originalDigest,
      originalFileHash,
      scopePlacementId: specification.scopePlacementId,
      sources: catalog,
    }),
  ),
  results: [],
};
report.frozenProjects = prepared.map((item) => ({
  name: item.specification.name,
  path: dirname(item.project.path),
  digest: item.project.digest,
}));
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('Frozen project evaluation cannot call any model or network service');
};
try {
  for (const item of prepared) {
    const reuse = options.deterministicReuse ? await createRetainedPreparation(item.project) : null;
    for (const test of item.specification.cases) {
      const started = performance.now();
      // A case is the question's own circumstances; it never becomes corpus evidence.
      let input = await inputFromProject(item.project, {
        scopePlacementId: item.specification.scopePlacementId,
        question: test.question,
        caseSelection: test.case ? authorCase(item.project, test.case) : null,
      });
      const retained = reuse ? await reuse(input) : null;
      if (retained) input = retained.input;
      const run = await runEngine(item.project, {
        ...options.engineOptions,
        input,
        acquireMissing: false,
        trace: false,
      });
      const result = {
        project: item.specification.name,
        id: test.id,
        question: test.question,
        ...(test.case ? { case: test.case } : {}),
        expected: test.expected,
        status: run.status,
        answers: run.answer?.answers ?? [],
        candidates: run.answer?.candidates ?? [],
        sources: run.answer?.sources ?? [],
        openings: run.openings,
        partial: run.answer?.partial ?? run.partial ?? null,
        grammar: run.answer?.grammar ?? null,
        checks: assess(test.expected, run),
        elapsedMs: Math.round(performance.now() - started),
        ...(retained ? { retainedPreparation: retained.stats } : {}),
        calls: run.calls,
        error: run.error ?? null,
        runId: run.id,
        inputRef: run.inputRef,
        resultRef: run.resultRef,
        inputDigest: hash(JSON.stringify(input)),
      };
      assert(
        !run.calls.some((call) => !['PENMAN', 'SEMCAT'].includes(call.client)),
        'Reasoning run acquired language',
      );
      report.results.push(result);
      console.log(
        `${result.project}/${test.id}: ${run.status} ${JSON.stringify(result.answers.map((answer) => answer.text))} check=${result.checks.passed}`,
      );
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    }
  }
  // These controls mutate only in-memory compiled evidence. They are never
  // language fixtures, persisted source edits or premises of the benchmark.
  report.compilerAblation = { status: 'no-complete-answer' };
  const terminals = (tree) => [
    ...(tree?.terminals ?? []),
    ...(tree?.children ?? []).flatMap(terminals),
  ];
  for (const result of report.results.filter(
    (entry) => entry.expected.kind === 'answer' && entry.checks.passed,
  )) {
    const item = prepared.find((entry) => entry.specification.name === result.project);
    const input = await readEngineArtifact(item.project, result.inputRef);
    const material = await readEngineArtifact(item.project, result.resultRef);
    const supported = material.inputs.filter((entry) =>
      result.sources.some((source) => source.id === entry.id),
    );
    if (!supported.length) continue;
    const cold = checkAnswer(item.project, input, material);
    const evidence = terminals(cold.answers[0]?.derivation?.tree);
    let production, attachment;
    for (const terminal of evidence) {
      const cache = {
        profile: cold.grammar.profile,
        grammars: structuredClone(cold.grammar.corpora),
      };
      for (const grammar of cache.grammars) delete grammar.rules[terminal.production.rule];
      const removed = checkAnswer(item.project, input, material, { grammarCache: cache });
      if (!removed.answers.length) {
        production = { terminal, status: removed.status, answers: removed.answers };
        break;
      }
    }
    for (const terminal of evidence) {
      let triple;
      try {
        triple = JSON.parse(terminal.fact);
      } catch {
        continue;
      }
      if (!triple[1].startsWith(':') || triple[1] === ':instance') continue;
      const source = supported.find(
        (entry) => triple[0].startsWith(`${entry.id}#`) && triple[2].startsWith(`${entry.id}#`),
      );
      if (!source) continue;
      const edge = source.graph.edges.find(
        (candidate) =>
          `${source.id}#${candidate.from}` === triple[0] &&
          candidate.role === triple[1] &&
          `${source.id}#${candidate.to}` === triple[2],
      );
      if (!edge) continue;
      const changed = structuredClone(material);
      const selectedEdge = changed.inputs
        .find((entry) => entry.id === source.id)
        .graph.edges.find((candidate) => candidate.id === edge.id);
      [selectedEdge.from, selectedEdge.to] = [selectedEdge.to, selectedEdge.from];
      const removed = checkAnswer(item.project, input, changed);
      if (!removed.answers.length) {
        attachment = {
          sourceId: source.id,
          sourceText: source.text,
          before: edge,
          after: selectedEdge,
          status: removed.status,
          answers: removed.answers,
        };
        break;
      }
    }
    if (production && attachment) {
      report.compilerAblation = {
        status: 'verified',
        project: result.project,
        id: result.id,
        question: result.question,
        runId: result.runId,
        baselineStatus: cold.status,
        answers: cold.answers.map(({ text, id, sourceIds }) => ({ text, id, sourceIds })),
        grammar: cold.grammar.stats,
        derivation: cold.answers[0].derivation,
        production,
        attachment,
        network: 'forbidden during all controls',
      };
      break;
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  for (const item of prepared) {
    if (copyRoot)
      assert.equal(
        hash(await readFile(join(item.originalPath, 'project.json'))),
        item.originalFileHash,
        'A disposable evaluation leaves its source project unchanged',
      );
    const current = await openProject(dirname(item.project.path));
    const currentSources = sourceCatalog(current.data).map(
      ({ text, sentenceId, revision, nodeId }) => ({ text, sentenceId, revision, nodeId }),
    );
    assert.deepEqual(
      currentSources,
      item.catalog,
      'Acquisition preserves every existing authored source',
    );
  }
}
report.summary = {
  warranted: report.results.filter((r) => r.expected.kind === 'answer').length,
  warrantedPassed: report.results.filter((r) => r.expected.kind === 'answer' && r.checks.passed)
    .length,
  unknowns: report.results.filter((r) => r.expected.kind === 'unknown').length,
  unknownsPreserved: report.results.filter((r) => r.expected.kind === 'unknown' && r.checks.passed)
    .length,
  falseSupport: report.results.filter((r) => r.checks.falseSupport).length,
  modelRequests: 0,
  partialRequiresReview: report.results.filter((r) => r.expected.kind === 'partial').length,
};
if (options.compare) {
  const before = JSON.parse(await readFile(resolve(options.compare), 'utf8'));
  assert.equal(before.manifestHash, report.manifestHash, 'Compare only the same frozen evaluation');
  for (const project of report.projects) {
    const prior = before.projects.find((entry) => entry.name === project.name);
    assert(prior, 'The baseline contains this project');
    assert.deepEqual(
      prior.sources.map((entry) => entry.text).sort(),
      project.sources.map((entry) => entry.text).sort(),
      'Compare the same authored source language',
    );
  }
  report.comparison = report.results.map((result) => {
    const previous = before.results.find((r) => r.project === result.project && r.id === result.id);
    return {
      project: result.project,
      id: result.id,
      before: previous?.checks,
      after: result.checks,
      beforeStatus: previous?.status,
      afterStatus: result.status,
    };
  });
}
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary));
console.log(`Report: ${reportPath}`);
