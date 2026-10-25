/** Extend the bundled payments demo with the statements and questions that show
 * each capability, written through the library (their author recorded) and read
 * once through eGemma so the demo replays offline. Idempotent: what is already
 * there is kept. Afterwards run `node tools/refresh-payments-demo.mjs`.
 *
 *   node tools/extend-payments-demo.mjs [--target <project directory>]
 */
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openProject, projectTree, saveProject } from '../src/project/authoring/project.mjs';
import { sourceCatalog } from '../src/project/authoring/sources.mjs';
import { addMaterial } from '../src/engine/develop.mjs';
import {
  addAsk,
  authorCase,
  listInvestigations,
  newInvestigation,
  questionIdentity,
  saveInvestigation,
} from '../src/project/inquiries/investigation.mjs';
import { captureProjectInquiry } from '../src/project/inquiries/inquiry.mjs';
import { compactDataFiles } from '../src/project/storage/data-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: { target: { type: 'string', default: join(root, '.proj/payments-on-call') } },
});
const author = { actor: 'Claude', via: 'library' };

// Each statement, at its role, for what it shows.
const statements = [
  // A kind statement extends every deployment, one way: "Who freezes changes …?"
  ['Release Manager', 'A deployment is a change.'],
  // A negated conclusion under a condition: with the case, "Does Morgan ship a release?" is No.
  [
    'Release Manager',
    'If a major incident is open, Morgan, the release manager, does not ship a release.',
  ],
  // Two rules in two roles chain under one case: a tension line resolved.
  [
    'Security Engineer',
    'If a certificate expires, Priya, the security engineer, renews the certificate.',
  ],
  [
    'Support Lead',
    'If Priya renews the certificate, Sam, the support lead, notifies the customers.',
  ],
  // Two roles say access logs are reviewed: a tension line gathered (a yes/no
  // question each answers) and one left open ("Who …?" has two answers).
  ['On-call Engineer', 'Alex, the on-call engineer, reviews access logs after every rollback.'],
  // A question's unresolved pronoun reads as the entity it names.
  [
    'Database Administrator',
    'Jordan, the database administrator, tests a backup before restoring it.',
  ],
];
// Each question: [role asked at, question, case]. What each shows is in docs/demo.md.
const questions = [
  ['Incident Commander', 'Who freezes changes during a major incident?'],
  ['Incident Commander', 'Does Morgan ship a release?', 'A major incident is open.'],
  ['Incident Commander', 'Who renews the certificate?', 'A certificate expires.'],
  ['Incident Commander', 'Who notifies the customers?', 'A certificate expires.'],
  ['Incident Commander', 'Who notifies the customers?'],
  ['Incident Commander', 'Does Jordan test a backup before restoring it?'],
  ['Incident Commander', 'Who should rotate a leaked payment key?'],
  ['Incident Commander', 'Who may fail over the primary database?'],
  ['Incident Commander', 'Who may approve a rollback of the payments service?'],
  ['Incident Commander', 'Who pays the database vendor?'],
  ['Incident Commander', 'Which engineer acknowledges every page within ten minutes?'],
  ['Incident Commander', 'Are access logs reviewed?'],
  ['Incident Commander', 'Who reviews access logs?'],
  ['Release Manager', 'Who freezes deployments during a major incident?'],
  ['Release Manager', 'Who approves the database vendor invoice?'],
];

// Work on a copy: only the manifest and the packed material come back, as
// tools/refresh-payments-demo.mjs does with the computed results.
const target = resolve(values.target);
await mkdir(join(root, 'tmp'), { recursive: true });
const directory = await mkdtemp(join(root, 'tmp/payments-extend-'));
for (const name of ['project.json', 'material.sqlite'])
  await cp(join(target, name), join(directory, name));
let project = await openProject(directory);
const role = (name) => {
  const row = projectTree(project.data).find((item) => item.concept.name === name);
  if (!row) throw new Error(`The demo has no role ${name}`);
  return row.placement.id;
};
for (const [name, text] of statements) {
  if (sourceCatalog(project.data).some((item) => item.text === text)) continue;
  const { data } = await addMaterial(project, { text, scopePlacementId: role(name) }, author);
  project = await saveProject(project, data);
  console.log(`statement at ${name}: ${text}`);
}
const saved = new Set(
  (await listInvestigations(project)).flatMap(({ data }) =>
    data.asks.map((ask) => questionIdentity(ask.question, ask.scopePlacementId, ask.caseSelection)),
  ),
);
for (const [name, question, caseText] of questions) {
  const scopePlacementId = role(name);
  const caseSelection = caseText ? authorCase(project, caseText) : null;
  if (saved.has(questionIdentity(question, scopePlacementId, caseSelection))) continue;
  const data = addAsk(newInvestigation(project, question), {
    question,
    scopePlacementId,
    caseSelection,
    lineage: { kind: 'drafted', by: author.actor },
  });
  await saveInvestigation(project, data);
  // Read once, so the question and its case are retained for offline replay.
  const { recording } = await captureProjectInquiry(
    project,
    scopePlacementId,
    question,
    undefined,
    undefined,
    { acquireMissing: true, caseSelection },
  );
  console.log(`${recording.reasoning.status}: ${question}${caseText ? ` / ${caseText}` : ''}`);
}
await compactDataFiles(directory);
for (const name of ['project.json', 'material.sqlite']) {
  await cp(join(directory, name), join(target, name + '.tmp'));
  await rename(join(target, name + '.tmp'), join(target, name));
}
await rm(directory, { recursive: true, force: true });
console.log('Extended; now run node tools/refresh-payments-demo.mjs');
