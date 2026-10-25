/** What a check keeps, and what a released one still says (review of v0.2.0,
 * 2026-10-25, #4 to #6), on a copy of the demo: an ambiguous check keeps the
 * provenance of its candidates apart from its answers; a check that ends
 * before it keeps provenance exports none, never one read later; compaction
 * keeps a released check's candidates and the statements they rest on, show
 * reads them back as a summary, the inspections say what they leave out, and
 * the latest check at the root role stays whole for probes; deleting one
 * check keeps its question's reading; a damaged check is left out of a
 * listing, never rewritten. Nothing is acquired. The copy is left
 * in tmp/. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openProject } from '../../src/project/authoring/project.mjs';
import { listEngineRuns, saveEngineRun } from '../../src/project/storage/engine-runs.mjs';
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

// Compaction to a small budget releases most checks: one that holds the root
// check (with 30 statements, more than 300 KB; its recorded timings vary its
// size a little) and little else, mid-way between the two. A released ambiguous
// check keeps its candidates and the statements they rest on; show reads them
// back as a summary, never as a full check.
const project = await openProject(copy);
await compactEngineStorage(project, { force: true, budget: 344 * 1024 });
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

// Deleting one check keeps its question's reading (review #7): asked again
// offline, the question is still read, not missing a reading.
const invoice = 'Where does the database administrator keep break-glass credentials?';
const only = runs.filter((run) => run.questions[0].text === invoice);
assert.equal(only.length, 1, 'the demo checked it once');
const deleted = tendora('delete', '--project', copy, '--run', only[0].id, '--yes');
assert.equal(deleted.status, 0, deleted.stderr);
assert.equal(
  json('ask', '--project', copy, '--question', invoice, '--offline').value.status,
  'supported',
);
// While a check runs, compact leaves the saved checks alone and says so; it
// never reports them as already compact (the earlier review's partial fix).
const running = {
  ...(await listEngineRuns(project))[0],
  id: '00000000-0000-4000-8000-000000000000',
  status: 'running',
  pid: process.pid,
};
await saveEngineRun(project, running);
const busy = tendora('compact', '--project', copy);
assert.equal(busy.status, 1);
assert.doesNotMatch(busy.stdout, /Already compact/u);
assert.match(busy.stderr, /saved checks were not compacted: a check is running/u);
await saveEngineRun(project, { ...running, status: 'cancelled' });

// One damaged saved check is left out of a listing, named, and kept as it is
// (review #8); reading it fails, and so does maintenance that would rewrite it.
const damagedId = (await listEngineRuns(project)).find((run) => run.cache === 'recheck').id;
const store = new DatabaseSync(join(copy, 'engine/artifacts.sqlite'));
store.prepare("UPDATE runs SET checksum = 'damaged' WHERE id = ?").run(damagedId);
store.close();
const listed = tendora('runs', '--project', copy);
assert.equal(listed.status, 0, listed.stderr);
assert.doesNotMatch(listed.stdout, new RegExp(damagedId.slice(0, 8), 'u'));
assert.match(listed.stdout, /saved checks/u);
assert.match(
  listed.stderr,
  new RegExp(
    `^Warning: saved check ${damagedId.slice(0, 8)} is damaged .* left out and kept as it is`,
    'mu',
  ),
);
assert.equal(tendora('show', '--project', copy, '--run', damagedId).status, 1);
const compacted = tendora('compact', '--project', copy);
assert.equal(compacted.status, 1);
assert.match(compacted.stderr, new RegExp(damagedId, 'u'));
const after = new DatabaseSync(join(copy, 'engine/artifacts.sqlite'), { readOnly: true });
assert.equal(
  after.prepare('SELECT checksum FROM runs WHERE id = ?').get(damagedId).checksum,
  'damaged',
);
after.close();

console.log(
  `ok released checks: candidates keep provenance; a failed check none; ${releasedCount} released checks read back as summaries, the root check kept (${directory})`,
);
