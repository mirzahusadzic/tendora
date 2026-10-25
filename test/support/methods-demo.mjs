/** A copy of the bundled demo for the Socratic methods: one more role whose
 * statements contradict the release manager's rule, with the readings eGemma
 * gave them retained exactly (its guesses too: Morgan is a company in one, a
 * person in another; a text the demo already reads keeps its own reading),
 * and a new check at the root role made offline, so the methods read every
 * statement. Nothing is acquired; the copy is left in tmp/. */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  addConcept,
  editConcept,
  openProject,
  saveProject,
} from '../../src/project/authoring/project.mjs';
import { acquiredTexts, retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';

export const readings = {
  'If a major incident is open, Morgan ships a release.':
    '(z0 / ship-01 :ARG0 (z1 / company :wiki "Morgan Stanley" :name (z2 / name :op1 "Morgan")) :ARG1 (z3 / release-01) :condition (z4 / open-01 :ARG1 (z5 / incident :ARG1-of (z6 / major-02))))',
  'Morgan ships a release.':
    '(z0 / ship-01 :ARG0 (z1 / person :wiki - :name (z2 / name :op1 "Morgan")) :ARG1 (z3 / release-01))',
  'A major incident is open.': '(z0 / open-01 :ARG1 (z1 / incident :ARG1-of (z2 / major-02)))',
};

/** Theses that are not statements, read by eGemma, for elenchus. */
export const theses = {
  'A major incident is open, and Morgan ships a release.':
    '(z0 / and :op1 (z1 / open-01 :ARG1 (z2 / incident :ARG1-of (z3 / major-02))) :op2 (z4 / ship-01 :ARG0 (z5 / company :wiki "Morgan Stanley" :name (z6 / name :op1 "Morgan")) :ARG1 (z7 / release-01)))',
  'Sam is on holiday.':
    '(z0 / holiday-01 :ARG0 (z1 / person :wiki "Kim Dae-jung" :name (z2 / name :op1 "Sam")))',
};

const noNetwork =
  'data:text/javascript,' +
  encodeURIComponent('globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };');

/** A demo copy under tmp/ with `statements` placed in a new role (by default
 * the three above), checked at the root; returns its directory. */
export async function methodsDemo(prefix, { role = 'Release Policy', statements } = {}) {
  await mkdir('tmp', { recursive: true });
  const directory = await mkdtemp(resolve(`tmp/${prefix}-`));
  const path = join(directory, 'payments-demo');
  await cp(resolve('demo/payments-on-call'), path, { recursive: true });
  const texts = statements ?? Object.keys(readings);
  let project = await openProject(path);
  let data = project.data;
  const added = addConcept(data, data.placements.find((p) => p.parentId === null).id, role);
  const placement = added.data.placements.find((p) => p.id === added.placementId);
  data = editConcept(added.data, placement.conceptId, role, texts);
  await saveProject(project, data);
  project = await openProject(path);
  // A text the demo already reads (a case's) keeps its reading.
  const all = { ...readings, ...theses };
  const wanted = [...new Set([...texts, ...Object.keys(theses)])];
  const held = await acquiredTexts(project, wanted);
  await retainAcquisitions(
    project,
    wanted
      .filter((text, index) => held?.[index]?.status !== 'retained')
      .map((text) => ({ text, penman: all[text], origin: { kind: 'test-fixture' } })),
  );
  const asked = spawnSync(
    process.execPath,
    [
      '--import',
      noNetwork,
      'src/cli/engine.mjs',
      'ask',
      '--project',
      path,
      '--question',
      'Who freezes deployments during a major incident?',
      '--offline',
    ],
    { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  );
  if (asked.status !== 0) throw new Error(`The root check failed:\n${asked.stderr}`);
  return path;
}
