/** Real PropBank data, frozen acquisitions, and the user's unedited AMR. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { propbankAuditor } from '../../src/models/propbank.mjs';
import { prepareGraphs } from '../../src/models/graph-preparation.mjs';
import { createLexicalAuditor } from '../../src/amr/lexical-audit.mjs';
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
