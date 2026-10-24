/** One language clarification teaches a retained relation to independently focused inquiries. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  addConcept,
  createProject,
  editConcept,
  openProject,
  saveProject,
} from '../../src/project/authoring/project.mjs';
import {
  addMaterial,
  readLanguage,
  reviseMaterial,
  withdrawContributionPart,
} from '../../src/engine/develop.mjs';
import { acceptClarification } from '../../src/engine/clarify.mjs';
import { runEngine } from '../../src/engine/run.mjs';
import { inputFromProject } from '../../src/engine/input.mjs';
import { acquiredTexts } from '../../src/project/storage/acquisitions.mjs';
import { contributionRules } from '../../src/project/authoring/development.mjs';
import { sourceCatalog } from '../../src/project/authoring/sources.mjs';
import { frozenParser } from '../support/development-acquisition.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/semantic-reuse-'));
const originalFetch = globalThis.fetch;
const requests = [];
let project, scope, frozenTexts, frozenReadings, requestCount;
async function start(name) {
  globalThis.fetch = frozenParser(requests);
  project = await createProject(join(directory, name), name, name);
  scope = project.data.placements[0].id;
}
async function material(text) {
  const result = await addMaterial(project, { text, scopePlacementId: scope });
  project = await saveProject(project, result.data);
  return result.contribution;
}
const readings = async () =>
  (await acquiredTexts(project, frozenTexts)).map(({ text, ref, penman }) => ({
    text,
    ref,
    penman,
  }));
async function freeze(texts) {
  frozenTexts = [...new Set(texts)];
  for (const text of frozenTexts) await readLanguage(project, text);
  frozenReadings = await readings();
  requestCount = requests.length;
  globalThis.fetch = () => {
    assert.fail('Clarification discovery, acceptance and reasoning must use retained readings');
  };
}
async function ask(question, status) {
  const result = await runEngine(project, {
    input: await inputFromProject(project, { scopePlacementId: scope, question }),
    acquireMissing: false,
    trace: false,
  });
  assert.equal(
    result.status,
    status,
    `${question}: ${result.error ?? JSON.stringify(result.openings.map(({ kind, reason, state }) => ({ kind, reason, state })))}`,
  );
  assert(!result.calls.some((call) => call.client === 'AMR'));
  return result;
}
function choose(run, answer, source) {
  const choices = (run.answer.clarifications ?? []).filter(
    (candidate) => candidate.answerLabel === answer && candidate.source.text.includes(source),
  );
  assert.equal(
    choices.length,
    1,
    'Choose a concrete source and participant using readable language: ' +
      JSON.stringify(
        (run.answer.clarifications ?? []).map((candidate) => ({
          answer: candidate.answerLabel,
          source: candidate.source.text,
        })),
      ),
  );
  const candidate = choices[0];
  assert(candidate.rule && candidate.alignment, 'The engine supplies the proposed correspondence');
  assert(candidate.source.revision && candidate.source.graphRevision);
  return candidate;
}
async function accept(candidate) {
  const before = JSON.stringify(project.data);
  const result = await acceptClarification(project, candidate);
  assert.equal(
    JSON.stringify(project.data),
    before,
    'Acceptance returns a reviewable project revision',
  );
  assert.equal(result.part.kind, 'clarification');
  assert(
    result.part.confirmation,
    'The accepted language commitment is distinguished from a candidate',
  );
  // A library call names no one: the confirmation says through what, never
  // that the author confirmed.
  assert.equal(result.part.confirmation.via, 'library');
  assert.equal(result.part.confirmation.actor, null);
  assert.doesNotMatch(result.part.confirmation.statement, /author/u);
  assert(result.part.rule && result.part.basisSources.length);
  assert.equal(
    result.contribution.responses.length,
    0,
    'An accepted interpretation invents no observation',
  );
  project = await saveProject(project, result.data);
  assert(
    contributionRules(project.data).some((rule) => rule.origin.wordingId === result.part.id),
    'The generated corpus rule is consumed by ordinary Ask',
  );
  return result;
}
function dependent(run, part) {
  assert(run.answer.answers.length);
  assert(
    run.answer.answers.every(
      (answer) => answer.derivation && answer.ruleIds.some((id) => id.includes(part.id)),
    ),
    'Transferred answers retain grammar derivations and the accepted corpus dependency',
  );
}
async function unchangedAcquisitions() {
  assert.deepEqual(
    await readings(),
    frozenReadings,
    'Raw acquisitions and their references remain unchanged',
  );
  assert.equal(requests.length, requestCount, 'No additional model calls explain the gain');
}

try {
  await start('workshop');
  const workshop = await material('Sam repairs bicycles.');
  const workshopQueries = [
    'Who repairs bikes?',
    'Does Sam repair bikes?',
    'What does Sam repair?',
    'Are bicycles repaired by Sam?',
    'Do bicycles repair Sam?',
    'Can Sam repair bicycles?',
    'Does Sam not repair bicycles?',
    'Does Sam repair bicycles in the workshop?',
  ];
  await freeze([...workshopQueries, 'Sam repairs bicycles.', 'The mechanic repairs bicycles.']);
  const before = await ask(workshopQueries[0], 'open');
  assert.equal(
    project.data.contributions.length,
    1,
    'Merely asking does not author a correspondence',
  );
  const selected = choose(before, 'Sam', 'Sam repairs bicycles.');
  const accepted = await accept(selected);
  await ask(workshopQueries[0], 'supported');
  const heldOut = await ask(workshopQueries[1], 'supported');
  dependent(heldOut, accepted.part);
  assert.deepEqual(
    heldOut.answer.answers.map((answer) => answer.text),
    ['Yes'],
  );
  for (const question of workshopQueries.slice(2, 4)) await ask(question, 'supported');
  for (const question of workshopQueries.slice(4)) await ask(question, 'open');
  project = await openProject(join(directory, 'workshop'));
  dependent(await ask(workshopQueries[1], 'supported'), accepted.part);
  await unchangedAcquisitions();

  // The original question and fact stay useful after withdrawing only the interpretation.
  const supportedRevision = structuredClone(project.data);
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, accepted.contribution.id, accepted.part.id),
  );
  await ask(workshopQueries[1], 'open');
  await ask(workshopQueries[2], 'supported');
  project = await saveProject(project, supportedRevision);

  // Revising the supporting language leaves the accepted record, but cannot silently rebind it.
  const changed = await reviseMaterial(project, {
    contributionId: workshop.id,
    text: 'The mechanic repairs bicycles.',
  });
  project = await saveProject(project, changed.data);
  await ask(workshopQueries[1], 'open');
  assert(
    project.data.contributions.some((c) => c.wordings.some((w) => w.id === accepted.part.id)),
    'Source revision invalidates support without deleting the author commitment',
  );
  await assert.rejects(
    async () => acceptClarification(project, selected),
    /changed|reopen|stale|unavailable|removed/iu,
    'An earlier proposal cannot be accepted after its source changes',
  );
  project = await saveProject(project, supportedRevision);
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, workshop.id, workshop.responses[0].id),
  );
  await ask(workshopQueries[1], 'open');

  // Two identical observations are independent occurrences, even when their answer labels match.
  project = await saveProject(project, {
    ...supportedRevision,
    contributions: supportedRevision.contributions.filter((c) => c.id !== accepted.contribution.id),
  });
  const duplicate = await material('Sam repairs bicycles.');
  const alternatives = (await ask(workshopQueries[0], 'open')).answer.clarifications.filter(
    (candidate) =>
      candidate.answerLabel === 'Sam' && candidate.source.text === 'Sam repairs bicycles.',
  );
  assert.equal(alternatives.length, 2);
  assert.equal(new Set(alternatives.map((candidate) => candidate.source.sentenceId)).size, 2);
  assert.equal(new Set(alternatives.map((candidate) => candidate.id)).size, 2);
  const originalChoice = alternatives.find((candidate) =>
    candidate.source.sentenceId.includes(workshop.responses[0].id),
  );
  assert(originalChoice);
  await accept(originalChoice);
  await ask(workshopQueries[1], 'supported');
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, workshop.id, workshop.responses[0].id),
  );
  await ask(workshopQueries[1], 'open');
  assert(!project.data.contributions.find((c) => c.id === duplicate.id).responses[0].withdrawn);
  await ask(workshopQueries[2], 'supported');
  await unchangedAcquisitions();

  await start('simulation');
  const simulationText = 'A simulation rehearses possibilities in the digital work.';
  const exploreText =
    'If a simulation rehearses possibilities in digital work, it supports exploration.';
  const helpText = 'If a simulation supports exploration, the simulation helps the programmer.';
  const simulation = await material(simulationText);
  await material(exploreText);
  const helping = await material(helpText);
  const simulationQueries = [
    'Who is helped by a simulation?',
    'Does a simulation help the programmer?',
    'Who does a simulation help?',
    'What helps the programmer?',
    'What rehearses possibilities in digital work and helps the programmer?',
    'What rehearses possibilities in the digital work?',
  ];
  await freeze([...simulationQueries, simulationText, exploreText, helpText]);
  const passive = await ask(simulationQueries[0], 'open');
  await ask(simulationQueries[2], 'supported');
  const clarification = await accept(choose(passive, 'programmer', helpText));
  assert.deepEqual(
    (await ask(simulationQueries[0], 'supported')).answer.answers.map((answer) => answer.text),
    ['programmer'],
  );
  dependent(await ask(simulationQueries[1], 'supported'), clarification.part);
  await ask(simulationQueries[4], 'supported');
  project = await openProject(join(directory, 'simulation'));
  dependent(await ask(simulationQueries[1], 'supported'), clarification.part);
  await unchangedAcquisitions();

  const interpretedRevision = structuredClone(project.data);
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, clarification.contribution.id, clarification.part.id),
  );
  await ask(simulationQueries[1], 'open');
  await ask(simulationQueries[3], 'supported');
  project = await saveProject(project, interpretedRevision);
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, simulation.id, simulation.responses[0].id),
  );
  await ask(simulationQueries[0], 'open');
  await ask(simulationQueries[1], 'open');
  await ask(simulationQueries[3], 'open');
  project = await saveProject(project, interpretedRevision);
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, helping.id, helping.responses[0].id),
  );
  await ask(simulationQueries[1], 'open');
  await ask(simulationQueries[5], 'supported');
  await unchangedAcquisitions();

  // Existing passage-based projects use the same engine path, without rebuilding their corpus.
  await start('passages');
  const root = scope;
  const left = addConcept(project.data, root, 'Workshop');
  project = await saveProject(project, left.data);
  const right = addConcept(project.data, root, 'Elsewhere');
  project = await saveProject(project, right.data);
  const passage = async (placementId, text) => {
    const conceptId = project.data.placements.find((p) => p.id === placementId).conceptId;
    const concept = project.data.concepts.find((c) => c.id === conceptId);
    project = await saveProject(
      project,
      editConcept(project.data, conceptId, concept.name, text ? [text] : []),
    );
  };
  await passage(left.placementId, 'Sam repairs bicycles.');
  await passage(right.placementId, 'Sam repairs bicycles.');
  assert.equal(project.data.contributions?.length ?? 0, 0);
  scope = left.placementId;
  await freeze([
    'Who repairs bikes?',
    'Does Sam repair bikes?',
    'Sam repairs bicycles.',
    'The mechanic repairs bicycles.',
  ]);
  const passageRun = await ask('Who repairs bikes?', 'open');
  const passageChoice = choose(passageRun, 'Sam', 'Sam repairs bicycles.');
  assert(!passageChoice.source.sentenceId.startsWith('contribution:'));
  const passageClarification = await accept(passageChoice);
  dependent(await ask('Does Sam repair bikes?', 'supported'), passageClarification.part);
  scope = right.placementId;
  await ask('Does Sam repair bikes?', 'open');
  scope = root;
  dependent(await ask('Does Sam repair bikes?', 'supported'), passageClarification.part);
  project = await openProject(join(directory, 'passages'));
  dependent(await ask('Does Sam repair bikes?', 'supported'), passageClarification.part);
  scope = left.placementId;
  await passage(left.placementId, 'The mechanic repairs bicycles.');
  const currentSource = sourceCatalog(project.data).find(
    (source) =>
      source.nodeId === left.placementId && source.text === 'The mechanic repairs bicycles.',
  );
  assert.equal(currentSource.sentenceId, passageChoice.source.sentenceId);
  assert.notEqual(currentSource.revision, passageChoice.source.revision);
  await ask('Does Sam repair bikes?', 'open');
  scope = root;
  await ask('Does Sam repair bikes?', 'open');
  assert(
    project.data.contributions.some((c) =>
      c.wordings.some((w) => w.id === passageClarification.part.id),
    ),
  );
  await unchangedAcquisitions();
  console.log(
    'ok automatic language clarifications transfer to held-out question focus in two domains and existing passages; retained corpus rules, conditional witnesses, occurrence and scope boundaries, revision, withdrawal, reload and offline reasoning',
  );
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
