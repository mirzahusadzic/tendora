/** A saved question is its text, its scope and its case, and a case is the
 * situation it states: asked again with the same statements under a new case
 * identifier, or with stray spaces, it is the same question in the ask layer,
 * the opportunity tree and recoil (review 2026-10-25, #8). */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createProject, editConcept, saveProject } from '../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import { authorCase, listInvestigations } from '../../src/project/inquiries/investigation.mjs';
import { requestProjectInquiry } from '../../src/project/inquiries/ask-run.mjs';
import { opportunityTree } from '../../src/project/inquiries/juxtaposition.mjs';
import { recoil } from '../../src/project/inquiries/recoil.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/question-identity-'));
const fetch = globalThis.fetch;
globalThis.fetch = () => assert.fail('Questions are checked from retained readings only');
try {
  const statement = 'The gate opens when the lift is inspected.',
    situation = 'The lift is inspected.',
    question = 'Does the gate open?';
  let project = await createProject(resolve(directory, 'project'), 'Identity', 'Root');
  project = await saveProject(
    project,
    editConcept(project.data, project.data.concepts[0].id, 'Root', [statement]),
  );
  await retainAcquisitions(
    project,
    [
      [statement, '(o / open-01 :ARG1 (g / gate) :time (i / inspect-01 :ARG1 (l / lift)))'],
      [situation, '(i / inspect-01 :ARG1 (l / lift))'],
      [question, '(o / open-01 :polarity (u / amr-unknown) :ARG1 (g / gate))'],
    ].map(([text, penman]) => ({ text, penman, origin: { kind: 'identity-test' } })),
  );
  const scope = project.data.placements[0].id;
  // Each authored case gets its own identifier.
  const ask = () =>
    requestProjectInquiry(project, {
      scopePlacementId: scope,
      question,
      caseSelection: authorCase(project, situation),
      acquireMissing: false,
      engineTrace: false,
    });
  await ask();
  await ask();
  const asks = (await listInvestigations(project)).flatMap(({ data }) => data.asks);
  assert.equal(asks.length, 1, 'The same situation under a new case identifier is one ask');

  // The tree and recoil read the runs the same way.
  const run = (text, placementId, minute) => ({
    id: `r${minute}`,
    questions: [{ text }],
    scopePlacementId: scope,
    purpose: 'inquiry',
    projectDigest: project.digest,
    startedAt: `2026-10-25T10:0${minute}:00Z`,
    caseSelection: { placementId, sources: [{ text: situation }] },
    answer: { answers: [], candidates: [], sources: [] },
  });
  const runs = [run(question, 'case-1', 1), run(`${question} `, 'case-2', 2)];
  const context = { data: project.data, digest: project.digest, runs };
  assert.equal((await opportunityTree(null, { context })).questions.length, 1, 'One in the tree');
  const walked = recoil(context, { kind: 'role', placementId: scope });
  assert.equal(
    walked.consequences.filter((visit) => visit.kind === 'question').length,
    1,
    'and one in recoil',
  );
  console.log('ok question identity: a case is the situation it states, on every surface');
} finally {
  globalThis.fetch = fetch;
  await rm(directory, { recursive: true, force: true });
}
