/** The trim against the engine: on a scaled Corpus P base, every rule is matched
 * by the engine's own grammar matcher over the whole store, and again over only
 * the facts the trim keeps for that rule. The trim must keep every witness of
 * every match, and the two sets of matches must be the same.
 *
 *   node bench/lean-core/check-engine.mjs <copies> [--project <dir>] [--question <text>]
 *
 * The project and question are capture.mjs's.
 */
import { join, resolve } from 'node:path';
import { buildIndex, trimFast } from './trim.mjs';

const repo = resolve(import.meta.dirname, '../..');
const load = (path) => import(join(repo, path));
const { openProject } = await load('src/project/authoring/project.mjs');
const { listEngineRuns, readEngineArtifact } = await load('src/project/storage/engine-runs.mjs');
const { answerRecording } = await load('src/engine/answer.mjs');
const { answerBase } = await load('src/recording/answers.mjs');
const { knowledgeSnapshot } = await load('src/project/authoring/knowledge.mjs');
const { storeOf } = await load('src/amr/fact-store.mjs');
const { createGrammarMatcher } = await load('src/amr/hrg-query.mjs');

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? null : args.splice(at, 2)[1];
};
const projectDir = resolve(option('--project') ?? join(repo, 'tmp/corpus-p-dream'));
const question = option('--question') ?? 'Who brings intention to the shared work?';
const copies = Number(args[0] ?? 4);
const project = await openProject(projectDir);
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
const recording = answerRecording(project, input, {
  ...result,
  inputs: [...repeated, ...result.inputs.filter((item) => item.kind === 'question')],
});
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
const base = answerBase(recording, knowledge, {
  maxFacts: 1e9,
  matchLimit: 1e8,
  matchBudget: 1e10,
});
const facts = base.inference.facts,
  store = storeOf(facts);
const VAR = 0x80000000;
const variable = (term) => /^\?[A-Za-z][\w-]*$/u.test(term);
const rules = base.material.rules.map((rule) => {
  const vars = new Map();
  for (const pattern of rule.when)
    for (const term of pattern) if (variable(term) && !vars.has(term)) vars.set(term, vars.size);
  return {
    vars: vars.size,
    patterns: rule.when.map((pattern) =>
      pattern.map((term) =>
        variable(term) ? (VAR | vars.get(term)) >>> 0 : (store.numbers.get(term) ?? 0xffffffff),
      ),
    ),
  };
});
const capture = {
  columns: [store.s.data, store.r.data, store.o.data].map((d) => d.subarray(0, store.length)),
  rules,
  facts: store.length,
  terms: store.terms.length,
};
const lists = trimFast(capture, buildIndex(capture));
const key = (match) => JSON.stringify([match.values, match.witnesses]);
let at = 0,
  matched = 0,
  witnesses = 0;
for (const rule of base.material.rules) {
  const kept = lists.slice(at, at + rule.when.length);
  at += rule.when.length;
  const full = createGrammarMatcher().match(rule.when, facts, { limit: 1e8, budget: 1e10 });
  if (!full.complete) throw new Error('A full match was bounded');
  for (const match of full.matches)
    match.witnesses.forEach((id, k) => {
      witnesses++;
      if (!kept[k].includes(store.position(id)))
        throw new Error(`Rule ${rule.id}: a witness of pattern ${k} was trimmed`);
    });
  const union = [...new Set(kept.flatMap((list) => [...list]))].sort((a, b) => a - b);
  const trimmed = createGrammarMatcher().match(
    rule.when,
    union.map((f) => facts[f]),
    { limit: 1e8, budget: 1e10 },
  );
  const a = full.matches.map(key).sort(),
    b = trimmed.matches.map(key).sort();
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`Rule ${rule.id}: matches differ over the trimmed facts`);
  if (full.matches.length) matched++;
}
console.log(
  JSON.stringify({
    copies,
    facts: store.length,
    rules: rules.length,
    rulesWithMatches: matched,
    witnesses,
    kept: lists.reduce((n, list) => n + list.length, 0),
    ok: true,
  }),
);
