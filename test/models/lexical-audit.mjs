/** Real PropBank data, frozen acquisitions, and the user's unedited AMR. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { propbankAuditor } from '../../src/models/propbank.mjs';
import { prepareGraphs } from '../../src/models/graph-preparation.mjs';
import { createLexicalAuditor, repairReading } from '../../src/amr/lexical-audit.mjs';
import { abstractLabels, answerLabels } from '../../src/amr/labels.mjs';
const fetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('Lexical auditing cannot call a model');
};
try {
  const { audit, source } = await propbankAuditor();
  assert.equal(source.commit, '4087fa9ab5c40907c34ff91a56acc2cab1670145');
  const graph = (concept) => ({ top: 'p', nodes: [{ id: 'p', concept }], edges: [] });
  const first = (text, concept) => audit(text, graph(concept)).checks[0];
  const direct = audit('The mediator interceded.', graph('intercede-01'));
  assert.equal(direct.checks[0].status, 'related');
  assert.equal(direct.stats.dictionaryChecks, 0, 'Regular forms use the fast path');
  for (const [text, concept, method] of [
    ['The interaction continued.', 'interact-01', 'propbank-alias'],
    ['The intention was clear.', 'intend-01', 'propbank-alias'],
    ['Recognition followed.', 'recognize-02', 'propbank-alias'],
    ['The worker went home.', 'go-01', 'propbank-example'],
    ['The refusal stood.', 'refuse-01', 'morphology'],
    ['The payouts arrived.', 'pay-out-03', 'propbank-alias'],
  ]) {
    const check = first(text, concept);
    assert.equal(check.status, 'related', text);
    assert.equal(check.evidence.method, method, text);
    assert.equal(text.slice(check.evidence.start, check.evidence.end), check.evidence.text);
  }
  assert.equal(first('They log on.', 'log-on-02').status, 'related');
  assert.equal(
    first('The redesigned interface.', 'design-01').status,
    'unverified',
    'A substring is not a lexical match',
  );
  assert.equal(first('They interact.', 'interact-99').status, 'unlisted');
  assert.equal(first('She is an engineer.', 'have-org-role-91').status, 'structural');
  assert.equal(first('She can leave.', 'possible-01').status, 'operator');
  assert.equal(first('They recognize it.', 'recognize-01').status, 'related');
  assert.equal(
    first('They recognize it.', 'recognize-02').status,
    'related',
    'Matching a lemma cannot disambiguate its sense',
  );
  const negative = graph('specify-01');
  negative.nodes.push({ id: 'minus', concept: '-', literal: '-' });
  negative.edges.push({ id: 'polarity', from: 'p', role: ':polarity', to: 'minus' });
  assert.equal(
    audit('The details are unspecified.', negative).checks[0].evidence.method,
    'negative-morphology',
  );
  assert.equal(first('The details are unspecified.', 'specify-01').status, 'unverified');
  // Agent nouns in -ator name the ARG0 of their predicate, and label its abstract participant.
  const agent = {
    top: 's',
    nodes: [
      { id: 's', concept: 'sign-01' },
      { id: 'p', concept: 'person' },
      { id: 'c', concept: 'conserve-01' },
    ],
    edges: [
      { id: 'e0', from: 's', role: ':ARG0', to: 'p' },
      { id: 'e1', from: 'c', role: ':ARG0', to: 'p' },
    ],
  };
  const agentText = 'The conservator signs release slips.';
  const conservator = audit(agentText, agent).checks.find((c) => c.predicate === 'conserve-01');
  assert.equal(conservator.evidence.text, 'conservator');
  assert.equal(conservator.evidence.method, 'morphology');
  assert.deepEqual(abstractLabels(agent, agentText, audit(agentText, agent).checks), {
    p: 'conservator',
  });
  // An answer that binds a predicate reads by the word the check attested.
  const kept = {
    top: 'k',
    nodes: [
      { id: 'k', concept: 'keep-01' },
      { id: 'r', concept: 'registry' },
      { id: 'c', concept: 'commit-01' },
      { id: 'p', concept: 'public-02' },
    ],
    edges: [
      { id: 'e0', from: 'k', role: ':ARG0', to: 'r' },
      { id: 'e1', from: 'k', role: ':ARG1', to: 'c' },
      { id: 'e2', from: 'p', role: ':ARG1', to: 'c' },
    ],
  };
  const keptText = 'The registry keeps public commitments.';
  assert.equal(answerLabels(kept, keptText, audit(keptText, kept).checks).c, 'commitments');
  // A person who holds a role reads by that role's word.
  const holder = {
    top: 'a',
    nodes: [
      { id: 'a', concept: 'ask-02' },
      { id: 'p', concept: 'person' },
      { id: 'r', concept: 'have-org-role-91' },
      { id: 't', concept: 'custodian' },
    ],
    edges: [
      { id: 'e0', from: 'a', role: ':ARG0', to: 'p' },
      { id: 'e1', from: 'r', role: ':ARG0', to: 'p' },
      { id: 'e2', from: 'r', role: ':ARG2', to: 't' },
    ],
  };
  const holderText = 'The facilities custodian asks the supervisor.';
  assert.deepEqual(abstractLabels(holder, holderText, audit(holderText, holder).checks), {
    p: 'custodian',
  });
  assert.equal(
    audit(agentText, { ...agent, edges: [agent.edges[0]] }).checks.find(
      (c) => c.predicate === 'conserve-01',
    ).status,
    'unverified',
    'An agent noun needs the participant it names',
  );
  // A reading's number or clock time must be one the text gives, in digits or words.
  const valued = (literal, concept = 'percentage-entity', role = ':value') => ({
    top: 'v',
    nodes: [
      { id: 'v', concept },
      { id: 'n', concept: literal, literal },
    ],
    edges: [{ id: 'e0', from: 'v', role, to: 'n' }],
  });
  const unattested = (text, graph) =>
    audit(text, graph)
      .findings.filter((finding) => finding.status === 'unattested')
      .map((finding) => finding.predicate);
  const humidity = 'The relative humidity is sixty-four percent.';
  assert.deepEqual(unattested(humidity, valued('60.4')), ['60.4']);
  assert.deepEqual(unattested(humidity, valued('64')), []);
  assert.deepEqual(unattested('It exceeds sixty percent.', valued('60')), []);
  assert.deepEqual(unattested('The result was 8.0 percent.', valued('8.0')), []);
  assert.deepEqual(unattested('A second sample.', valued('2', 'ordinal-entity')), []);
  assert.deepEqual(
    unattested('Reports arrive in October.', valued('10', 'date-entity', ':month')),
    [],
  );
  assert.deepEqual(unattested('A daily list.', valued('1', 'temporal-quantity', ':quant')), []);
  const pickup = 'The van collects crates at four in the afternoon.';
  const time = (value) => valued(`"${value}"`, 'date-entity', ':time');
  assert.deepEqual(unattested(pickup, time('14:00')), ['14:00']);
  assert.deepEqual(unattested(pickup, time('16:00')), []);
  assert.deepEqual(unattested('Shifts begin at eight in the morning.', time('20:00')), ['20:00']);
  assert.deepEqual(unattested('The check runs at 11:00.', time('11:00')), []);
  // When the text leaves exactly one value, the reading is repaired to it.
  const repair = (text, graph) => {
    const result = repairReading(text, graph, audit(text, graph).checks);
    return [
      result.repairs.map(({ from, to }) => `${from}->${to}`),
      result.graph.nodes.find((node) => node.id === 'n')?.literal,
    ];
  };
  assert.deepEqual(repair(humidity, valued('60.4')), [['60.4->64'], '64']);
  assert.deepEqual(repair(pickup, time('14:00')), [['14:00->16:00'], '"16:00"']);
  assert.deepEqual(repair(humidity, valued('64')), [[], '64'], 'A given value stays');
  assert.deepEqual(
    repair('It rose from sixty to seventy percent.', valued('65')),
    [[], '65'],
    'Two possible values leave the reading for review',
  );
  assert.deepEqual(
    repair('The van collects crates at four.', time('14:00')),
    [[], '"14:00"'],
    'An hour without morning or afternoon is not settled',
  );
  assert.match(
    audit(pickup, time('14:00')).findings[0].reason,
    /reading has 14:00, but the text gives no such time/u,
  );
  const literal = {
    top: 'name',
    nodes: [{ id: 'name', concept: 'intercede-01', literal: 'intercede-01' }],
    edges: [],
  };
  assert.equal(audit('The code is intercede-01.', literal).checks.length, 0);

  const penman = `(z0 / recognize-02
    :polarity (z1 / amr-unknown)
    :ARG0 (z2 / person
              :ARG0-of (z3 / program-01))
    :ARG1 (z4 / thing
              :ARG1-of (z5 / intend-01
                           :ARG0 (z6 / they))
              :topic (z7 / and
                         :op1 (z8 / design-01
                                  :ARG1 (z9 / workbench))
                         :op2 (z10 / intercede-01
                                   :ARG2 (z11 / interfaces
                                              :ARG1-of (z12 / touch-01
                                                            :ARG1-of (z13 / possible-01)))))))`;
  const prepared = (await prepareGraphs([{ penman }])).results[0];
  assert(prepared.ok);
  const original = structuredClone(prepared.graph);
  const text =
    'Did programmer recognized their intention in design of the workbench and interraction with the touchable interface?';
  const supplied = audit(text, prepared.graph);
  assert.deepEqual(
    supplied.findings.map((f) => f.predicate),
    ['intercede-01'],
  );
  // Controlled spelling variation tests alias evidence; it is not reacquisition.
  const spelled = audit(text.replace('interraction', 'interaction'), prepared.graph);
  assert.deepEqual(
    spelled.findings.map((f) => f.predicate),
    ['intercede-01'],
  );
  const candidate = spelled.candidates.find((c) => c.predicate === 'interact-01');
  assert(candidate);
  assert.equal(candidate.evidence.text, 'interaction');
  assert.equal(candidate.roles[':ARG2'], 'domain of the interaction');
  assert.equal(spelled.findings[0].roles[':ARG2'], 'on behalf of');
  const resource = JSON.parse(
    await readFile(new URL('../../vendor/propbank/lexicon.json', import.meta.url), 'utf8'),
  );
  resource.frames['interact-01'][1] = resource.frames['interact-01'][1].filter(
    (alias) => alias !== 'interaction',
  );
  assert(
    !createLexicalAuditor(resource)(
      text.replace('interraction', 'interaction'),
      prepared.graph,
    ).candidates.some((c) => c.predicate === 'interact-01'),
    'Removing the dictionary alias removes the hint; no case-specific correction supplies it',
  );
  assert.deepEqual(
    prepared.graph,
    original,
    'Neither labels nor role bindings are repaired by lexical hints',
  );

  const frozen = JSON.parse(
    await readFile(new URL('../support/qa-domain-fixtures.json', import.meta.url), 'utf8'),
  );
  const before = JSON.stringify(frozen);
  for (const entry of frozen.graphs) audit(entry.text, entry.graph);
  const causation = frozen.graphs.find((g) => g.text === 'The record does not prove causation.');
  const mismatch = audit(causation.text, causation.graph);
  assert(mismatch.findings.some((f) => f.predicate === 'correlate-01'));
  assert(
    mismatch.candidates.some((c) => c.predicate === 'cause-01' && c.evidence.text === 'causation'),
  );
  const requests = frozen.graphs.find((g) => g.text.startsWith('Requests produce'));
  const requestHint = audit(requests.text, requests.graph).candidates.find(
    (c) => c.predicate === 'request-01',
  );
  assert(requestHint);
  assert.equal(requestHint.evidence.text, 'Requests');
  assert.equal(requestHint.evidence.lexeme, 'request');
  assert.equal(requestHint.evidence.method, 'propbank-inflection');
  for (const [word, expected] of [
    ['studies', 'study-01'],
    ['stopping', 'stop-01'],
    ['carried', 'carry-01'],
    ['interceding', 'intercede-01'],
    ['logs on', 'log-on-02'],
  ]) {
    const hints = audit(word, graph('misread-01')).candidates;
    const hint = hints.find((c) => c.predicate === expected);
    assert(hint, `${word} supplies ${expected} through shared inflection handling`);
    assert.equal(hint.evidence.text, word);
  }
  assert.equal(JSON.stringify(frozen), before);
  console.log(
    'ok offline PropBank audit: fast forms, aliases, irregulars, nominalizations, literal/operator exclusions, source spans, frame versions, original user AMR and 74 frozen graphs; no semantic repairs',
  );
} finally {
  globalThis.fetch = fetch;
}
