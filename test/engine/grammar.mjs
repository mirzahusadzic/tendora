/** Frozen acquired graphs from real corpora plus ordinary authored policy sentences. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateAnswer } from '../../src/recording/answers.mjs';
const original = JSON.parse(
  await readFile(new URL('../support/qa-domain-fixtures.json', import.meta.url), 'utf8'),
);
const acquired = JSON.parse(
  await readFile(new URL('../support/qa-grammar-fixtures.json', import.meta.url), 'utf8'),
);
const texts = {
  payout: 'If my payouts fail, the billing team should handle this ticket.',
  login: 'If my login fails, the account team should handle this ticket.',
  explore: 'If a simulation rehearses possibilities in digital work, it supports exploration.',
  help: 'If a simulation supports exploration, the simulation helps the programmer.',
  routing: 'Who should handle this ticket?',
  compound: 'What rehearses possibilities in digital work and helps the programmer?',
};
const added = (text, id) => {
  const entry = acquired.entries.find((e) => e.text === text);
  assert(entry, text);
  return {
    id,
    text,
    graph: structuredClone(entry.prepared.graph),
    penman: entry.acquisition.penman,
  };
};
const sources = (domain) =>
  original[domain].sources.map((e) => ({
    ...structuredClone(e),
    ...structuredClone(original.graphs.find((g) => g.text === e.text)),
  }));
const record = (entries, question) => ({
  inquiry: { text: question.text, graphId: question.id },
  graphs: [...entries, question].map((e) => ({ ...e.graph, id: e.id })),
  amrs: [...entries, question].map((e) => ({ graphId: e.id, response: { penman: e.penman } })),
  sources: entries.map((e) => ({ ...e, graphId: e.id, nodeId: e.placementId ?? 'scope' })),
});
const mutate = (entries, predicate, fn) => {
  const copy = structuredClone(entries);
  for (const entry of copy.filter(predicate)) fn(entry.graph);
  return copy;
};
const negative = (g) => {
  g.nodes.push({ id: 'neg', concept: '-', literal: '-' });
  g.edges.push({ id: 'neg', from: g.assertionTop ?? g.top, role: ':polarity', to: 'neg' });
};
const modal = (g) => {
  g.nodes.push({ id: 'possible', concept: 'possible-01' });
  g.edges.push({ id: 'modal', from: 'possible', role: ':ARG1', to: g.assertionTop ?? g.top });
  g.top = g.assertionTop = 'possible';
};
const fetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('Grammar reasoning cannot call a model');
};
try {
  for (const name of ['payout', 'login']) {
    const scenario = original.engine.scenarios.find((s) => s.name === name);
    const cases = scenario.result.inputs
      .filter((e) => e.kind === 'case')
      .map((e) => ({
        ...structuredClone(e),
        ...structuredClone(original.graphs.find((g) => g.text === e.text)),
      }));
    const entries = [
      ...sources('engine'),
      ...cases,
      added(texts.payout, 'policy-payout'),
      added(texts.login, 'policy-login'),
    ];
    const query = added(texts.routing, 'query'),
      run = (items, options) => evaluateAnswer(record(items, query), {}, options);
    const answer = run(entries);
    assert.equal(answer.status, 'supported');
    assert.equal(answer.answers[0].text, name === 'login' ? 'account team' : 'billing team');
    assert(answer.answers[0].sourceIds.includes('policy-' + name));
    assert(answer.answers[0].sourceIds.includes(cases[0].id));
    assert(answer.answers[0].derivation);
    assert.equal(run(entries.filter((e) => e.id !== 'policy-' + name)).status, 'open');
    assert.equal(run(entries.filter((e) => e.kind !== 'case')).status, 'open');
    for (const change of [
      negative,
      modal,
      (g) => {
        g.edges.find((e) => e.from === g.top && e.role === ':ARG1').role = ':ARG9';
      },
    ]) {
      assert.equal(run(mutate(entries, (e) => e.id === cases[0].id, change)).status, 'open');
    }
    const warm = run(entries, {
      grammarCache: { profile: answer.grammar.profile, grammars: answer.grammar.corpora },
    });
    assert.equal(warm.grammar.stats.compilations, 0);
    assert.equal(run([...entries].reverse()).status, 'supported');
    assert.equal(run(entries, { workBudget: 1 }).status, 'limited');
  }
  const hand = [
    ...sources('hand'),
    added(texts.explore, 'policy-explore'),
    added(texts.help, 'policy-help'),
  ];
  const query = added(texts.compound, 'compound-query'),
    run = (items) => evaluateAnswer(record(items, query));
  const answer = run(hand);
  assert.equal(answer.status, 'supported');
  assert.equal(answer.answers[0].text, 'simulate-01');
  assert(answer.answers[0].ruleIds.includes('policy-help/clause/z0/condition-v1'));
  assert(answer.answers[0].ruleIds.includes('policy-explore/clause/z0/condition-v1'));
  assert.equal(answer.answers[0].composition.premises.length, 2);
  assert(answer.grammar.corpora.at(-1).stats.sharedRules > 0);
  for (const id of ['policy-explore', 'policy-help'])
    assert.equal(run(hand.filter((e) => e.id !== id)).status, 'open');
  const supporting = (e) => e.text === 'A simulation rehearses possibilities in the digital work.';
  assert.equal(run(hand.filter((e) => !supporting(e))).status, 'open');
  for (const change of [
    negative,
    modal,
    (g) => {
      g.edges.find((e) => e.role === ':ARG0').role = ':ARG9';
    },
  ])
    assert.equal(run(mutate(hand, supporting, change)).status, 'open');
  const split = mutate(
    hand,
    (e) => e.id === 'policy-help',
    (g) => {
      const actor = g.edges.find((e) => e.from === g.top && e.role === ':ARG0');
      g.nodes.push({ id: 'independent', concept: 'simulate-01' });
      actor.to = 'independent';
    },
  );
  assert.equal(
    run(split).status,
    'open',
    'Equal concepts do not replace a shared conditional port',
  );
  assert.equal(run([...hand].reverse()).status, 'supported');
  for (const mode of ['effects', 'safety', 'wrong-role']) {
    const scenario = original.hand.scenarios.find((s) => s.name === mode),
      q = original.graphs.find((g) => g.text === scenario.input.question.text);
    assert.equal(evaluateAnswer(record(hand, { ...q, id: 'control' })).status, 'open');
  }
} finally {
  globalThis.fetch = fetch;
}
console.log(
  'ok authored AMR policies compose with independent routing cases and a two-step hand-domain chain; no manual rules, model reasoning or injected bindings; negation, modality, roles, identity, order, source removal, cache and budget controls',
);
