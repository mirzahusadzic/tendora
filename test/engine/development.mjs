/** Language-first contributions, generated corpus correspondences and retraction. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createProject,
  openProject,
  saveProject,
  addConcept,
  removeBranch,
} from '../../src/project/authoring/project.mjs';
import {
  developContribution,
  withdrawContributionPart,
  readLanguage,
  addMaterial,
  reviseMaterial,
  contributionContexts,
} from '../../src/engine/develop.mjs';
import { runEngine } from '../../src/engine/run.mjs';
import { inputFromProject } from '../../src/engine/input.mjs';
import { readEngineArtifact } from '../../src/project/storage/engine-runs.mjs';
import { checkAnswer } from '../../src/engine/answer.mjs';
import { evaluateAnswer } from '../../src/recording/answers.mjs';
import { deleteEngineRuns } from '../../src/project/inquiries/delete-engine-runs.mjs';
import { assessmentMarks, contributionContext } from '../../src/tui/concepts/meaning.mjs';
import { acceptClarification } from '../../src/engine/clarify.mjs';
import { acquiredTexts, retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import { contributionRules } from '../../src/project/authoring/development.mjs';
import { frozenParser } from '../support/development-acquisition.mjs';
import { engineSections, inquirySections } from '../../src/tui/engine/view.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/qa-development-test-'));
const originalFetch = globalThis.fetch,
  requests = [],
  results = [];
globalThis.fetch = frozenParser(requests);
let project, scope;
async function start(name) {
  project = await createProject(join(directory, name), name, name);
  scope = project.data.placements[0].id;
}
async function develop(question, answer = '', options = {}) {
  const result = await developContribution(project, {
    scopePlacementId: scope,
    question,
    answer,
    ...options,
  });
  project = await saveProject(project, result.data);
  return result.contribution;
}
async function ask(question, expected, options = {}) {
  const start = performance.now();
  const run = await runEngine(project, {
    input: await inputFromProject(project, { scopePlacementId: scope, question }),
    acquireMissing: true,
    trace: false,
    ...options,
  });
  if (expected)
    assert.equal(run.status, expected, `${question}: ${run.error ?? JSON.stringify(run.openings)}`);
  results.push({
    domain: project.data.name,
    question,
    status: run.status,
    answers: run.answer?.answers,
    openings: run.openings,
    elapsedMs: performance.now() - start,
    stages: run.stages,
    calls: run.calls,
    grammar: run.answer?.grammar,
  });
  return run;
}
const texts = (run) => run.answer.answers.map((a) => a.text);
const terminals = (tree) => [...tree.terminals, ...tree.children.flatMap(terminals)];
try {
  await start('workshop');
  const who = await develop('Who repairs bicycles?', 'Sam.');
  assert.equal(who.responses[0].composition.operation, 'answer-interface');
  assert(who.responses[0].composition.derivation);
  // Reopening a saved run must expose composed AMRs, not just raw parser strings.
  const savedRun = await ask('Who repairs bicycles?', 'supported');
  const savedInput = await readEngineArtifact(project, savedRun.inputRef);
  const snapshot = JSON.stringify(savedInput),
    acquisitionCount = requests.length;
  const sources = (at) =>
    engineSections(savedRun, savedInput, null, { Sources: at }).find(
      (section) => section.label === 'Sources',
    ).groups[0];
  const questionView = sources(0),
    answerView = sources(1);
  const amr = (view) =>
    view.rows.find(([label]) => label === 'AMR')?.[1] ??
    view.groups
      .find((g) => g.graphLines)
      ?.graphLines.map((line) => line.text)
      .join('\n') ??
    view.groups.flatMap((g) => g.rows ?? []).find(([label]) => label === 'AMR')?.[1];
  const originals = (view) => view.groups.find((g) => g.heading === 'Original language AMRs');
  assert.match(amr(questionView), /amr-unknown/u);
  const composedAmr = amr(answerView);
  assert.match(composedAmr, /repair-01/u);
  assert.match(composedAmr, /"Sam"/u);
  assert.doesNotMatch(composedAmr, /amr-unknown|Not captured/u);
  assert.deepEqual(
    originals(answerView).groups.map((group) => group.rows.map((row) => row[1])),
    [who.question.acquisition, who.responses[0].acquisition].map((a) => [a.text, a.penman]),
    'The originals remain separate from the composed answer graph',
  );
  assert.equal(originals(questionView).groups.length, 1);
  assert.equal(amr(sources(2)), who.question.acquisition.penman);
  assert.equal(requests.length, acquisitionCount, 'Inspecting saved evidence never reacquires');
  assert.equal(JSON.stringify(savedInput), snapshot, 'Inspecting leaves the saved graph untouched');
  const proofSource = savedInput.sources[1];
  assert(assessmentMarks(proofSource, savedRun.answer).size > 0);
  assert.equal(
    assessmentMarks(savedInput.sources[0], savedRun.answer).size,
    0,
    'The saved question is not evidence, even when its node IDs match the statement',
  );
  assert.equal(
    assessmentMarks({ ...proofSource, id: 'independent-source' }, savedRun.answer).size,
    0,
    'A separate occurrence cannot inherit another source’s answer proof',
  );
  assert.equal(assessmentMarks(proofSource, { answers: [] }).size, 0);
  assert.equal(contributionContext(who, who.responses[0]).label, 'Joined');
  for (const q of [
    'Are bicycles repaired by Sam?',
    'What does Sam repair?',
    'What is repaired by Sam?',
    'Which person repairs bicycles?',
  ])
    await ask(q, 'supported');
  for (const q of [
    'Do bicycles repair Sam?',
    'Can Sam repair bicycles?',
    'Does Sam not repair bicycles?',
  ])
    await ask(q, 'open');
  const where = await develop('Where does Sam repair bicycles?');
  const before = await ask('Does Sam repair bicycles in the workshop?', 'open');
  const beforeInput = await readEngineArtifact(project, before.inputRef);
  const beforeResult = await readEngineArtifact(project, before.resultRef);
  const query = beforeResult.inputs.find((item) => item.kind === 'question').graph;
  const nameEdge = query.edges.find((edge) => edge.role === ':name');
  assert(nameEdge);
  const referenceOpening = { id: nameEdge.id, state: 'unjoined', reason: 'Reference not joined' };
  const referenceView = (state) =>
    inquirySections(
      { ...before, openings: [...before.openings, { ...referenceOpening, state }] },
      beforeInput,
      beforeResult,
    ).find((section) => section.label === 'Missing');
  assert(
    !referenceView('unjoined').table.entries.some((entry) => entry.cells[0].includes(': name →')),
  );
  assert(
    referenceView('missing').table.entries.some((entry) => entry.cells[0].includes(': name →')),
    'A missing reference remains visible even when joined lexical metadata is omitted',
  );
  const aporia = before.openings.find((o) => o.contributionId === where.id);
  assert(
    aporia?.derivation,
    'A different question reaches the persistent connection through the grammar',
  );
  const filled = await develop('', 'The workshop.', { contributionId: where.id });
  for (const q of [
    'Where does Sam repair bicycles?',
    'Does Sam repair bicycles in the workshop?',
    'What does Sam repair in the workshop?',
    'Who repairs bicycles in the workshop?',
  ])
    await ask(q, 'supported');
  await develop('Who repairs bikes?', '', { contributionId: who.id, wording: true });
  const bikes = await ask('Does Sam repair bikes?', 'supported');
  assert(bikes.answer.answers[0].ruleIds.some((id) => id.includes('wording')));
  const authored = contributionRules(project.data);
  assert.equal(authored.length, 2);
  assert(authored.every((r) => r.baseOnly && r.origin.kind === 'engine-authored-corpus'));
  const boolean = await develop('Does Sam repair bicycles?');
  await assert.rejects(
    developContribution(project, {
      scopePlacementId: scope,
      contributionId: boolean.id,
      question: 'Can Sam repair bicycles?',
      wording: true,
    }),
    /negation, possibility or reported belief/u,
    'A wording declaration cannot erase a modal obligation',
  );
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, where.id, filled.responses[0].id),
  );
  const reopened = await ask('Does Sam repair bicycles in the workshop?', 'open');
  assert.equal(reopened.openings.find((o) => o.contributionId === where.id)?.id, aporia.id);
  await ask('Are bicycles repaired by Sam?', 'supported');
  // An independent duplicate source has its own graph occurrence and provenance.
  const independent = await develop('Who repairs bicycles?', 'Sam.');
  const duplicates = await ask('Who repairs bicycles?', 'ambiguous');
  assert.equal(duplicates.answer.candidates.length, 2);
  assert.notDeepEqual(
    duplicates.answer.candidates[0].bindings,
    duplicates.answer.candidates[1].bindings,
  );
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, independent.id, independent.responses[0].id),
  );
  assert.equal((await ask('Who repairs bicycles?', 'supported')).answer.answers.length, 1);
  // Source ordering and reload do not change contribution/aporia identities.
  const beforeOrder = [...texts(await ask('Does Sam repair bikes?', 'supported'))];
  const bindingBeforeOrder = (await ask('Who repairs bicycles?', 'supported')).answer.answers[0]
    .bindings;
  project = await saveProject(project, {
    ...project.data,
    contributions: [...project.data.contributions].reverse(),
  });
  project = await openProject(join(directory, 'workshop'));
  assert.deepEqual(texts(await ask('Does Sam repair bikes?', 'supported')), beforeOrder);
  assert.deepEqual(
    (await ask('Who repairs bicycles?', 'supported')).answer.answers[0].bindings,
    bindingBeforeOrder,
  );
  assert.equal(
    (await ask('Does Sam repair bicycles in the workshop?', 'open')).openings.find(
      (o) => o.contributionId === where.id,
    )?.id,
    aporia.id,
  );
  // Removing a production used by the answer removes its derivation. No fallback matcher.
  const run = await ask('Who repairs bicycles?', 'supported');
  const input = await readEngineArtifact(project, run.inputRef),
    material = await readEngineArtifact(project, run.resultRef);
  const cold = checkAnswer(project, input, material);
  const cache = { profile: cold.grammar.profile, grammars: structuredClone(cold.grammar.corpora) };
  const used = terminals(cold.answers[0].derivation.tree)[0].production.rule;
  for (const grammar of cache.grammars) delete grammar.rules[used];
  assert.equal(checkAnswer(project, input, material, { grammarCache: cache }).answers.length, 0);
  const warm = await ask('Who repairs bicycles?', 'supported', { acquireMissing: false });
  assert.equal(warm.answer.grammar.compilations, 0);
  assert(!warm.calls.some((c) => c.client === 'AMR'));
  const acquiredBefore = (
    await acquiredTexts(project, ['Who repairs bicycles?', 'The answer is Sam.'])
  ).map((a) => a.ref);
  await deleteEngineRuns(project, { all: true });
  assert.deepEqual(
    (await acquiredTexts(project, ['Who repairs bicycles?', 'The answer is Sam.'])).map(
      (a) => a.ref,
    ),
    acquiredBefore,
    'Deleting run history must preserve corpus-owned acquisitions',
  );
  await ask('Who repairs bicycles?', 'supported', { acquireMissing: false });

  await start('recognition');
  const main = await develop(
    'What does the programmer recognize in the resulting design?',
    'The programmer recognizes intention in the resulting design.',
  );
  assert.equal(main.responses[0].composition.operation, 'supporting-assertion');
  assert.deepEqual(texts(await ask(main.question.text, 'supported')), ['intention']);
  await ask('In what does the programmer recognize intention?', 'supported');
  const location = await develop('Where does the programmer recognize intention?');
  await ask(location.question.text, 'open');
  await develop('In what does the programmer recognize intention?', '', {
    contributionId: location.id,
    wording: true,
  });
  await ask(location.question.text, 'supported');
  const actor = 'Who recognizes intention in the resulting design?';
  const which = 'Which person recognizes intention in the resulting design?';
  // The question repeats its source's words, so the engine reads them as in the
  // source; a question that says more ("person") waits for an authored perspective.
  const settled = await ask(actor, 'supported');
  assert.deepEqual(texts(settled), ['programmer']);
  assert.equal(settled.answer.answers[0].readAs, 'shared-wording');
  await ask(which, 'open');
  const perspective = await develop(actor, '', {
    contributionId: main.id,
    perspective: true,
    basisResponseId: main.responses[0].id,
  });
  for (const q of [actor, which]) {
    const answer = await ask(q, 'supported');
    assert.deepEqual(texts(answer), ['programmer']);
    assert(answer.answer.answers[0].ruleIds.length);
    assert(answer.answer.sources.some((s) => s.text.startsWith('Perspective:')));
  }
  const withPerspective = project.data;
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, main.id, perspective.wordings[0].id),
  );
  await ask(which, 'open');
  assert.equal((await ask(actor, 'supported')).answer.answers[0].readAs, 'shared-wording');
  await ask(main.question.text, 'supported');
  project = await saveProject(project, withPerspective); // restore the prior authored revision
  await ask(actor, 'supported');
  for (const q of [
    'Can the programmer recognize intention in the resulting design?',
    "Does the design recognize the programmer's intention?",
    'Does Sam recognize intention in the resulting design?',
    'Who recognizes intention in the interface?',
  ])
    await ask(q, 'open');
  // New interface observation is a separate, explicit corpus premise.
  const connection = await develop('Does the programmer recognize intention in the interface?');
  const interfaceNode = connection.question.graph.nodes.find((n) => n.concept === 'interfaces');
  const child = await develop(
    'How does the design of the interface participate in recognizing intention?',
    '',
    {
      anchor: {
        contributionId: connection.id,
        partId: 'question',
        nodeId: interfaceNode.id,
        label: 'interface',
      },
    },
  );
  const anchored = await ask(child.question.text, 'open');
  assert.equal(
    anchored.openings.find((o) => o.contributionId === child.id)?.anchor.nodeId,
    interfaceNode.id,
  );
  await develop('', 'Yes', { contributionId: connection.id });
  await ask(connection.question.text, 'supported');
  await ask(child.question.text, 'open'); // recognition alone does not establish the design's participation
  // Withdrawal removes perspective-derived answers and leaves other observations.
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, main.id, main.responses[0].id),
  );
  await ask(actor, 'open');
  assert.deepEqual(texts(await ask(location.question.text, 'supported')), ['interface']);
  await ask(connection.question.text, 'supported');
  assert(
    !contributionRules(project.data).some((r) => r.origin.wordingId === perspective.wordings[0].id),
  );

  // Conditional sentences contributed as answers use the existing AMR compiler;
  // two separate contributions compose through the same shared simulation port.
  await start('simulation');
  const simulation = await develop(
    'What rehearses possibilities in the digital work?',
    'A simulation rehearses possibilities in the digital work.',
  );
  await develop(
    'What supports exploration?',
    'If a simulation rehearses possibilities in digital work, it supports exploration.',
  );
  const help = await develop(
    'What helps the programmer?',
    'If a simulation supports exploration, the simulation helps the programmer.',
  );
  for (const q of [
    'What helps the programmer?',
    'What rehearses possibilities in digital work and helps the programmer?',
  ]) {
    const answer = await ask(q, 'supported');
    assert(answer.answer.answers[0].ruleIds.length >= 2);
    assert(answer.answer.sources.some((s) => s.text.includes(simulation.responses[0].text)));
    assert(answer.answer.sources.some((s) => s.text.includes(help.responses[0].text)));
  }
  const helping = 'Does a simulation help the programmer?';
  await ask(helping, 'open'); // Acquired ARG1 differs from the source/compound ARG2.
  const recipient = await ask('Who does a simulation help?', 'supported');
  assert.deepEqual(texts(recipient), ['programmer']);
  await ask('Who is helped by a simulation?', 'open');
  const request = {
    scopePlacementId: scope,
    contributionId: help.id,
    question: 'Who is helped by a simulation?',
    perspective: true,
    basisResponseId: help.responses[0].id,
  };
  let attachment;
  await assert.rejects(developContribution(project, request), (error) => {
    assert.equal(error.code, 'ANSWER_ATTACHMENT');
    attachment = error.choices.find((c) => c.label === 'programmer');
    return Boolean(attachment);
  });
  await develop(request.question, '', { ...request, answerNodeId: attachment.id });
  assert.deepEqual(texts(await ask(request.question, 'supported')), ['programmer']);
  await ask(helping, 'supported'); // The selected recipient view supports another QPOV.
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, simulation.id, simulation.responses[0].id),
  );
  await ask('What helps the programmer?', 'open');
  await ask(helping, 'open');
  await ask(request.question, 'open');

  // Frozen real reentrancy, not identity inferred from equal concept/name labels.
  const readings = [];
  for (const t of ['Sam sees Sam.', 'Sam sees another person.', 'Who sees themselves?'])
    readings.push(await readLanguage(project, t));
  const record = (source) => ({
    inquiry: { text: readings[2].text, graphId: 'q' },
    graphs: [
      { ...source.graph, id: 's' },
      { ...readings[2].graph, id: 'q' },
    ],
    sources: [{ id: 's', graphId: 's', text: source.text, nodeId: scope }],
  });
  assert.equal(evaluateAnswer(record(readings[0])).status, 'supported');
  assert.equal(evaluateAnswer(record(readings[1])).status, 'open');
  // Altering an attachment, polarity or modality is a structural control, not authored input.
  const original = record(readings[0]);
  for (const change of [
    (g) => {
      g.edges.find((e) => e.role === ':ARG1').role = ':ARG2';
    },
    (g) => {
      g.nodes.push({ id: 'negative', concept: '-', literal: '-' });
      g.edges.push({ id: 'negative', from: g.top, role: ':polarity', to: 'negative' });
    },
    (g) => {
      g.nodes.push({ id: 'modal', concept: 'possible-01' });
      g.edges.push({ id: 'modal', from: 'modal', role: ':ARG1', to: g.top });
      g.top = g.assertionTop = 'modal';
    },
  ]) {
    const control = structuredClone(original);
    change(control.graphs[0]);
    assert.equal(evaluateAnswer(control).status, 'open');
  }

  // A branch's correspondence works from a parent inquiry and cannot use a sibling's assertion.
  await start('scopes');
  const root = scope;
  project = await saveProject(project, addConcept(project.data, root, 'Workshop').data);
  scope = project.data.placements.at(-1).id;
  const local = await develop('Who repairs bicycles?', 'Sam.');
  await develop('Who repairs bikes?', '', { contributionId: local.id, wording: true });
  scope = root;
  await ask('Does Sam repair bikes?', 'supported');
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, local.id, local.responses[0].id),
  );
  project = await saveProject(project, addConcept(project.data, root, 'Elsewhere').data);
  scope = project.data.placements.at(-1).id;
  await develop('Who repairs bicycles?', 'Sam.');
  scope = root;
  await ask('Does Sam repair bikes?', 'open');
  const removed = removeBranch(project.data, local.scopePlacementId);
  assert(!removed.data.contributions.some((c) => c.id === local.id));
  {
    // New deterministic gains use retained inputs only. These small synthetic
    // PENMANs exercise compiler semantics; the sales-channel pair below reuses
    // actual frozen acquisitions, without editing their readings.
    await start('compositional');
    const callsBefore = requests.length;
    globalThis.fetch = () => assert.fail('Compositional reasoning must use frozen inputs');
    const repairText = 'Mira repairs bicycles.',
      inspectText = 'Jo inspects tickets.',
      compoundText = 'Who repairs bikes and who inspects requests?',
      repairQuery = 'Who repairs bikes?',
      inspectQuery = 'Who inspects requests?',
      revisionText = 'Mira inspects bicycles.',
      nestedSource = 'A courier delivers an urgent ticket about the harbour.',
      nestedQuery = 'What priority and topic does the delivered request have?';
    const frozen = [
      [
        repairText,
        '(r / repair-01 :ARG0 (p / person :name (n / name :op1 "Mira")) :ARG1 (b / bicycle))',
      ],
      [
        inspectText,
        '(s / inspect-01 :ARG0 (q / person :name (n / name :op1 "Jo")) :ARG1 (t / ticket))',
      ],
      [
        compoundText,
        '(a / and :op1 (r / repair-01 :ARG0 (p / amr-unknown) :ARG1 (b / bike)) :op2 (s / inspect-01 :ARG0 (q / amr-unknown) :ARG1 (t / request)))',
      ],
      [repairQuery, '(r / repair-01 :ARG0 (p / amr-unknown) :ARG1 (b / bike))'],
      [inspectQuery, '(s / inspect-01 :ARG0 (q / amr-unknown) :ARG1 (t / request))'],
      [
        revisionText,
        '(s / inspect-01 :ARG0 (p / person :name (n / name :op1 "Mira")) :ARG1 (b / bicycle))',
      ],
      [
        nestedSource,
        '(d / deliver-01 :ARG0 (p / courier) :ARG1 (t / ticket :mod (u / urgent) :topic (h / harbour)))',
      ],
      [
        nestedQuery,
        '(d / deliver-01 :ARG0 (p / courier) :ARG1 (t / request :mod (u / amr-unknown) :topic (h / amr-unknown)))',
      ],
    ].map(([text, penman]) => ({ text, penman, origin: { kind: 'synthetic-frozen-test' } }));
    const salesSourceText = 'Tendora sells services directly to customers over the internet.',
      salesQueryText = 'Through what channel does Tendora sell services?';
    for (const [file, text] of [
      ['tendora-service-acquisitions.json', salesSourceText],
      ['current-project-acquisitions.json', salesQueryText],
    ]) {
      const capture = JSON.parse(
        await readFile(new URL('../support/' + file, import.meta.url), 'utf8'),
      ).entries.find((entry) => entry.text === text);
      assert(capture?.acquisition.penman);
      frozen.push({
        ...capture,
        penman: capture.acquisition.penman,
        origin: capture.origin ?? { kind: 'retained-acquisition-regression' },
      });
    }
    await retainAcquisitions(project, frozen);
    const material = async (text) => {
      const result = await addMaterial(
        project,
        { scopePlacementId: scope, text },
        { offline: true },
      );
      project = await saveProject(project, result.data);
      return result.contribution;
    };
    const repairs = await material(repairText);
    const inspections = await material(inspectText);
    const compoundReading = await readLanguage(project, compoundText, { offline: true });
    const exactContext = structuredClone(compoundReading.graph);
    exactContext.nodes.find((n) => n.concept === 'bike').concept = 'bicycle';
    const contexts = contributionContexts(project.data, exactContext, scope);
    assert.equal(contexts.length, 1);
    assert(contexts[0].questionNodeId && contexts[0].revision && contexts[0].derivation);
    const bothContext = structuredClone(exactContext);
    bothContext.nodes.find((n) => n.concept === 'request').concept = 'ticket';
    const multiContext = contributionContexts(
      {
        contributions: [
          { ...repairs, responses: [...repairs.responses, ...inspections.responses] },
        ],
      },
      bothContext,
      scope,
    );
    assert.equal(
      multiContext.length,
      2,
      'All supported response parts remain independently located',
    );
    assert.equal(new Set(multiContext.map((c) => c.questionNodeId)).size, 2);
    assert.equal(new Set(multiContext.map((c) => c.partId)).size, 2);
    let compoundRun = await ask(compoundText, 'open');
    assert.equal(compoundRun.answer.clarifications.length, 2);
    const firstCandidate = compoundRun.answer.clarifications.find(
      (c) => c.source.text === repairText,
    );
    let accepted = acceptClarification(project, firstCandidate);
    const firstPart = accepted.part,
      firstContribution = accepted.contribution.id;
    project = await saveProject(project, accepted.data);
    compoundRun = await ask(compoundText, 'open');
    await ask(repairQuery, 'supported');
    await ask(inspectQuery, 'open');
    accepted = acceptClarification(
      project,
      compoundRun.answer.clarifications.find((c) => c.source.text === inspectText),
    );
    const secondPart = accepted.part;
    project = await saveProject(project, accepted.data);
    const both = await ask(compoundText, 'supported');
    assert.deepEqual(both.answer.answers[0].bindings.map((b) => b.text).sort(), ['Jo', 'Mira']);
    for (const part of [firstPart, secondPart]) {
      assert(part.rule.correspondence && part.basisSources[0].revision);
      assert(both.answer.answers[0].ruleIds.some((id) => id.includes(part.id)));
    }
    // Authored revisits own their acquisitions after disposable run deletion.
    await develop(repairQuery);
    await develop(inspectQuery);
    project = await openProject(join(directory, 'compositional'));
    await ask(compoundText, 'supported');
    await ask(inspectQuery, 'supported');
    project = await saveProject(
      project,
      withdrawContributionPart(project.data, firstContribution, firstPart.id),
    );
    await ask(compoundText, 'open');
    await ask(repairQuery, 'open');
    await ask(inspectQuery, 'supported');
    const currentCandidate = (await ask(compoundText, 'open')).answer.clarifications.find(
      (c) => c.source.text === repairText,
    );
    accepted = acceptClarification(project, currentCandidate);
    project = await saveProject(project, accepted.data);
    const revised = await reviseMaterial(
      project,
      { contributionId: repairs.id, text: revisionText },
      { offline: true },
    );
    project = await saveProject(project, revised.data);
    assert.throws(() => acceptClarification(project, currentCandidate), /corpus changed/u);
    await ask(compoundText, 'open');
    await ask(inspectQuery, 'supported');

    const delivery = await material(nestedSource);
    const perspective = await develop(nestedQuery, '', {
      contributionId: delivery.id,
      perspective: true,
      basisResponseId: delivery.responses[0].id,
    });
    assert.equal(Object.keys(perspective.wordings[0].rule.correspondence.ports).length, 5);
    const nested = await ask(nestedQuery, 'supported');
    assert.deepEqual(nested.answer.answers[0].bindings.map((b) => b.text).sort(), [
      'harbour',
      'urgent',
    ]);
    assert(nested.answer.answers[0].ruleIds.some((id) => id.includes(perspective.wordings[0].id)));

    await material(salesSourceText);
    const sales = await ask(salesQueryText, 'open');
    assert.deepEqual(
      sales.answer.clarifications.map((c) => c.answerLabel),
      ['internet'],
    );
    const salesCandidate = sales.answer.clarifications[0];
    accepted = acceptClarification(project, salesCandidate);
    project = await saveProject(project, accepted.data);
    assert.deepEqual(texts(await ask(salesQueryText, 'supported')), ['internet']);
    project = await openProject(join(directory, 'compositional'));
    await deleteEngineRuns(project, { all: true });
    assert.deepEqual(texts(await ask(salesQueryText, 'supported')), ['internet']);
    project = await saveProject(
      project,
      withdrawContributionPart(project.data, accepted.contribution.id, accepted.part.id),
    );
    await ask(salesQueryText, 'open');
    assert.equal(requests.length, callsBefore);
    assert.deepEqual(
      (
        await acquiredTexts(
          project,
          frozen.map((entry) => entry.text),
        )
      ).map((entry) => entry.penman),
      frozen.map((entry) => entry.penman),
    );
    console.log(
      'ok new semantic gains: two independent compound parts, nested multi-slot perspective and frozen Tendora sales-channel confirmation; zero model calls, revision/withdrawal/rebuild controls',
    );
  }
  if (process.env.KEEP_QA_PROJECTS === '1') {
    await writeFile(
      join(directory, 'verification.json'),
      JSON.stringify({ requests, results }, null, 2) + '\n',
    );
    console.log('Retained development evidence: ' + directory);
  }
  console.log(
    'ok question-driven corpus: two domains, cross-perspective bindings, generated scoped correspondences, anchored openings, withdrawal, occurrence identity, source order, reentrancy, roles, polarity, modality, grammar ablation, reload and acquisition ownership',
  );
} finally {
  globalThis.fetch = originalFetch;
  if (process.env.KEEP_QA_PROJECTS !== '1') await rm(directory, { recursive: true, force: true });
}
