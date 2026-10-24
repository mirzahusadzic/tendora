/** Ordinary Ask audits fresh and retained AMRs before graph reasoning. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createProject, editConcept, saveProject } from '../../src/project/authoring/project.mjs';
import { inputFromProject } from '../../src/engine/input.mjs';
import { runEngine } from '../../src/engine/run.mjs';
import { prepareInquiry } from '../../src/engine/preparation.mjs';
import { readEngineArtifact, readEngineRun } from '../../src/project/storage/engine-runs.mjs';
import { acquiredTexts } from '../../src/project/storage/acquisitions.mjs';
import { engineSections } from '../../src/tui/engine/view.mjs';
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(join(resolve('tmp'), 'lexical-audit-'));
const text = 'Interaction with the interface matters.';
const question = 'Does interaction with the interface matter?';
const penman = '(m / matter-01 :ARG1 (i / intercede-01 :ARG2 (f / interface)))';
const questionPenman =
  '(m / matter-01 :polarity (u / amr-unknown) :ARG1 (i / intercede-01 :ARG2 (f / interface)))';
let parseCalls = 0;
try {
  let project = await createProject(directory, 'Vocabulary audit', 'Interface');
  project = await saveProject(
    project,
    editConcept(project.data, project.data.concepts[0].id, 'Interface', [text]),
  );
  const ask = async () =>
    runEngine(project, {
      input: await inputFromProject(project, {
        question,
        scopePlacementId: project.data.placements[0].id,
      }),
      trace: false,
      acquireMissing: true,
      clients: {
        parse: async (texts) => {
          parseCalls++;
          return {
            versions: { amr: 'frozen-error' },
            results: texts.map((t) => ({
              model: 'frozen-error',
              revision: '1',
              decode_status: 'ok',
              penman: t === question ? questionPenman : penman,
            })),
          };
        },
      },
    });
  const run = await ask();
  assert.equal(
    run.status,
    'supported',
    'Lexical diagnostics neither license nor reject graph support',
  );
  assert.equal(run.lexicalAudit.items.length, 2);
  assert.equal(run.via, 'library', 'A run from a library call says so');
  assert.equal(run.actor, 'unrecorded', 'and names no actor it was not given');
  assert(
    run.lexicalAudit.items.every((item) =>
      item.findings.some((f) => f.predicate === 'intercede-01'),
    ),
  );
  assert(
    run.lexicalAudit.items.every((item) =>
      item.candidates.some((c) => c.predicate === 'interact-01'),
    ),
  );
  assert(
    run.stages.findIndex((s) => s.id === 'vocabulary') <
      run.stages.findIndex((s) => s.id === 'answer'),
  );
  assert.equal(run.calls.length, 2, 'Only acquisition and local PENMAN are clients');
  assert.equal(parseCalls, 1);
  const repeated = await ask();
  assert.equal(parseCalls, 1, 'Retained graphs are checked without another acquisition');
  assert.deepEqual(repeated.lexicalAudit.items, run.lexicalAudit.items);
  assert.equal(repeated.calls.length, 1);
  const stored = await readEngineRun(project, run.id);
  assert.deepEqual(stored.lexicalAudit, run.lexicalAudit);
  const result = await readEngineArtifact(project, run.resultRef);
  assert(result.inputs.every((i) => i.lexicalAudit.findings.length));
  assert(result.inputs.every((i) => i.graph.nodes.some((n) => n.concept === 'intercede-01')));
  assert.equal((await acquiredTexts(project, [text]))[0].penman, penman);
  const input = await readEngineArtifact(project, run.inputRef);
  const sections = engineSections(run, input, result);
  assert(sections.find((s) => s.label === 'Outcome').rows.some((r) => r[0] === 'AMR vocabulary'));
  const sourceRows = sections.find((s) => s.label === 'Sources').groups[0].rows;
  assert(sourceRows.some((r) => r[0] === 'Vocabulary check' && r[1].includes('intercede-01')));
  assert(sourceRows.some((r) => r[0] === 'Lexical hint' && r[1].includes('interact-01')));
  const cli = execFileSync(
    process.execPath,
    [
      'src/cli/engine.mjs',
      'ask',
      '--project',
      directory,
      '--question',
      question,
      '--offline',
      '--explain',
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert(cli.includes('AMR vocabulary:'));
  assert(cli.includes('intercede-01'));
  assert(cli.includes('interact-01'));
  assert(cli.includes('supported:'));
  // Records with the same text and reading share one audit, read once; it is
  // frozen, so an edit of one record's copy cannot change the other's.
  const twice = await prepareInquiry({
    sources: ['a', 'b'].map((id) => ({ id, kind: 'source', text, penman })),
    cases: [],
    question: { id: 'q', kind: 'question', text: question, penman: questionPenman },
  });
  const [first, second] = twice.records;
  assert.equal(first.lexicalAudit, second.lexicalAudit, 'Audited once');
  assert(Object.isFrozen(first.lexicalAudit) && Object.isFrozen(first.lexicalAudit.checks));
  assert.throws(() => {
    first.lexicalAudit.checks.push({});
  }, TypeError);
  console.log(
    'ok lexical findings retained for fresh and offline Ask, audited once per reading and frozen, visible in CLI/TUI, with unchanged source graphs and separate semantic results',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
