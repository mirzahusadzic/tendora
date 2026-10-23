/** Real authored corpora, frozen acquisitions and explicit additional premises. No clients. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkAnswer } from '../../src/engine/answer.mjs';
import { authorEngineKnowledge } from '../../src/project/authoring/knowledge.mjs';
import { clauseFragments } from '../../src/amr/clause-fragments.mjs';

const fixture = JSON.parse(
  await readFile(new URL('../support/qa-domain-fixtures.json', import.meta.url), 'utf8'),
);
const load = (domain, name) => {
  const saved = fixture[domain].scenarios.find((item) => item.name === name);
  return {
    input: structuredClone(saved.input),
    result: {
      inputs: [...fixture[domain].sources, ...saved.result.inputs].map((entry) => ({
        ...structuredClone(entry),
        ...structuredClone(fixture.graphs.find((graph) => graph.text === entry.text)),
      })),
    },
  };
};
const evaluate = (domain, scenario, entry) =>
  checkAnswer(
    { data: entry ? authorEngineKnowledge(fixture[domain].data, entry) : fixture[domain].data },
    scenario.input,
    scenario.result,
  );
const state = (answer, expected, label) => assert.equal(answer.status, expected, label);
const authored = fixture.engine.routing;
const reviewed = fixture.hand.knowledge;
const fetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('Frozen reasoning must not call acquisition, embeddings or an LLM');
};
try {
  for (const { graph } of fixture.graphs) {
    const extracted = clauseFragments(graph);
    assert.deepEqual(
      new Set(extracted.fragments.flatMap((f) => f.graph.nodes.map((n) => n.id))),
      new Set(graph.nodes.map((n) => n.id)),
    );
    assert.deepEqual(
      new Set(extracted.fragments.flatMap((f) => f.graph.edges.map((e) => JSON.stringify(e)))),
      new Set(graph.edges.map((e) => JSON.stringify(e))),
    );
  }
  for (const name of ['payout', 'login', 'urgent'])
    state(
      evaluate('engine', load('engine', name)),
      'open',
      'The original corpus leaves ' + name + ' unresolved',
    );
  for (const [name, binding] of [
    ['payout', 'billing team'],
    ['login', 'account team'],
  ]) {
    const base = load('engine', name),
      answer = evaluate('engine', base, authored);
    state(answer, 'conditional', 'Routing requires the explicitly authored interpretation');
    assert.equal(answer.answers[0].text, binding);
    const policy = base.result.inputs.find((entry) =>
      entry.text.startsWith('The billing team handles'),
    );
    const evidence = base.result.inputs.find(
      (entry) => entry.kind === 'case' && entry.text.includes('failed three times'),
    );
    assert.deepEqual(new Set(answer.answers[0].sourceIds), new Set([policy.id, evidence.id]));
    assert(
      answer.answers[0].ruleIds.some((id) => id.endsWith('/project-v1')),
      'Clause projection is part of the actual answer proof',
    );
    assert(answer.answers[0].ruleIds.some((id) => id.startsWith('routing-experiment/')));
    assert(answer.answers[0].qualifications.some((text) => text.includes('ADDITIONAL PREMISES')));
    state(
      evaluate('engine', base, { ...authored, rules: [] }),
      'open',
      'A parse correction alone is not the missing routing premise',
    );
    for (const mode of ['source-removal', 'case-removal', 'role-change', 'negation', 'modality']) {
      const changed = load('engine', name);
      const current = changed.result.inputs.find((entry) => entry.id === evidence.id);
      const graph = current.graph;
      if (mode === 'source-removal')
        changed.result.inputs = changed.result.inputs.filter((entry) => entry.id !== policy.id);
      if (mode === 'case-removal')
        changed.result.inputs = changed.result.inputs.filter((entry) => entry.kind !== 'case');
      if (mode === 'role-change')
        graph.edges.find((edge) => edge.from === graph.top && edge.role === ':ARG1').role = ':ARG2';
      if (mode === 'negation') {
        graph.nodes.push({ id: 'neg', concept: '-' });
        graph.edges.push({ id: 'neg', from: graph.top, role: ':polarity', to: 'neg' });
      }
      if (mode === 'modality') {
        graph.nodes.push({ id: 'possible', concept: 'possible-01' });
        graph.edges.push({ id: 'possible', from: 'possible', role: ':ARG1', to: graph.top });
        graph.top = graph.assertionTop = 'possible';
      }
      state(evaluate('engine', changed, authored), 'open', name + ' ' + mode);
    }
    const reversed = load('engine', name);
    reversed.result.inputs.reverse();
    assert.equal(evaluate('engine', reversed, authored).answers[0].text, binding);
  }
  state(
    evaluate('engine', load('engine', 'payout'), { ...authored, parses: [] }),
    'open',
    'The payout sense correction is occurrence-specific and necessary here',
  );
  state(
    evaluate('engine', load('engine', 'login'), { ...authored, parses: [] }),
    'conditional',
    'Login does not depend on the payout sense correction',
  );
  state(
    evaluate('engine', load('engine', 'urgent'), authored),
    'open',
    'Routing does not establish urgency or a need for assistance',
  );

  const expected = {
    simulation: 'supported',
    // The question repeats the source's words, read differently; the engine
    // reads them as in the source (shared wording).
    receipt: 'supported',
    causation: 'open',
    refusal: 'supported',
    probe: 'conditional',
    choice: 'supported', // The programmer descriptor belongs to the answer participant.
    survival: 'open',
    disruption: 'open',
    'modal-positive': 'open',
    'modal-preserved': 'supported',
    'wrong-role': 'open',
    recognition: 'supported', // Shared wording: “recognizes intention”.
    authority: 'supported',
    pipeline: 'supported',
    effects: 'open',
    safety: 'open',
    shaping: 'open',
    compound: 'open',
  };
  for (const [name, status] of Object.entries(expected)) {
    const base = load('hand', name),
      answer = evaluate('hand', base);
    state(answer, status, 'Frozen hand-domain baseline: ' + name);
    assert.equal(answer.coverage.preparedOccurrences, 68);
    assert(answer.complete);
    const reversed = load('hand', name);
    reversed.result.inputs.reverse();
    state(evaluate('hand', reversed), status, 'Sentence order: ' + name);
  }
  for (const name of ['authority', 'pipeline'])
    assert.equal(evaluate('hand', load('hand', name)).answers[0].text, 'No');
  assert(
    evaluate('hand', load('hand', 'modal-positive')).openings.some(
      (opening) => opening.kind === 'assertion' && opening.state === 'unasserted',
    ),
  );
  for (const name of ['simulation', 'refusal', 'probe', 'choice']) {
    const base = load('hand', name),
      answer = evaluate('hand', base);
    const texts = new Set(
      base.result.inputs
        .filter((entry) => answer.answers[0].sourceIds.includes(entry.id))
        .map((entry) => entry.text),
    );
    for (const mode of ['role-change', 'negation', 'modality', 'remove-support']) {
      const changed = load('hand', name);
      if (mode === 'remove-support')
        changed.result.inputs = changed.result.inputs.filter((entry) => !texts.has(entry.text));
      else
        for (const entry of changed.result.inputs.filter((entry) => texts.has(entry.text))) {
          const graph = entry.graph;
          if (mode === 'role-change')
            graph.edges.find(
              (edge) => edge.from === graph.top && edge.role.startsWith(':ARG'),
            ).role = ':ARG9';
          if (mode === 'negation') {
            graph.nodes.push({ id: 'neg', concept: '-' });
            graph.edges.push({ id: 'neg', from: graph.top, role: ':polarity', to: 'neg' });
          }
          if (mode === 'modality') {
            graph.nodes.push({ id: 'possible', concept: 'possible-01' });
            graph.edges.push({ id: 'possible', from: 'possible', role: ':ARG1', to: graph.top });
            graph.top = graph.assertionTop = 'possible';
          }
        }
      state(evaluate('hand', changed), 'open', name + ' ' + mode);
    }
  }
  const compound = load('hand', 'compound');
  assert(
    evaluate('hand', compound).openings.some(
      (opening) => opening.kind === 'connection' && opening.queryNodeIds.length === 1,
    ),
  );
  const composed = evaluate('hand', compound, reviewed);
  state(
    composed,
    'conditional',
    'Both clauses plus an explicit character reference support the compound question',
  );
  assert.equal(composed.answers[0].composition.rule, 'and-introduction-v1');
  assert.equal(composed.answers[0].composition.premises.length, 2);
  assert.equal(composed.answers[0].sourceIds.length, 2);
  assert.deepEqual(composed.answers[0].bindingIds, ['hand-reviewed-reading/same-programmer']);
  state(
    evaluate('hand', compound, { ...reviewed, bindings: [] }),
    'open',
    'Removing the reference interpretation retracts the compound answer',
  );
  for (const id of composed.answers[0].sourceIds) {
    const removed = load('hand', 'compound');
    removed.result.inputs = removed.result.inputs.filter((entry) => entry.id !== id);
    state(
      evaluate('hand', removed, reviewed),
      'open',
      'Every bound source occurrence is necessary',
    );
  }
  const causation = evaluate('hand', load('hand', 'causation'), reviewed);
  state(
    causation,
    'supported',
    'Correcting correlate-01 to cause-01 preserves the negative assertion',
  );
  assert.equal(causation.answers[0].text, 'No');
  assert.equal(causation.answers[0].parses[0].id, 'hand-reviewed-reading/causation-sense');
  state(evaluate('hand', load('hand', 'causation'), { ...reviewed, parses: [] }), 'open');
  const survival = evaluate('hand', load('hand', 'survival'), reviewed);
  state(survival, 'conditional');
  assert.equal(survival.answers[0].text, 'produce-01');
  const changedQuestion = load('hand', 'survival');
  changedQuestion.result.inputs.at(-1).graph.nodes[0].concept = 'other-event';
  const stale = evaluate('hand', changedQuestion, reviewed);
  state(stale, 'open');
  assert.equal(stale.questionParses.length, 0);
  console.log(
    'ok frozen two-domain QA: 74 acquired graphs; 18 hand questions / 68 occurrences; explicit routing and character premises; role, polarity, modality, order, provenance, revision and removal controls; no model clients',
  );
} finally {
  globalThis.fetch = fetch;
}
