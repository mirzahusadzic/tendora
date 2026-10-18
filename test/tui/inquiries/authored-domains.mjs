/** Author ordinary sentences through the TUI, then reopen and Ask without injected knowledge. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createWorkbench } from '../../../src/tui/shell/app.mjs';
import { createState } from '../../../src/tui/shell/state.mjs';
import { openProject } from '../../../src/project/authoring/project.mjs';
import { sourceCatalog } from '../../../src/project/authoring/sources.mjs';
import { readAcquisitions } from '../../../src/project/storage/acquisitions.mjs';
import { listEngineRuns } from '../../../src/project/storage/engine-runs.mjs';
import { currentAsk, readInvestigation } from '../../../src/project/inquiries/investigation.mjs';

// These are the only authored inputs. Every sentence and question comes from the
// existing domain corpus/test questions. This is a workflow check, not a claim of
// improved semantic coverage. Cases are independent question context, outside the corpus assertions.
const scenarios = [
  {
    name: 'Authoring routing',
    domain: 'engine',
    root: 'Customer service',
    concepts: [
      {
        sentences: [
          'Customer service answer product questions, handle billing or account issues, manage orders and returns, and provide general assistance.',
          'The issues are handled via customer tickets and routed to billing and account teams.',
        ],
      },
      {
        name: 'Teams',
        child: true,
        sentences: [
          'The billing team handles payout failures and payment processing while account team handles login and account access.',
          'Both teams offer human assistant for frequent and urgent failures',
        ],
      },
      {
        name: 'Payout failure',
        sentences: [
          'My payouts have failed three times.',
          'The bank says everything is fine.',
          'Can someone please fix this?',
        ],
      },
      { name: 'Login failure', sentences: ['My login has failed three times.'] },
    ],
    asks: [
      { question: 'Which team should handle this ticket?', case: 'Payout failure', status: 'open' },
      { question: 'Which team should handle this ticket?', case: 'Login failure', status: 'open' },
      {
        question: 'Does this ticket need urgent human attention?',
        case: 'Payout failure',
        status: 'open',
      },
    ],
  },
  {
    name: 'Authoring hand',
    domain: 'hand',
    root: 'Touchable making',
    concepts: [
      {
        name: 'Simulation',
        child: true,
        sentences: [
          'A simulation rehearses possibilities in the digital work.',
          'Rehearsed possibilities are not actual effects.',
        ],
      },
      {
        name: 'Question',
        child: true,
        sentences: ['The programmer probes the digital work with a question.'],
      },
      {
        name: 'Choice',
        child: true,
        sentences: ['The programmer makes a consequential choice.'],
      },
    ],
    asks: [
      {
        question: 'What rehearses possibilities in the digital work?',
        status: 'supported',
        answer: 'simulation',
        evidence: 'A simulation rehearses possibilities in the digital work.',
      },
      {
        question: 'Does a simulation produce actual effects?',
        status: 'open',
      },
      {
        question: 'Who probes the digital work with a question and makes a consequential choice?',
        status: 'open',
      },
    ],
  },
];
const fixture = JSON.parse(
  await readFile(new URL('../../support/qa-domain-fixtures.json', import.meta.url), 'utf8'),
);
const grammarFixture = JSON.parse(
  await readFile(new URL('../../support/qa-grammar-fixtures.json', import.meta.url), 'utf8'),
);
const routingPolicy = [
  'If my payouts fail, the billing team should handle this ticket.',
  'If my login fails, the account team should handle this ticket.',
];
const handPolicy = [
  'If a simulation rehearses possibilities in digital work, it supports exploration.',
  'If a simulation supports exploration, the simulation helps the programmer.',
];
scenarios.push(
  {
    ...structuredClone(scenarios[0]),
    name: 'Grammar routing',
    concepts: [
      ...structuredClone(scenarios[0].concepts),
      { name: 'Routing policy', child: true, sentences: routingPolicy },
    ],
    asks: [
      {
        question: 'Who should handle this ticket?',
        case: 'Payout failure',
        status: 'supported',
        answer: 'billing team',
        evidence: routingPolicy[0],
      },
      {
        question: 'Who should handle this ticket?',
        case: 'Login failure',
        status: 'supported',
        answer: 'account team',
        evidence: routingPolicy[1],
      },
      {
        question: 'Which team should handle this ticket?',
        case: 'Login failure',
        status: 'supported',
        answer: 'account',
        evidence: routingPolicy[1],
      },
      {
        question: 'Does this ticket need urgent human attention?',
        case: 'Payout failure',
        status: 'open',
      },
    ],
  },
  {
    ...structuredClone(scenarios[1]),
    name: 'Grammar hand',
    concepts: [
      ...structuredClone(scenarios[1].concepts),
      { name: 'Exploration policy', child: true, sentences: handPolicy },
    ],
    asks: [
      {
        question: 'What helps the programmer?',
        status: 'supported',
        answer: 'simulation',
        evidence: handPolicy[1],
      },
      { question: 'Does a simulation produce actual effects?', status: 'open' },
    ],
  },
);
// Only the parser's HTTP boundary is substituted. These PENMANs are the frozen,
// normalized acquisitions, before the fixture's separate authored corrections.
// No fixture project, prepared engine input, rule, reference or answer is injected.
const captures = new Map(fixture.graphs.map(({ text, penman }) => [text, penman]));
for (const { text, acquisition } of grammarFixture.entries) captures.set(text, acquisition.penman);
for (const scenario of scenarios) {
  const original = new Set([
    ...fixture[scenario.domain].sources.map((source) => source.text),
    ...fixture[scenario.domain].scenarios.flatMap((item) =>
      item.result.inputs.filter((source) => source.kind === 'case').map((source) => source.text),
    ),
    ...routingPolicy,
    ...handPolicy,
  ]);
  for (const concept of scenario.concepts)
    for (const text of concept.sentences) assert(original.has(text), 'Use actual authored text');
}

class Terminal extends EventEmitter {
  width = 160;
  height = 44;
  frame = '';
  fullscreen() {}
  hideCursor() {}
  grabInput() {}
  styleReset() {}
  raw(frame) {
    this.frame = frame;
  }
}
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/qa-authoring-'));
const originalFetch = globalThis.fetch;
const requests = [];
const results = [];
let app, state, term;
const config = {
  projectsHome: directory,
  preferencesPath: join(directory, '.layout'),
  noColor: true,
};
const start = async (initial) => {
  app?.dispose();
  state = createState(initial, config);
  state.projectEngineRuns = initial.project ? await listEngineRuns(initial.project) : [];
  term = new Terminal();
  app = createWorkbench({ state, config, term, onExit: () => assert.fail('Unexpected exit') });
  app.start();
};
const actions = [];
const key = async (value, isCharacter = false) => {
  actions.push(isCharacter ? { text: value } : { key: value });
  term.emit('key', value, [], { isCharacter });
  await app.idle();
  assert.equal(state.failure, '');
  assert(!state.form?.error, state.form?.error);
  assert.doesNotMatch(
    term.frame,
    /"(?:scopePlacementId|sourceRevision|queryParses|rules)"\s*:/u,
    'Authoring and Ask render text and controls, not internal JSON',
  );
};
const select = async (label) => {
  const index = (state.form?.move ?? state.workflow.developmentItems()).findIndex(
    (choice) => choice.label === label,
  );
  assert(index >= 0, 'Readable selector contains ' + label);
  await key('HOME');
  for (let i = 0; i < index; i++) await key('DOWN');
  await key('ENTER');
};
const submit = async () => {
  const form = state.form;
  await key('ENTER');
  assert(form.execution, 'A single submit runs acquisition and reasoning');
  await form.execution;
  await app.idle();
  assert(!form.error, form.error);
  assert.equal(state.mode, 'project', form.error);
  return state.ix.recording.reasoning;
};
const proof = (answer) =>
  JSON.parse(
    JSON.stringify({
      status: answer.status,
      answers: answer.answers.map(({ text, bindings, sourceIds, ruleIds }) => ({
        text,
        bindings,
        sourceIds,
        ruleIds,
      })),
    }).replace(/case-[a-f0-9]{8}-[a-f0-9-]{27}/gu, 'independent-case'),
  );
try {
  globalThis.fetch = async (url, options) => {
    assert(url.endsWith('/amr/parse-batch'), 'Only AMR acquisition may use a model');
    const { texts } = JSON.parse(options.body);
    assert(
      texts.every((text) => captures.has(text)),
      'Only exact authored text is acquired',
    );
    requests.push(texts);
    return {
      ok: true,
      json: async () =>
        texts.map((text) => ({
          penman: captures.get(text),
          decode_status: 'ok',
          model: 'frozen-domain-acquisition',
          revision: 'qa-domain-fixtures-v1',
        })),
    };
  };
  for (const scenario of scenarios) {
    const acquisitionStart = requests.length;
    await start({ mode: 'home' });
    await key('ENTER');
    await key(scenario.name, true);
    await key('ENTER');
    await key('ENTER'); // Accept the generated project directory.
    await key(scenario.root, true);
    await key('ENTER');
    const root = state.placementId;
    const corpus = scenario.concepts.filter((concept) => !concept.name || concept.child);
    const caseText = (name) =>
      scenario.concepts.find((concept) => concept.name === name)?.sentences.join(' ');
    for (const concept of corpus) {
      await key('HOME');
      if (concept.name) {
        await key(concept.child ? 'c' : 's');
        await key(concept.name, true);
        await key('ENTER');
      }
      await key('n');
      await key(concept.sentences.join('\n'), true);
      const form = state.form;
      await key('CTRL_S');
      await form.execution;
      assert(!form.error, form.error);
      while (state.focus !== 'nodes') await key('TAB');
    }
    assert(requests.length > acquisitionStart, 'Statement authoring acquires its exact readings');
    const projectPath = dirname(state.project.path);
    let project = await openProject(projectPath);
    assert.equal(project.data.knowledge, undefined);
    assert.equal(project.data.interpretationMappings, undefined);
    assert(await readAcquisitions(project));
    assert.deepEqual(
      sourceCatalog(project.data)
        .map((source) => source.text)
        .sort(),
      corpus.flatMap((concept) => concept.sentences).sort(),
      'Only the sentences entered through the editor are persisted',
    );
    for (const inquiry of scenario.asks) {
      // A fresh workbench process state reads only the saved project.
      project = await openProject(projectPath);
      await start({ mode: 'project', project, placementId: root, focus: 'nodes' });
      const actionStart = actions.length;
      await key('a');
      assert.equal(state.focus, 'reading');
      assert.deepEqual(
        state.form.fields.map((field) => field.label),
        ['Question'],
      );
      await key(inquiry.question, true);
      if (inquiry.case) {
        await key('ALT_C');
        await select('Write a case');
        await key(caseText(inquiry.case), true);
        await key('CTRL_S');
        assert.equal(state.placementId, root);
      } else assert.equal(state.form.caseSelection, null);
      const outcome = await submit();
      assert.equal(outcome.status, inquiry.status);
      if (inquiry.answer) {
        assert.equal(outcome.answer.answers[0].text, inquiry.answer);
        assert(outcome.answer.sources.some((source) => source.text === inquiry.evidence));
        assert(outcome.answer.answers[0].bindings.length);
        assert(outcome.answer.answers[0].derivation, 'The answer is produced by the grammar chart');
      } else assert(outcome.openings.length, 'Unsupported inquiries retain their missing links');
      assert.equal(state.ix.recording.knowledge.entries.length, 0);
      assert.deepEqual(
        ['rules', 'parses', 'queryParses', 'bindings'].map(
          (key) => state.ix.recording.knowledge[key].length,
        ),
        [0, 0, 0, 0],
      );
      const ask = currentAsk(
        (await readInvestigation(project, state.ix.recording.ask.investigationId)).data,
      );
      assert.equal(ask.question, inquiry.question);
      assert.equal(ask.scopePlacementId, root);
      assert.equal(ask.caseSelection?.label, caseText(inquiry.case));
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          'src/cli/engine.mjs',
          'ask',
          '--project',
          projectPath,
          '--scope',
          '/' + scenario.root,
          '--question',
          inquiry.question,
          '--offline',
          '--json',
          ...(inquiry.case ? ['--case-text', caseText(inquiry.case)] : []),
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      const cli = JSON.parse(stdout);
      assert.deepEqual(proof(cli.answer), proof(outcome.answer));
      assert.equal(cli.status, outcome.status);
      assert(!cli.calls.some((call) => call.client === 'AMR'));
      if (!inquiry.case)
        assert.equal(
          cli.answer.grammar.compilations,
          0,
          'Another process reuses the same compiled corpus grammar',
        );
      results.push({
        project: projectPath,
        question: inquiry.question,
        case: inquiry.case ?? null,
        status: outcome.status,
        proof: proof(outcome.answer),
        openings: outcome.openings,
        actions: actions.slice(actionStart),
      });
    }
    const beforeReplay = requests.length;
    const expected = results.at(-1).proof;
    await start({
      mode: 'project',
      project: await openProject(projectPath),
      placementId: root,
      focus: 'nodes',
    });
    await key('o');
    await select(
      scenario.asks.at(-1).question +
        (scenario.asks.at(-1).case ? ' / Case: ' + caseText(scenario.asks.at(-1).case) : ''),
    );
    const replay = state.workflow.current().run;
    assert.equal(
      state.workflow.current().input.caseSelection?.label,
      caseText(scenario.asks.at(-1).case),
    );
    assert.deepEqual(proof(replay.answer), expected);
    assert.equal(requests.length, beforeReplay, 'Reopened Ask reuses retained AMRs automatically');
  }
  if (process.env.KEEP_QA_PROJECTS === '1') {
    await writeFile(
      join(directory, 'verification.json'),
      JSON.stringify({ results, requests }, null, 2) + '\n',
    );
    console.log('Retained authored projects: ' + directory);
  }
  console.log(
    'ok two domains authored through TUI; twelve ordinary Asks and offline CLI agree; grounded policy chains, retained grammar, saved replay; no injected knowledge or graph edits',
  );
} finally {
  globalThis.fetch = originalFetch;
  app?.dispose();
  if (process.env.KEEP_QA_PROJECTS !== '1') await rm(directory, { recursive: true, force: true });
}
