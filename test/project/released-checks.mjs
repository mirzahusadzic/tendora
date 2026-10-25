/** What a check keeps, and what a released one still says (review of v0.2.0,
 * 2026-10-25, #4 to #6), on a copy of the demo: an ambiguous check keeps the
 * provenance of its candidates apart from its answers; a check that ends
 * before it keeps provenance exports none, never one read later; compaction
 * keeps a released check's candidates and the statements they rest on, show
 * reads them back as a summary, the inspections say what they leave out, and
 * the latest check at the root role stays whole for probes. Nothing is
 * acquired. The copy is left in tmp/. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openProject } from '../../src/project/authoring/project.mjs';
import { listEngineRuns } from '../../src/project/storage/engine-runs.mjs';
import { compactEngineStorage } from '../../src/project/inquiries/engine-storage.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/released-checks-'));
const copy = join(directory, 'demo');
execFileSync(process.execPath, ['tools/payments-demo.mjs', '--target', copy], { stdio: 'pipe' });
const noNetwork =
  'data:text/javascript,' +
  encodeURIComponent('globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };');
const tendora = (...args) =>
  spawnSync(process.execPath, ['--import', noNetwork, 'src/cli/engine.mjs', ...args], {
    encoding: 'utf8',
  });
const json = (...args) => {
  const ran = tendora(...args, '--json');
  assert.equal(ran.stderr.includes('NETWORK_FORBIDDEN'), false);
  return { code: ran.status, value: JSON.parse(ran.stdout) };
};

// An ambiguous check names the statements behind each candidate, apart from
// its answers; no candidate becomes an answer.
const ambiguous = json(
  'ask',
  '--project',
  copy,
  '--question',
  'Who reviews access logs?',
  '--offline',
  '--actor',
  'Dana',
).value;
assert.equal(ambiguous.status, 'ambiguous');
assert.deepEqual(ambiguous.provenance.statements, []);
assert.deepEqual(
  ambiguous.provenance.candidates.map(({ text }) => text).sort(),
  ambiguous.answer.candidates
    .flatMap((candidate) => candidate.sourceIds)
    .map((id) => ambiguous.answer.sources.find((source) => source.id === id).text)
    .sort(),
);
assert(
  ambiguous.provenance.candidates.every(({ author }) => typeof author === 'string'),
  'each candidate statement says who wrote it, or that it is unrecorded',
);

// A check that fails before it keeps provenance exports none, with why; it is
// never given the provenance of a later revision.
const provenancePath = join(copy, 'provenance.json');
await writeFile(provenancePath, JSON.stringify({ version: 1, statements: [{ text: 1 }] }));
const failed = json(
  'ask',
  '--project',
  copy,
  '--question',
  'Who notifies the customers?',
  '--case-text',
  'A certificate expires.',
  '--offline',
);
assert.equal(failed.value.status, 'failed');
assert.equal(failed.value.provenance, null);
assert.match(failed.value.provenanceNotKept, /ended failed before it kept/u);
await writeFile(provenancePath, JSON.stringify({ version: 1, statements: [] }));
const shown = json('show', '--project', copy, '--run', failed.value.id).value;
assert.equal(shown.provenance, null);
assert.match(shown.provenanceNotKept, /ended failed before it kept/u);

// A later question at the root role is the latest check there: the one
// probes read.
assert.equal(
  json(
    'ask',
    '--project',
    copy,
    '--question',
    'Who freezes deployments during a major incident?',
    '--offline',
  ).value.status,
  'supported',
);

// Compaction to a small budget releases most checks. A released ambiguous
// check keeps its candidates and the statements they rest on; show reads them
// back as a summary, never as a full check.
const project = await openProject(copy);
await compactEngineStorage(project, { force: true, budget: 256 * 1024 });
const runs = await listEngineRuns(project);
const released = runs.find((run) => run.id === ambiguous.id);
assert.equal(released.cache, 'recheck');
assert.deepEqual(
  released.lastAnswer.candidates.map((candidate) => candidate.text).sort(),
  ambiguous.answer.candidates.map((candidate) => candidate.text).sort(),
);
assert(
  released.lastAnswer.candidates.every((candidate) =>
    candidate.sourceIds.every((id) => released.lastAnswer.sources.some((s) => s.id === id)),
  ),
);
const human = tendora('show', '--project', copy, '--run', ambiguous.id.slice(0, 8));
assert.equal(human.status, 0, human.stderr);
for (const candidate of ambiguous.answer.candidates)
  assert.match(human.stdout, new RegExp(`^Candidate: ${candidate.text}$`, 'mu'));
assert.match(human.stdout, /Released by compaction: its last answer is kept, not its evidence/u);
assert.doesNotMatch(human.stdout, /^Answer: /mu);
assert.equal(
  json('show', '--project', copy, '--run', ambiguous.id).value.provenance.candidates.length,
  ambiguous.provenance.candidates.length,
  'its provenance is kept with it',
);

// The inspections say how many released checks they do not read; the latest
// check at the root role stays whole, so probes still run.
const tensions = tendora('tensions', '--project', copy);
assert.equal(tensions.status, 0, tensions.stderr);
const releasedCount = new Set(
  runs.filter((run) => run.cache === 'recheck' && run.projectDigest === project.digest),
).size;
assert(releasedCount > 0);
assert.match(tensions.stdout, /released by compaction .* not read; ask them again/u);
const probe = tendora('probe', '--project', copy, '--role', 'Security Engineer');
assert.equal(probe.status, 0, probe.stderr);
assert.equal(JSON.parse(await readFile(provenancePath, 'utf8')).statements.length, 0);
console.log(
  `ok released checks: candidates keep provenance; a failed check none; ${releasedCount} released checks read back as summaries, the root check kept (${directory})`,
);
