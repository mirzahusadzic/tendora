/** Capture a trimming workload from the engine: the fact store of a scaled
 * corpus base (its real columns) and the bodies of the rules inference matches
 * against it, as binary files every implementation reads.
 *
 *   node bench/lean-core/capture.mjs <copies> <out-dir> --project <dir>
 *     --question <text> [--replicate <n>]
 *
 * The project must hold a saved check of the question at its revision; that
 * check's sources are the base. They are repeated as distinct occurrences, as
 * tmp/scale.mjs does, and its base built with the bounds lifted. With
 * --replicate the store's columns are repeated n times more, the terms that
 * name occurrences (statements, nodes, literals of one occurrence) renumbered
 * for each replica and the shared vocabulary (roles, concepts) kept: a larger
 * store of the same shape, not one the engine built. The rules stay the base's.
 *
 * Files (little-endian u32):
 *   columns.bin  s, r, o, each starting on a 16 KB page (Metal wraps them
 *                without copying), n facts each
 *   rules.bin    rule count; per rule: pattern count, variable count, then
 *                three words per pattern: a term number, 0x80000000 | variable,
 *                or 0xffffffff for a constant the store does not hold
 *   meta.json    counts, offsets and provenance
 */
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const load = (path) => import(join(repo, path));
const { openProject } = await load('src/project/authoring/project.mjs');
const { listEngineRuns, readEngineArtifact } = await load('src/project/storage/engine-runs.mjs');
const { answerRecording } = await load('src/engine/answer.mjs');
const { answerBase } = await load('src/recording/answers.mjs');
const { knowledgeSnapshot } = await load('src/project/authoring/knowledge.mjs');
const { storeOf } = await load('src/amr/fact-store.mjs');

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? null : args.splice(at, 2)[1];
};
const replicas = Number(option('--replicate') ?? 1);
const projectArg = option('--project');
const question = option('--question');
const [copiesText, outDir] = args;
const copies = Number(copiesText);
if (!copies || !outDir || !projectArg || !question)
  throw new Error(
    'Usage: capture.mjs <copies> <out-dir> --project <dir> --question <text> [--replicate <n>]',
  );

const project = await openProject(resolve(projectArg));
const [run] = (await listEngineRuns(project))
  .filter(
    (r) =>
      r.resultRef &&
      r.projectDigest === project.digest &&
      r.questions[0].text === question &&
      !r.caseSelection,
  )
  .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
if (!run) throw new Error(`No saved check of "${question}" at the project's revision`);
const [input, result] = await Promise.all([
  readEngineArtifact(project, run.inputRef),
  readEngineArtifact(project, run.resultRef),
]);
const sources = result.inputs.filter((item) => item.kind !== 'question');
const asked = result.inputs.filter((item) => item.kind === 'question');
const repeated = [];
for (let c = 0; c < copies; c++)
  for (const s of sources)
    repeated.push(
      c
        ? {
            ...s,
            id: `${s.id}~${c}`,
            placementId: `${s.placementId}~${c}`,
            sentenceId: `${s.sentenceId ?? s.id}~${c}`,
          }
        : s,
    );
const recording = answerRecording(project, input, { ...result, inputs: [...repeated, ...asked] });
const snapshot = knowledgeSnapshot(project.data);
const catalog = snapshot.sourceCatalog ?? [];
const knowledge = {
  ...snapshot,
  sourceCatalog: [
    ...catalog,
    ...Array.from({ length: copies - 1 }, (_, i) =>
      catalog.map((e) => ({
        ...e,
        nodeId: `${e.nodeId}~${i + 1}`,
        sentenceId: `${e.sentenceId}~${i + 1}`,
      })),
    ).flat(),
  ],
};
const started = performance.now();
// Every bound lifted, the derivations of one fact too: each copy of a kind
// statement derives the same facts again, an alternative proof per copy.
const base = answerBase(recording, knowledge, {
  maxFacts: 1e9,
  matchLimit: 1e8,
  matchBudget: 1e10,
  maxDerivations: 1e6,
});
const baseMs = performance.now() - started;
if (!base.inference.complete) throw new Error('The base is bounded; the capture would be partial');
const store = storeOf(base.inference.facts);
const n0 = store.length,
  terms0 = store.terms.length;

// A term names an occurrence when it belongs to a statement (its id, a node,
// a literal of it): an imported passage's id contains '/s' and its number, a
// statement written in the workbench's is a contribution's.
const local = new Uint8Array(terms0);
store.terms.forEach((term, t) => {
  if (/\/s\d+|(?:^|\W)contribution:/u.test(String(term))) local[t] = 1;
});
const localCount = local.reduce((a, b) => a + b, 0);
const n = n0 * replicas;
const page = 16384,
  columnBytes = Math.ceil((n * 4) / page) * page;
const columns = [store.s.data, store.r.data, store.o.data].map((data) => data.subarray(0, n0));
// Replica j numbers its occurrence terms after every earlier replica's.
const renumber = new Uint32Array(terms0);
let next = terms0;
const remaps = [Uint32Array.from({ length: terms0 }, (_, t) => t)];
for (let j = 1; j < replicas; j++) {
  for (let t = 0; t < terms0; t++) renumber[t] = local[t] ? next++ : t;
  remaps.push(renumber.slice());
}
const termCount = next;

await mkdir(outDir, { recursive: true });
const file = await open(join(outDir, 'columns.bin'), 'w');
try {
  for (let c = 0; c < 3; c++) {
    const out = new Uint32Array(columnBytes / 4);
    for (let j = 0; j < replicas; j++) {
      const remap = remaps[j],
        column = columns[c];
      for (let f = 0; f < n0; f++) out[j * n0 + f] = remap[column[f]];
    }
    await file.write(new Uint8Array(out.buffer), 0, columnBytes, c * columnBytes);
  }
} finally {
  await file.close();
}

const variable = (term) => /^\?[A-Za-z][\w-]*$/u.test(term);
const words = [base.material.rules.length];
let patterns = 0;
for (const rule of base.material.rules) {
  const vars = new Map();
  for (const pattern of rule.when)
    for (const term of pattern) if (variable(term) && !vars.has(term)) vars.set(term, vars.size);
  words.push(rule.when.length, vars.size);
  for (const pattern of rule.when) {
    patterns++;
    for (const term of pattern) {
      if (variable(term)) words.push(0x80000000 | vars.get(term));
      else words.push(store.numbers.get(term) ?? 0xffffffff);
    }
  }
}
await writeFile(join(outDir, 'rules.bin'), new Uint8Array(Uint32Array.from(words).buffer));
const meta = {
  profile: 'lean-core-capture-v1',
  copies,
  replicas,
  facts: n,
  engineFacts: n0,
  terms: termCount,
  engineTerms: terms0,
  occurrenceTerms: localCount,
  rules: base.material.rules.length,
  patterns,
  columnBytes,
  page,
  baseMs: Math.round(baseMs),
  rounds: base.inference.rounds,
};
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(JSON.stringify(meta));
