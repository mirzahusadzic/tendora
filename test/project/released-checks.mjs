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
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openProject } from '../../src/project/authoring/project.mjs';
import {
  listEngineRuns,
  readEngineArtifact,
  saveEngineRun,
} from '../../src/project/storage/engine-runs.mjs';
import { recordedAuthors } from '../../src/project/authoring/provenance.mjs';
import { compactEngineStorage } from '../../src/project/inquiries/engine-storage.mjs';
import {
  artifactDatabasePath,
  openArtifactDatabase,
  storeRun,
} from '../../src/project/storage/engine-artifacts.mjs';
import { newestChecks } from '../../src/project/inquiries/investigation.mjs';
import { rootCheck } from '../../src/project/inquiries/inspection.mjs';
import { inquirySections } from '../../src/tui/engine/view.mjs';

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
    // A listing's JSON holds every check: more than the default megabyte.
    maxBuffer: 256 * 1024 * 1024,
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
// Each candidate statement says who wrote it, as recorded, by its own source:
// swapped or flattened authors fail (recheck of the v0.2.0 review, tests).
const recorded = recordedAuthors((await openProject(copy)).data);
const sourceText = new Map(ambiguous.answer.sources.map((source) => [source.id, source.text]));
for (const entry of ambiguous.provenance.candidates) {
  assert.equal(entry.text, sourceText.get(entry.sourceId), 'its own statement');
  assert.equal(entry.author, recorded.get(entry.sourceId)?.author ?? 'unrecorded', entry.text);
}
assert(new Set(ambiguous.provenance.candidates.map(({ sourceId }) => sourceId)).size > 1);

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
// Nor any other question's (recheck of the v0.2.0 review, tests): another
// question asked again offline answers as it did.
const rootId = project.data.placements.find((placement) => placement.parentId === null).id;
const other = runs.find(
  (run) =>
    run.questions[0].text !== invoice &&
    run.scopePlacementId === rootId &&
    !run.case &&
    (run.answer ?? run.lastAnswer)?.status === 'supported',
);
assert(other, 'another supported question at the root');
assert.equal(
  json('ask', '--project', copy, '--question', other.questions[0].text, '--offline').value.status,
  'supported',
  other.questions[0].text,
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

// Two askings of one case are one question (recheck of the v0.2.0 review,
// #1): each asking gives the case its own placement, yet compaction, like
// every inspection, knows the case by what it states. It keeps the newer
// whole, and the older is no second question.
const again = join(directory, 'again');
execFileSync(process.execPath, ['tools/payments-demo.mjs', '--target', again], { stdio: 'pipe' });
const askCase = () =>
  json(
    'ask',
    '--project',
    again,
    '--question',
    'Who notifies the customers?',
    '--case-text',
    'A certificate expires.',
    '--offline',
  ).value;
const older = askCase(),
  newer = askCase();
assert.equal(newer.status, 'supported');
// A later asking that fails keeps no answer, and drops none: the newer
// answer stays beside it.
const againProvenance = join(again, 'provenance.json');
await writeFile(againProvenance, JSON.stringify({ version: 1, statements: [{ text: 1 }] }));
const broken = askCase();
await unlink(againProvenance);
assert.equal(broken.status, 'failed');
const againProject = await openProject(again);
await compactEngineStorage(againProject, { force: true });
const againRuns = await listEngineRuns(againProject);
assert.notEqual(
  older.caseSelection.placementId,
  newer.caseSelection.placementId,
  'two placements, one case',
);
assert(
  !againRuns.find((run) => run.id === older.id)?.answer,
  'the older is no second question kept whole',
);
assert(againRuns.find((run) => run.id === newer.id).answer, 'the newer kept whole');
assert(
  againRuns.some((run) => run.id === broken.id),
  'the failed asking kept too',
);
const purposes = ['inquiry', 'question-refresh'];
const newest = newestChecks(againRuns, { digest: againProject.digest, purposes });
assert(newest.runs.some((run) => run.id === newer.id));
assert(!newest.runs.some((run) => run.id === older.id));
// A newest check released while an older one is whole: the question counts
// as released and the older is not read in its place.
const full = againRuns.find((run) => run.id === newer.id);
const swapped = [
  { ...full, id: 'older-full', startedAt: '2026-01-01T00:00:00.000Z' },
  {
    ...full,
    id: 'newer-released',
    startedAt: '2026-01-02T00:00:00.000Z',
    answer: undefined,
    cache: 'recheck',
    caseSelection: { ...full.caseSelection, placementId: 'case-elsewhere' },
  },
];
assert.deepEqual(newestChecks(swapped, { digest: againProject.digest, purposes }), {
  runs: [],
  released: 1,
});

// A check that fails after reaching its answer gives none: no answer in its
// JSON, no "Answer:" in words (recheck of the v0.2.0 review, #4).
assert.equal(broken.answer, undefined, 'a failed check holds no answer');
const brokenText = tendora('show', '--project', again, '--run', broken.id.slice(0, 8));
assert.equal(brokenText.status, 0, brokenText.stderr);
assert.doesNotMatch(brokenText.stdout, /^Answer: /mu);
// One saved before that, still holding its answer and no provenance field at
// all: neither shown as answered nor given provenance read from the project
// as it is now (#3, #4).
const legacy = { ...againRuns.find((run) => run.id === broken.id) };
legacy.id = '00000000-0000-4000-8000-0000000000aa';
legacy.answer = full.answer;
delete legacy.provenance;
await saveEngineRun(againProject, legacy);
await writeFile(againProvenance, JSON.stringify({ version: 1, statements: [] }));
const legacyJson = json('show', '--project', again, '--run', legacy.id);
await unlink(againProvenance);
assert.equal(legacyJson.value.status, 'failed');
assert.equal(legacyJson.value.answer, undefined, 'no answer exported for a failed check');
assert.equal(legacyJson.value.provenance, null, 'no provenance read now');
assert.match(legacyJson.value.provenanceNotKept, /ended failed before it kept/u);
const legacyText = tendora('show', '--project', again, '--run', legacy.id.slice(0, 8));
assert.doesNotMatch(legacyText.stdout, /^Answer: /mu);

// The failed check saved holding its answer serves none anywhere: not in a
// listing, not as a question's newest answer, not in the workbench (fourth
// review, #2).
const servedRuns = await listEngineRuns(againProject);
const servedLegacy = servedRuns.find((run) => run.id === legacy.id);
assert.equal(servedLegacy.answer, undefined, 'a listed failed check holds no answer');
const servedNewest = newestChecks(servedRuns, { digest: againProject.digest, purposes });
assert(
  servedNewest.runs.some((run) => run.id === newer.id),
  'the answer before it stands',
);
assert(!servedNewest.runs.some((run) => run.id === legacy.id));
const legacyRows = inquirySections(
  servedLegacy,
  await readEngineArtifact(againProject, servedLegacy.inputRef),
  servedLegacy.resultRef ? await readEngineArtifact(againProject, servedLegacy.resultRef) : null,
).find((section) => section.label === 'Result').rows;
assert(!legacyRows.some((row) => row[0] === 'Answer'), 'the workbench shows no answer');
// A check saved with its case's text alone (before runs kept the selection)
// is known by that case: recoil finds it there, and it is never the root
// check without a case (fourth review, #3).
const caseOnly = {
  ...full,
  id: '00000000-0000-4000-8000-0000000000cc',
  startedAt: new Date(Date.now() + 60_000).toISOString(),
  case: 'A payment key leaks.',
};
delete caseOnly.caseSelection;
await saveEngineRun(againProject, caseOnly);
const recoiled = tendora(
  'recoil',
  '--project',
  again,
  '--question',
  'Who notifies the customers?',
  '--case-text',
  'A payment key leaks.',
);
assert.equal(recoiled.status, 0, recoiled.stderr);
assert.match(recoiled.stdout, /Case: A payment key leaks\./u);
assert.deepEqual(
  (await rootCheck(await openProject(again))).input.cases,
  [],
  'the root check has no case',
);

// A saved check whose bytes are intact but which is no check (no calls), or
// which holds another check under its key, is left out of a listing too,
// named, and kept as it is; reading it fails (recheck of the v0.2.0 review,
// #2).
const others = (await listEngineRuns(againProject)).filter(
  (run) => ![newer.id, broken.id, legacy.id, caseOnly.id].includes(run.id),
);
const [callless, moved] = others;
const movedKey = 'bbbbbbbb-0000-4000-8000-000000000000';
const againStore = openArtifactDatabase(artifactDatabasePath(againProject));
storeRun(againStore, { ...callless, calls: undefined });
againStore.prepare('UPDATE runs SET id = ? WHERE id = ?').run(movedKey, moved.id);
againStore.close();
const againListed = tendora('runs', '--project', again);
assert.equal(againListed.status, 0, againListed.stderr);
for (const id of [callless.id, movedKey]) {
  assert.doesNotMatch(againListed.stdout, new RegExp(id.slice(0, 8), 'u'));
  assert.match(againListed.stderr, new RegExp(`saved check ${id.slice(0, 8)} is damaged`, 'u'));
}
assert.match(againListed.stdout, new RegExp(newer.id.slice(0, 8), 'u'));
const againJson = tendora('runs', '--project', again, '--json');
assert.equal(againJson.status, 0, againJson.stderr);
assert.equal(
  JSON.parse(againJson.stdout).some((run) => [callless.id, movedKey].includes(run.id)),
  false,
);
assert.equal(tendora('show', '--project', again, '--run', callless.id).status, 1);

console.log(
  `ok released checks: candidates keep provenance; a failed check none; ${releasedCount} released checks read back as summaries, the root check kept; one case asked twice is one question (${directory})`,
);
