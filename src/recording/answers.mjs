/** Answer the unchanged recorded question using attributed sentence relations. */
import { inferRelations, traceRelations, guardedEvidence } from '../amr/inference.mjs';
import { reviseGraph } from '../amr/revision.mjs';
import { graphRevision } from './revisions.mjs';
import {
  claimRoot,
  inquiryPattern,
  normalizeCoordinatedUnknowns,
  requirementReading,
} from '../amr/patterns.mjs';
import { bindReferences } from './reference-bindings.mjs';
import { graphLiterals } from '../amr/literals.mjs';
import { conditionalReading } from '../amr/conditions.mjs';
import { kindReading } from '../amr/kinds.mjs';
import { unopened } from '../amr/labels.mjs';
import { conditionOpenings } from '../amr/condition-openings.mjs';
import { caseSpeakerBinding } from './case-speaker.mjs';
import { caseSources, sourceScopesFor } from './case-sources.mjs';
import { canonicalGraph, canonicalRelation } from '../amr/roles.mjs';
import { clauseFragments, clauseProfile } from '../amr/clause-fragments.mjs';
import { createGrammarMatcher } from '../amr/hrg-query.mjs';
import { grammarProfile } from '../amr/hrg-corpus.mjs';
import { relatedContributions } from './development.mjs';
import {
  partialIdentity,
  partialQueryCoverage,
  partialQueryRevision,
} from '../amr/partial-coverage.mjs';
import { mergePartialContribution } from '../amr/partial-contribution.mjs';
import { sourceSemanticTypes } from '../amr/semantic-types.mjs';
import { labelReading, withAbstractLabels } from '../amr/labels.mjs';

export const answerEngine = 'amr-hrg-answer-v1';
const descriptorRoles = new Set([':mod', ':ARG0', ':ARG1', ':instrument', ':name']);
const dateParts = [':year', ':month', ':day', ':weekday', ':time', ':dayperiod', ':season'];
const phraseBoundaries = new Set([
  'a',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'each',
  'every',
  'for',
  'from',
  'had',
  'has',
  'have',
  'her',
  'his',
  'in',
  'is',
  'its',
  'may',
  'must',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'should',
  'some',
  'that',
  'the',
  'their',
  'these',
  'this',
  'those',
  'to',
  'was',
  'were',
  'when',
  'while',
  'will',
  'with',
  'would',
  'your',
]);

export function preparedGraph(graph, preparation) {
  const prepared = preparation?.graphs?.find(
    (item) =>
      item.revision === graphRevision(graph) &&
      (!item.graphIds || item.graphIds.includes(graph.id)),
  );
  return prepared ? { ...prepared.graph, id: graph.id } : canonicalGraph(graph);
}

export function answerQuery(recording, knowledge = {}, preparation) {
  let graph = recording.graphs.find((graph) => graph.id === recording.inquiry.graphId);
  const corrections = (knowledge.queryParses ?? []).filter(
    (entry) =>
      entry.revision === graphRevision(graph) &&
      (!entry.scopePlacementId || entry.scopePlacementId === recording.project?.placementId),
  );
  const conflict = new Set(corrections.map((entry) => JSON.stringify(entry.edits))).size > 1;
  if (!conflict && corrections.length) graph = reviseGraph(graph, corrections[0].edits);
  const literals = graphLiterals(
    graph,
    recording.amrs?.find((amr) => amr.graphId === graph.id)?.response,
  );
  if (literals.size)
    graph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        literals.has(node.id) ? { ...node, literal: literals.get(node.id) } : node,
      ),
    };
  return {
    graph: preparedGraph(graph, preparation),
    revision: graphRevision(graph),
    conflict,
    corrections,
  };
}

export const sourceNode = (sourceId, nodeId) => `${sourceId}#${nodeId}`;
const clausalRoles = new Set([
  ':time',
  ':condition',
  ':location',
  ':purpose',
  ':manner',
  ':duration',
  ':frequency',
  ':destination',
  ':source',
  ':beneficiary',
]);
const clauseLeads = new Set(
  'the a an to before after during in at on for from with until when while by of into within unless if once since'.split(
    ' ',
  ),
);
/** The shortest run of source words that covers a relation's participant, led
 * by its preposition or subordinator. Words only; no text is generated.
 */
function sourceClause(material, fact, matched) {
  const source = material.sources.find((entry) => entry.id === fact.sourceIds?.[0]);
  if (!source?.text) return null;
  const local = (id) => id.startsWith(`${source.id}#`);
  const nodes = new Set([fact.triple[2]]);
  for (const id of nodes)
    for (const { triple } of material.facts) {
      if (!triple[1].startsWith(':') || triple[1] === ':instance') continue;
      const next = triple[0] === id ? triple[2] : triple[2] === id ? triple[0] : null;
      if (next && local(next) && !matched.has(next) && !nodes.has(next) && nodes.size < 24)
        nodes.add(next);
    }
  const tokens = [...source.text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    word: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
  // A node the reading reaches twice is named twice in the text.
  const mentions = (id) =>
    Math.max(
      1,
      material.facts.filter(
        ({ triple }) =>
          triple[2] === id &&
          triple[1].startsWith(':') &&
          (nodes.has(triple[0]) || triple[0] === fact.triple[0]),
      ).length,
    );
  const words = [...nodes].flatMap((id) => {
    const fact = material.facts.find(
      (f) => f.triple[0] === id && ['@literal', ':instance'].includes(f.triple[1]),
    );
    const value = String(fact?.triple[2] ?? '').replace(/^"|"$/gu, '');
    if (!value || /-91$/u.test(value) || ['person', 'thing', 'name', 'amr-unknown'].includes(value))
      return [];
    const word = value.replace(/-\d+$/u, '').split('-')[0].toLowerCase();
    return word.length > 1 ? Array(mentions(id)).fill(word) : [];
  });
  const found = (token, word) =>
    token.word === word ||
    (word.length >= 4 &&
      token.word.startsWith(word.replace(/e$/u, '')) &&
      token.word.length - word.length <= 4);
  // A word the reading uses twice (“the incident commander closes the
  // incident”) must occur twice in the clause, when the text has it twice.
  const needed = new Map();
  for (const word of words) {
    const available = tokens.filter((t) => found(t, word)).length;
    if (available) needed.set(word, Math.min(available, (needed.get(word) ?? 0) + 1));
  }

  if (!needed.size) return null;
  let best = null;
  for (let i = 0; i < tokens.length; i++)
    for (let j = i; j < tokens.length; j++) {
      if (best && j - i >= best[1] - best[0]) break;
      const window = tokens.slice(i, j + 1);
      if (
        [...needed].every(([word, count]) => window.filter((t) => found(t, word)).length >= count)
      ) {
        best = [i, j];
        break;
      }
    }
  let [first, last] = best;
  while (first > 0 && clauseLeads.has(tokens[first - 1].word)) first--;
  return source.text.slice(tokens[first].start, tokens[last].end);
}
export function sourceIdentity(source, knowledge = {}) {
  const saved = knowledge.sourceCatalog?.find(
    (item) =>
      item.nodeId === source.nodeId &&
      item.text === source.text &&
      (!source.sentenceId || item.sentenceId === source.sentenceId),
  );
  return { ...saved, ...source };
}
const referenceMatches = (source, reference, graphs) =>
  source.text === reference.text &&
  (!reference.nodeId || source.nodeId === reference.nodeId) &&
  (!reference.sentenceId || source.sentenceId === reference.sentenceId) &&
  (!reference.revision || source.revision === reference.revision) &&
  (!reference.graphRevision ||
    (graphs.get(source.graphId) &&
      graphRevision(graphs.get(source.graphId)) === reference.graphRevision));
export function answerMaterial(recording, knowledge = {}, preparation) {
  const catalog = new Map(),
    identities = new Map();
  for (const source of knowledge.sourceCatalog ?? []) {
    const key = JSON.stringify([source.nodeId, source.text]);
    if (!catalog.has(key)) catalog.set(key, source);
    const identityKey = JSON.stringify([source.nodeId, source.sentenceId]);
    if (!identities.has(identityKey)) identities.set(identityKey, source);
  }
  const catalogSource = (source) =>
    source.sentenceId && knowledge.sourceCatalog
      ? identities.get(JSON.stringify([source.nodeId, source.sentenceId]))
      : catalog.get(JSON.stringify([source.nodeId, source.text]));
  const identity = (source) => ({
    ...catalogSource(source),
    ...source,
  });
  const graphs = new Map(recording.graphs.map((graph) => [graph.id, graph]));
  const rawQuery = graphs.get(recording.inquiry.graphId);
  const queryEdits = (knowledge.queryParses ?? []).filter(
    (entry) =>
      entry.revision === graphRevision(rawQuery) &&
      (!entry.scopePlacementId || entry.scopePlacementId === recording.project?.placementId),
  );
  const currentQueryRevision =
    queryEdits.length === 1
      ? graphRevision(reviseGraph(rawQuery, queryEdits[0].edits))
      : graphRevision(rawQuery);
  const facts = [],
    nodes = [],
    skipped = [...(knowledge.skipped ?? [])],
    usedParses = [],
    sourceGraphs = [],
    conditions = [],
    fragments = [],
    projections = [];
  const selectedCase = caseSources(recording, knowledge).map(identity);
  const caseIds = new Set(selectedCase.map((source) => source.id));
  const caseTexts = selectedCase.map((source) => source.text).sort();
  const sameCase = (texts) =>
    !texts?.length || JSON.stringify([...texts].sort()) === JSON.stringify(caseTexts);
  const sameContext = (entry) => {
    if (!entry.context) return sameCase(entry.caseTexts);
    const selected = selectedCase;
    return (
      entry.context.projectId === recording.project?.id &&
      selected.length > 0 &&
      selected.every((source) => source.conceptId === entry.context.conceptId) &&
      entry.context.sources.length === selected.length &&
      entry.context.sources.every((reference) =>
        selected.some(
          (source) =>
            source.sentenceId === reference.sentenceId &&
            (source.revision ?? source.textDigest) === reference.revision,
        ),
      )
    );
  };
  const available = new Set(),
    unavailable = new Map();
  const add = (triple, sourceId, fragment, guards = fragment?.guards) =>
    facts.push({
      triple,
      sourceIds: [sourceId],
      ...(fragment ? { fragmentIds: [fragment.id], guards: guards.map(JSON.stringify) } : {}),
    });
  // A negation guards what it scopes over: relations headed by the negated
  // predicate or beneath it, and that predicate's own concept. A sibling clause
  // (“tries a possible world without changing the actual world”) stays
  // unnegated; projections and conditions keep the clause's guards.
  const scoped = (fragment, nodeId, relation) =>
    fragment.negations
      .filter((negation) => (relation ? negation.scope.has(nodeId) : negation.predicate === nodeId))
      .map((negation) => negation.guard);
  const sources = recording.sources.map(identity);
  for (const source of sources) {
    const current = catalogSource(source);
    if (
      knowledge.sourceCatalog &&
      !caseIds.has(source.id) &&
      (!current || (source.revision && current.revision !== source.revision))
    ) {
      unavailable.set(source.id, 'source changed or removed');
      continue;
    }
    const scopes = sourceScopesFor(source, knowledge.sourceScopes);
    if (
      scopes.length &&
      !scopes.some(
        (scope) =>
          sameContext(scope) &&
          (!scope.scopePlacementId || scope.scopePlacementId === recording.project?.placementId) &&
          (scope.applicability !== 'placement' || scope.placementId === source.nodeId) &&
          (!scope.revision || scope.revision === source.revision),
      )
    ) {
      unavailable.set(source.id, 'outside source scope');
      continue;
    }
    let graph = graphs.get(source.graphId);
    if (!graph) {
      unavailable.set(source.id, 'parse unavailable');
      continue;
    }
    const corrections = (knowledge.parses ?? []).filter(
      (entry) =>
        entry.sourceText === source.text &&
        (!entry.scopePlacementId || entry.scopePlacementId === recording.project?.placementId) &&
        (!entry.placementId || entry.placementId === source.nodeId),
    );
    const applicable = corrections.filter((entry) => entry.sourceRevision === graphRevision(graph));
    if (
      applicable.length > 1 &&
      new Set(applicable.map((entry) => JSON.stringify(entry.edits))).size > 1
    ) {
      skipped.push({
        kind: 'conflicting parses',
        sourceId: source.id,
        sourceText: source.text,
        parseIds: applicable.map((entry) => entry.id),
      });
      unavailable.set(source.id, 'conflicting parses');
      continue;
    }
    if (applicable.length) {
      // When projects store complete edited AMRs, load that materialized graph
      // here instead of replaying its edits. Keep the original graph/revision for
      // provenance, and distinguish the two so a correction is never applied twice.
      graph = reviseGraph(graph, applicable[0].edits);
      usedParses.push({ id: applicable[0].id, sourceId: source.id });
    } else if (corrections.length)
      skipped.push({
        kind: 'parse changed',
        sourceId: source.id,
        sourceText: source.text,
        parseIds: corrections.map((entry) => entry.id),
      });
    const revision = graphRevision(graph);
    graph = preparedGraph(graph, preparation);
    // Recordings may serialize AMRs without display annotations. Keep the
    // corpus-owned labels available when a condition creates a fresh participant.
    if (source.development?.labels)
      graph = {
        ...graph,
        nodes: graph.nodes.map((n) =>
          source.development.labels[n.id]
            ? { ...n, surfaceLabel: source.development.labels[n.id] }
            : n,
        ),
      };
    // Labels the vocabulary check attested for abstract participants; display only.
    if (source.readingLabels) graph = withAbstractLabels(graph, source.readingLabels);
    const literals = graphLiterals(
      graph,
      recording.amrs?.find((amr) => amr.graphId === graph.id)?.response,
    );
    add([source.id, '@text', source.text], source.id);
    add([source.id, '@placement', source.nodeId], source.id);
    if (source.sentenceId) add([source.id, '@sentence', source.sentenceId], source.id);
    add([source.id, '@root', sourceNode(source.id, claimRoot(graph))], source.id);
    available.add(source.id);
    sourceGraphs.push({ sourceId: source.id, graph, revision });
    const extracted = clauseFragments(graph);
    const fragmentId = (root) => `${source.id}/clause/${root}`;
    const semanticFragments = extracted.fragments.map((fragment) => ({
      ...fragment,
      id: fragmentId(fragment.root),
      sourceId: source.id,
      revision,
      guards: fragment.guards.map((id) => {
        const edge = graph.edges.find((edge) => edge.id === id);
        return [sourceNode(source.id, edge.from), edge.role, sourceNode(source.id, edge.to)];
      }),
      negations: fragment.guards.map((id) => {
        const edge = graph.edges.find((edge) => edge.id === id),
          scope = new Set([edge.from]);
        for (const current of scope)
          for (const next of fragment.graph.edges)
            if (next.from === current && next.role !== ':polarity') scope.add(next.to);
        return {
          predicate: edge.from,
          scope,
          guard: [sourceNode(source.id, edge.from), edge.role, sourceNode(source.id, edge.to)],
        };
      }),
      ports: fragment.ports.map((port) => ({ ...port, fragments: port.fragments.map(fragmentId) })),
    }));
    fragments.push(...semanticFragments);
    if (extracted.reason)
      skipped.push({ kind: 'clause boundary', sourceId: source.id, reason: extracted.reason });
    for (const fragment of semanticFragments) {
      const reading = conditionalReading(fragment.graph, literals, { negativeConclusions: true });
      if (reading?.reason)
        skipped.push({
          kind: 'conditional parse',
          sourceId: source.id,
          sourceText: source.text,
          reason: reading.reason,
        });
      else if (reading)
        conditions.push({
          id: `${fragment.id}/condition-v1`,
          name: 'Parsed condition',
          kind: 'amr-condition',
          attribution: 'Ground the explicit AMR condition before instantiating its conclusion.',
          sourceIds: [source.id],
          fragmentIds: [fragment.id],
          sources: [{ text: source.text, nodeId: source.nodeId }],
          when: [[source.id, '@text', source.text], ...fragment.guards, ...reading.when],
          then: [
            ...reading.then,
            [reading.root, '@asserted', 'true'],
            [reading.root, '@qualification', source.text],
          ],
          ...(reading.guards ? { guards: reading.guards } : {}),
        });
      else if (!fragment.projection && source.development?.asserted !== false) {
        // A kind statement extends every node its subject's description fits.
        const kind = kindReading(fragment.graph, source.text);
        if (kind)
          conditions.push({
            id: `${fragment.id}/kind-v1`,
            name: 'Kind statement',
            kind: 'amr-kind',
            attribution:
              'What the subject is said to be holds of every node its description fits, one way.',
            sourceIds: [source.id],
            fragmentIds: [fragment.id],
            sources: [{ text: source.text, nodeId: source.nodeId }],
            when: [[source.id, '@text', source.text], ...fragment.guards, ...kind.when],
            then: kind.then,
          });
      }
      // An unresolved question in a case or corpus is not a positive assertion.
      if (
        source.development?.asserted !== false &&
        !graph.nodes.some((node) => node.concept === 'amr-unknown') &&
        !reading
      ) {
        if (!fragment.projection)
          add(
            [sourceNode(source.id, fragment.root), '@asserted', 'true'],
            source.id,
            fragment,
            scoped(fragment, fragment.root, true),
          );
        else {
          const projection = fragment.projection;
          projections.push({
            id: `${fragment.id}/project-v1`,
            name: `Asserted ${projection.operator} clause`,
            attribution:
              'AMR conjunction/contrast projection retains the child clause and its polarity guards.',
            kind: 'clause-projection',
            sourceIds: [source.id],
            fragmentIds: [fragment.id],
            when: [
              [sourceNode(source.id, projection.parent), '@asserted', 'true'],
              [sourceNode(source.id, projection.parent), ':instance', projection.operator],
              [
                sourceNode(source.id, projection.parent),
                projection.role,
                sourceNode(source.id, fragment.root),
              ],
              ...fragment.guards,
            ],
            then: [[sourceNode(source.id, fragment.root), '@asserted', 'true']],
            guards: fragment.guards,
          });
        }
      }
      for (const node of fragment.graph.nodes) {
        const id = sourceNode(source.id, node.id);
        const guards = scoped(fragment, node.id, false);
        add([id, ':instance', node.concept], source.id, fragment, guards);
        for (const type of sourceSemanticTypes(node))
          add([id, '@semanticType', type], source.id, fragment, guards);
        const authoredLabel =
          node.authoredLabel ?? node.surfaceLabel ?? source.development?.labels?.[node.id];
        if (authoredLabel) add([id, '@label', authoredLabel], source.id, fragment, guards);
        if (literals.has(node.id))
          add([id, '@literal', literals.get(node.id)], source.id, fragment, guards);
      }
      for (const edge of fragment.graph.edges)
        add(
          [sourceNode(source.id, edge.from), edge.role, sourceNode(source.id, edge.to)],
          source.id,
          fragment,
          scoped(fragment, edge.from, true),
        );
    }
    if (caseIds.has(source.id)) add(['@case', '@source', source.id], source.id);
    for (const node of graph.nodes) {
      const id = sourceNode(source.id, node.id);
      add([id, '@source', source.id], source.id);
      add([id, '@node', node.id], source.id);
      nodes.push({ id, sourceId: source.id, nodeId: node.id, concept: node.concept });
    }
  }
  const rules = [];
  for (const entry of knowledge.rules ?? []) {
    if (
      !entry.applicationPlacementIds &&
      entry.scopePlacementId &&
      entry.scopePlacementId !== recording.project?.placementId
    )
      continue;
    if (
      entry.queryRevision &&
      (queryEdits.length > 1 || entry.queryRevision !== currentQueryRevision)
    )
      continue;
    if (!sameContext(entry)) continue;
    const references = entry.sources ?? [];
    const matching = references.map((reference) =>
      sources.filter((source) => referenceMatches(source, reference, graphs)),
    );
    const required = matching.map((items) => items.filter((source) => available.has(source.id)));
    if (required.some((items) => !items.length)) {
      skipped.push({
        kind: 'missing source',
        ruleId: entry.id,
        ruleName: entry.name,
        missingSources: references.flatMap((reference, index) =>
          required[index].length
            ? []
            : [
                {
                  ...reference,
                  ...(reference.nodeId
                    ? {
                        location:
                          recording.nodes?.find((node) => node.id === reference.nodeId)?.label ??
                          reference.nodeId,
                      }
                    : {}),
                  reasons: matching[index].length
                    ? [...new Set(matching[index].map((source) => unavailable.get(source.id)))]
                    : ['not recorded'],
                },
              ],
        ),
      });
      continue;
    }
    const normalize = (triple) => {
      const role = preparation?.roles?.[triple[1]];
      return role
        ? [role.inverse ? triple[2] : triple[0], role.role, role.inverse ? triple[0] : triple[2]]
        : canonicalRelation(triple);
    };
    rules.push({
      ...entry,
      when: entry.when.map(normalize),
      then: entry.then.map(normalize),
      ...(entry.guards ? { guards: entry.guards.map(normalize) } : {}),
      sourceIds: required.flat().map((source) => source.id),
      ...(entry.applicationSourceReferences
        ? {
            assertionSourceIds: sources
              .filter((s) =>
                entry.applicationSourceReferences.some((ref) => referenceMatches(s, ref, graphs)),
              )
              .map((s) => s.id),
          }
        : {}),
      ...(entry.applicationPlacementIds
        ? {
            inputSourceIds: sources
              .filter((s) => entry.applicationPlacementIds.includes(s.nodeId))
              .map((s) => s.id),
          }
        : {}),
    });
  }
  return bindReferences(
    {
      facts,
      nodes,
      rules: [...rules, ...conditions, ...projections],
      fragments,
      skipped,
      usedParses,
      sourceGraphs,
      sources,
    },
    [...(knowledge.bindings ?? []), ...caseSpeakerBinding(recording, sourceGraphs, selectedCase)],
    (entry) =>
      (!entry.scopePlacementId || entry.scopePlacementId === recording.project?.placementId) &&
      sameContext(entry),
  );
}

export function evaluateAnswer(recording, knowledge = recording.knowledge ?? {}, limits) {
  // Every reading tried below is checked against one material and inference.
  limits = { ...limits, base: baseFor(recording, knowledge, limits) };
  const reading = answerQuery(recording, knowledge, limits?.preparation);
  const result = evaluateQuestion(recording, knowledge, limits, reading);
  if (result.status !== 'open' || result.answers.length) return result;
  // A source that says it must be done answers whether it should be done.
  const required = requirementReading(reading.graph);
  if (!required) return result;
  const modal = evaluateQuestion(recording, knowledge, limits, { ...reading, graph: required });
  if (!['supported', 'conditional'].includes(modal.status) || !modal.answers.length) return result;
  return {
    ...modal,
    answers: modal.answers.map((answer) => ({ ...answer, readAs: 'requirement' })),
  };
}

function evaluateQuestion(recording, knowledge, limits, reading) {
  const original = evaluateReading(recording, knowledge, limits, reading);
  if (original.status !== 'open' || original.answers.length) return original;
  const normalized = normalizeCoordinatedUnknowns(reading.graph, recording.inquiry.text);
  if (!normalized.reason) return original;
  const originalParts = original.partial?.parts.length ?? 0;
  const split = evaluateReading(
    recording,
    knowledge,
    { ...limits, retainPartialCoverage: limits?.retainPartialCoverage || originalParts > 0 },
    { ...reading, graph: normalized.graph },
  );
  const splitParts = split.partial?.parts.length ?? 0;
  // A repeated unknown may denote one participant. Prefer that acquired reading
  // unless the text and the resolved slots justify the split.
  if (
    splitParts < originalParts ||
    (splitParts === originalParts &&
      !['supported', 'conditional', 'ambiguous', 'conflict'].includes(split.status))
  )
    return original;
  return { ...split, queryNormalization: normalized.reason };
}

/** The match cap grows with the material: about 40 matches per source
 * occurrence, between the 2000 a small scope has always had and 10000. A fixed
 * 2000 cut off a 209-statement corpus whose searches took under a second; the
 * upper bound keeps a very large scope's bounded search bounded in time.
 */
export const matchCap = (sources) => Math.min(10000, Math.max(2000, 40 * sources));
/** The fact bound grows with the material too: about 80 relation facts per
 * source occurrence, between the 12000 a small scope has always had and 48000.
 * Corpus P's statements carry about 42 facts each; a fixed 12000 stopped every
 * check at the root before inference at about 286 of them, though 17,600 facts
 * infer in a third of a second. The upper bound keeps a very large scope's
 * inference bounded, and limited when it is reached.
 */
export const factCap = (sources) => Math.min(48000, Math.max(12000, 80 * sources));

/** What a question is checked against: a recording's material and its
 * inference, for its knowledge. The readings of one question (as asked,
 * split, with descriptors, as a requirement) share it; the material does not
 * depend on the question except through interpretations made for its exact
 * reading, which belong to the recording. */
export function answerBase(recording, knowledge = recording.knowledge ?? {}, limits) {
  const material = answerMaterial(recording, knowledge, limits?.preparation);
  const account = limits?.workBudget !== undefined ? { work: 0, limit: limits.workBudget } : null;
  const grammar = createGrammarMatcher(limits?.grammarCache);
  const { base: _base, ...options } = limits ?? {};
  const inference = inferRelations(material.facts, material.rules, {
    matchLimit: matchCap(material.sources.length),
    maxFacts: factCap(material.sources.length),
    ...options,
    account,
    matcher: grammar.match,
  });
  grammar.corpus(inference.facts);
  return {
    recording,
    knowledge,
    preparation: limits?.preparation,
    material,
    inference,
    grammar,
    inferenceWork: account?.work ?? 0,
  };
}
/** A base without some sources, read from the proofs it keeps rather than
 * checked again: a fact holds when one of its proofs uses none of them (nor a
 * rule read from them) and rests on facts that hold. Derived nodes are named
 * by their application, so these are the facts and names a check without
 * the sources would derive. Null when the base's inference was bounded: a
 * capped proof list may lack the proof that would still hold. */
export function withheldBase(base, withheld) {
  if (!base.inference.complete) return null;
  const out = new Set(withheld);
  const kept = (ids) => !(ids ?? []).some((id) => out.has(id));
  const holds = new Set();
  const usable = (proof) =>
    kept(proof.sourceIds) && (proof.premises ?? []).every((id) => holds.has(id));
  // The least fixpoint: proofs rest only on facts already shown to hold.
  for (let grew = true; grew;) {
    grew = false;
    for (const fact of base.inference.facts)
      if (!holds.has(fact.id) && [fact, ...(fact.alternatives ?? [])].some(usable)) {
        holds.add(fact.id);
        grew = true;
      }
  }
  const facts = [];
  for (const fact of base.inference.facts) {
    if (!holds.has(fact.id)) continue;
    const proofs = [fact, ...(fact.alternatives ?? [])].filter(usable);
    if (proofs[0] === fact && proofs.length === 1 + (fact.alternatives?.length ?? 0)) {
      facts.push(fact);
      continue;
    }
    const { alternatives: _all, ...own } = proofs[0] === fact ? fact : { ...proofs[0] };
    facts.push({
      ...own,
      id: fact.id,
      triple: fact.triple,
      ...(proofs.length > 1 ? { alternatives: proofs.slice(1) } : {}),
    });
  }
  const material = base.material;
  const grammar = createGrammarMatcher({ profile: grammarProfile, grammars: base.grammar.corpora });
  grammar.corpus(facts);
  return {
    ...base,
    material: {
      ...material,
      sources: material.sources.filter((source) => !out.has(source.id)),
      facts: material.facts.filter((fact) => kept(fact.sourceIds)),
      rules: material.rules.filter((rule) => kept(rule.sourceIds)),
      nodes: material.nodes.filter((node) => !out.has(node.sourceId)),
      fragments: material.fragments.filter((fragment) => !out.has(fragment.sourceId)),
      usedParses: material.usedParses.filter((entry) => !out.has(entry.sourceId)),
      sourceGraphs: material.sourceGraphs.filter((entry) => !out.has(entry.sourceId)),
      skipped: material.skipped.filter((entry) => !out.has(entry.sourceId)),
    },
    inference: { ...base.inference, facts },
    grammar,
  };
}
// A base serves only the recording, knowledge and preparation it was made for;
// a nested check of another question or knowledge prepares its own.
const baseFor = (recording, knowledge, limits) =>
  limits?.base?.recording === recording &&
  limits.base.knowledge === knowledge &&
  limits.base.preparation === limits.preparation
    ? limits.base
    : answerBase(recording, knowledge, limits);

function evaluateReading(recording, knowledge, limits, reading) {
  const base = baseFor(recording, knowledge, limits);
  // Each reading reports its own skipped parses; the shared material is not changed.
  const material = { ...base.material, skipped: [...base.material.skipped] };
  const { inference, grammar } = base;
  // As before, a reading's work budget counts the inference it rests on.
  const account =
    limits?.workBudget !== undefined
      ? { work: base.inferenceWork, limit: limits.workBudget }
      : null;
  const matchRelations = grammar.match;
  const matchLimit = limits?.matchLimit ?? matchCap(material.sources.length);
  const { graph: query, conflict: conflictingQuery, corrections } = reading;
  if (conflictingQuery)
    material.skipped.push({
      kind: 'conflicting question parses',
      parseIds: corrections.map((entry) => entry.id),
    });
  const {
    variables,
    unknowns,
    unknownIds,
    patterns,
    booleanQuestion,
    assertions,
    decomposition,
    connectors,
    answerSlotIds,
    descriptorParents,
  } = inquiryPattern(query, {
    composeClauses: true,
    descriptorFallback: Boolean(limits?.descriptorFallback),
  });
  const claim = claimRoot(query);
  const matchOptions = { budget: limits?.matchBudget, limit: matchLimit, account };
  const unconstrained = query.nodes.every((node) => unknownIds.has(node.id));
  const matching = unconstrained
    ? { matches: [], complete: true }
    : matchRelations(patterns, inference.facts, matchOptions);
  const inverseDescriptor = matching.matches.some((match) =>
    [...descriptorParents].some(([unknownId, parentId]) => {
      const unknown = match.values[variables.get(unknownId)],
        parent = match.values[variables.get(parentId)];
      return (
        unknown &&
        parent &&
        inference.facts.some(
          (fact) =>
            fact.triple[0] === parent && fact.triple[1] === ':mod' && fact.triple[2] === unknown,
        ) &&
        inference.facts.some(
          (fact) =>
            fact.triple[0] === unknown && fact.triple[1] === ':ARG0' && fact.triple[2] === parent,
        )
      );
    }),
  );
  if (!limits?.descriptorFallback && inverseDescriptor)
    return evaluateReading(recording, knowledge, { ...limits, descriptorFallback: true }, reading);
  // Opposing polarity answers a boolean inquiry only at its asserted root.
  // Embedded negation, modality and reported speech remain required query structure.
  if (
    booleanQuestion &&
    !unconstrained &&
    assertions.length === 1 &&
    !query.edges.some(
      (edge) => edge.from === claim && edge.role === ':polarity' && !unknownIds.has(edge.to),
    )
  ) {
    const opposing = matchRelations(
      [
        ...patterns,
        [variables.get(claim), ':polarity', '?negative'],
        ['?negative', ':instance', '-'],
      ],
      inference.facts,
      matchOptions,
    );
    matching.matches.push(...opposing.matches.map((match) => ({ ...match, negative: true })));
    matching.complete &&= opposing.complete;
  }
  let complete = inference.complete && matching.complete;
  const answers = [];
  const guardedMatches = [];
  const evidenceIdentity = (sourceIds) =>
    JSON.stringify(
      [
        ...new Set(
          sourceIds.map(
            (id) => material.sources.find((source) => source.id === id)?.sentenceId ?? id,
          ),
        ),
      ].sort(),
    );
  // The clauses the sources' main clauses reach, and which nodes are
  // predicates, depend on the material alone: found once, when first needed.
  let clausal = null;
  const sourceClauses = () => {
    if (clausal) return clausal;
    const reaches = new Map(),
      predicates = new Set();
    for (const { triple } of material.facts)
      if (triple[1] === ':instance') {
        if (/-\d+$/u.test(triple[2]) && !/-91$/u.test(triple[2])) predicates.add(triple[0]);
      } else if (triple[1].startsWith(':')) {
        if (!reaches.has(triple[0])) reaches.set(triple[0], []);
        reaches.get(triple[0]).push(triple[2]);
      }
    const clauses = new Set(
      material.facts.filter((fact) => fact.triple[1] === '@root').map((fact) => fact.triple[2]),
    );
    for (const id of clauses) for (const to of reaches.get(id) ?? []) clauses.add(to);
    return (clausal = { clauses, predicates });
  };
  for (const match of matching.matches) {
    if (conflictingQuery) break;
    if (
      assertions.some(({ variable }) => !['true', 'conditional'].includes(match.values[variable]))
    )
      continue;
    const conditionalClaims = assertions.filter(
      ({ variable }) => match.values[variable] === 'conditional',
    );
    let conditional = conditionalClaims.length > 0;
    const perClaim = conditionalClaims.map(({ root }) =>
      inference.facts.filter(
        (fact) =>
          fact.triple[0] === match.values[variables.get(root)] &&
          fact.triple[1] === '@qualification',
      ),
    );
    if (perClaim.some((items) => !items.length)) continue;
    const conditions = perClaim.flat();
    const assigned = [...variables.values()]
      .map((id) => match.values[id])
      .filter((value) => value !== undefined);
    if (new Set(assigned).size !== assigned.length) continue;
    const witnesses = new Set(match.witnesses);
    const blocked = inference.facts.filter(
      (fact) => witnesses.has(fact.id) && !guardedEvidence(fact, witnesses).length,
    );
    if (blocked.length) {
      guardedMatches.push(...blocked);
      continue;
    }
    const assertionFacts = assertions.map(({ root, variable }) =>
      inference.facts.find(
        (fact) =>
          fact.triple[0] === match.values[variables.get(root)] &&
          fact.triple[1] === '@asserted' &&
          fact.triple[2] === match.values[variable],
      ),
    );
    const assertedFragments = new Set(
      assertionFacts
        .flatMap((assertion) => guardedEvidence(assertion, witnesses))
        .filter(
          (proof) =>
            !proof.ruleId ||
            material.rules.some(
              (rule) => rule.id === proof.ruleId && rule.kind === 'clause-projection',
            ),
        )
        .flatMap((proof) => proof.fragmentIds ?? []),
    );
    // An answer variable denotes its participant including descriptive material.
    // Its name or inverse nominal modifier need not also occur in the question.
    // Stop at other bound query participants: qualifications on the assertion
    // itself still belong to the source scope below.
    const answerDescription = new Set(
      unknowns.map((n) => match.values[variables.get(n.id)]).filter(Boolean),
    );
    const boundary = new Set(assigned.filter((id) => !answerDescription.has(id)));
    for (const id of answerDescription)
      for (const fact of material.facts) {
        const [from, role, to] = fact.triple;
        if (!role.startsWith(':') || role === ':instance') continue;
        const next = from === id ? to : to === id ? from : null;
        if (next && !boundary.has(next)) answerDescription.add(next);
      }
    const supportedWitnesses = new Set(
      traceRelations(inference.facts, match.witnesses).facts.map((f) => f.id),
    );
    const sourceScope = material.facts.filter(
      (fact) =>
        fact.fragmentIds?.some((id) => assertedFragments.has(id)) &&
        fact.triple[1].startsWith(':') &&
        fact.triple[1] !== ':instance' &&
        !(answerDescription.has(fact.triple[0]) && answerDescription.has(fact.triple[2])) &&
        !supportedWitnesses.has(JSON.stringify(fact.triple)),
    );
    if (sourceScope.length) conditional = true;
    const ids = answerSlotIds.map((id) => match.values[variables.get(id)]).filter(Boolean);
    const labelWitnesses = [];
    const stem = (value) => value.replace(/-\d+$/u, '').replaceAll('_', ' ').trim();
    const matchesWord = (token, word) => {
      const actual = token.toLowerCase(),
        expected = word.toLowerCase();
      return (
        actual === expected ||
        (expected.length >= 3 &&
          actual.startsWith(expected) &&
          actual.length - expected.length <= 4)
      );
    };
    // Recover a witnessed noun phrase without asking the AMR to spell every
    // surface modifier perfectly. Asserted roles stop the span from absorbing
    // the surrounding clause.
    const surfacePhrase = (id, base) => {
      const head = inference.facts.find(
        (fact) => fact.triple[0] === id && fact.triple[1] === ':instance',
      );
      if (!head) return undefined;
      const relations = inference.facts.filter(
        (fact) => fact.triple[1].startsWith(':') && fact.triple[1] !== ':instance',
      );
      const choices = [];
      for (const source of material.sources) {
        if (!head.sourceIds?.includes(source.id)) continue;
        const attributed = (fact) => fact.sourceIds?.includes(source.id);
        const instances = new Map(
          inference.facts
            .filter((fact) => attributed(fact) && fact.triple[1] === ':instance')
            .map((fact) => [fact.triple[0], fact.triple[2]]),
        );
        const asserted = new Set(
          inference.facts
            .filter((fact) => attributed(fact) && fact.triple[1] === '@asserted')
            .map((fact) => fact.triple[0]),
        );
        const descriptors = new Set([id]);
        const witnesses = [head.id];
        for (const current of descriptors) {
          for (const edge of relations) {
            if (!attributed(edge) || !descriptorRoles.has(edge.triple[1])) continue;
            const other =
              edge.triple[0] === current
                ? edge.triple[2]
                : edge.triple[2] === current
                  ? edge.triple[0]
                  : null;
            if (!other || !instances.has(other) || asserted.has(other)) continue;
            witnesses.push(edge.id);
            descriptors.add(other);
          }
        }
        if (descriptors.size === 1) continue;
        const tokens = [...source.text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
          text: match[0],
          start: match.index,
          end: match.index + match[0].length,
        }));
        for (const at of tokens.flatMap((token, index) =>
          matchesWord(token.text, stem(base)) ? [index] : [],
        )) {
          let start = tokens[at].start;
          for (let index = at - 1; index >= 0 && at - index <= 8; index -= 1) {
            const gap = source.text.slice(tokens[index].end, start);
            const token = tokens[index].text.toLowerCase();
            if (/[,.;:!?()[\]{}]/u.test(gap) || phraseBoundaries.has(token)) break;
            if (
              [...asserted].some(
                (node) => instances.has(node) && matchesWord(token, stem(instances.get(node))),
              )
            )
              break;
            start = tokens[index].start;
          }
          // A name keeps its capital; a sentence's opening capital is not the phrase's.
          const named = inference.facts.some(
            (fact) => fact.triple[0] === id && fact.triple[1] === ':name',
          );
          const spanned = source.text.slice(start, tokens[at].end);
          const text = named ? spanned : unopened(spanned, start, source.text);
          if (text.toLowerCase() !== stem(base).toLowerCase())
            choices.push({ text, witnesses: [...new Set(witnesses)] });
        }
      }
      if (new Set(choices.map((choice) => choice.text)).size !== 1) return undefined;
      labelWitnesses.push(...choices.flatMap((choice) => choice.witnesses));
      return choices[0].text;
    };
    const qualifiedLabel = (id, base) => {
      if (!/^[\p{L}\p{N}'-]+$/u.test(base) || ['and', 'or', 'contrast'].includes(base)) return base;
      const relations = inference.facts.filter(
        (fact) => fact.triple[1].startsWith(':') && fact.triple[1] !== ':instance',
      );
      const phrase = surfacePhrase(id, base);
      if (phrase) return phrase;
      const choices = [];
      for (const edge of relations.filter((fact) =>
        [fact.triple[0], fact.triple[2]].includes(id),
      )) {
        if (!descriptorRoles.has(edge.triple[1])) continue;
        const other = edge.triple[0] === id ? edge.triple[2] : edge.triple[0];
        if (
          !relations.some(
            (fact) =>
              [fact.triple[0], fact.triple[2]].includes(id) &&
              [fact.triple[0], fact.triple[2]].includes(other),
          ) ||
          inference.facts.some((fact) => fact.triple[0] === other && fact.triple[1] === '@asserted')
        )
          continue;
        const description =
          inference.facts.find((fact) => fact.triple[0] === other && fact.triple[1] === '@label') ??
          inference.facts.find(
            (fact) => fact.triple[0] === other && fact.triple[1] === ':instance',
          );
        if (!description || !/^[\p{L}\p{N}'-]+$/u.test(description.triple[2])) continue;
        const words = [stem(description.triple[2]), stem(base)];
        const sources = new Set(
          traceRelations(inference.facts, [edge.id, description.id]).sourceIds,
        );
        // A display abbreviation must have an attributed source occurrence.
        // Graph adjacency alone does not license inventing a noun phrase.
        for (const source of material.sources) {
          if (!sources.has(source.id)) continue;
          const tokens = source.text.match(/[\p{L}\p{N}'-]+/gu) ?? [];
          const at = tokens.findIndex(
            (token, i) =>
              matchesWord(token, words[0]) && matchesWord(tokens[i + 1] ?? '', words[1]),
          );
          if (at < 0) continue;
          const phrase = tokens.slice(at, at + words.length).join(' ');
          choices.push({
            text: at === 0 ? unopened(phrase, 0, phrase) : phrase,
            witnesses: [edge.id, description.id],
          });
          break;
        }
      }
      if (new Set(choices.map((choice) => choice.text)).size !== 1) return base;
      labelWitnesses.push(...choices.flatMap((choice) => choice.witnesses));
      return choices[0].text;
    };
    const label = (id, seen = new Set()) => {
      const concept = inference.facts.find(
        (fact) => fact.triple[0] === id && fact.triple[1] === ':instance',
      )?.triple[2];
      // A date or time reads by its own parts: "16:00, afternoon".
      if (concept === 'date-entity') {
        const parts = dateParts
          .flatMap((role) =>
            inference.facts.filter((fact) => fact.triple[0] === id && fact.triple[1] === role),
          )
          .map((fact) => {
            const literal = inference.facts.find(
              (other) => other.triple[0] === fact.triple[2] && other.triple[1] === '@literal',
            );
            if (literal) labelWitnesses.push(fact.id, literal.id);
            else labelWitnesses.push(fact.id);
            const value = literal?.triple[2] ?? fact.triple[2].split('#').pop();
            const instance = inference.facts.find(
              (other) => other.triple[0] === fact.triple[2] && other.triple[1] === ':instance',
            )?.triple[2];
            return String(literal ? value : (instance ?? value)).replace(/^"|"$/gu, '');
          })
          .filter(Boolean);
        if (parts.length) return parts.join(', ');
      }
      const named = inference.facts.filter(
        (fact) =>
          fact.triple[0] === id &&
          fact.triple[1] === '@label' &&
          (!['and', 'or'].includes(concept) || fact.triple[2].toLowerCase() !== concept),
      );
      if (named.length) {
        labelWitnesses.push(...named.map((fact) => fact.id));
        return qualifiedLabel(id, [...new Set(named.map((fact) => fact.triple[2]))].join(' / '));
      }
      // Legacy acquisitions retain names structurally without an @label fact.
      // Read only the bound participant's witnessed name chain for display.
      const names = [];
      for (const name of inference.facts.filter(
        (fact) => fact.triple[0] === id && fact.triple[1] === ':name',
      )) {
        const parts = inference.facts.filter(
          (fact) => fact.triple[0] === name.triple[2] && /^:op\d+$/u.test(fact.triple[1]),
        );
        const literals = parts.map((part) =>
          inference.facts.filter(
            (fact) => fact.triple[0] === part.triple[2] && fact.triple[1] === '@literal',
          ),
        );
        if (!parts.length || literals.some((values) => values.length !== 1)) continue;
        const facts = [name, ...parts, ...literals.flat()];
        if (facts.some((fact) => !guardedEvidence(fact, witnesses).length)) continue;
        const display = labelReading(
          {
            nodes: [
              { id, concept },
              ...literals.flat().map((fact) => ({ id: fact.triple[0], literal: fact.triple[2] })),
            ],
            edges: [name, ...parts].map((fact) => ({
              from: fact.triple[0],
              role: fact.triple[1],
              to: fact.triple[2],
            })),
          },
          '',
        ).nodes[0].surfaceLabel;
        if (display) names.push({ text: display, witnesses: facts.map((fact) => fact.id) });
      }
      if (names.length) {
        labelWitnesses.push(...names.flatMap((name) => name.witnesses));
        return [...new Set(names.map((name) => name.text))].join(' / ');
      }
      if (['and', 'or'].includes(concept) && !seen.has(id)) {
        const parts = inference.facts
          .filter((fact) => fact.triple[0] === id && /^:op\d+$/u.test(fact.triple[1]))
          .sort((a, b) => a.triple[1].localeCompare(b.triple[1], undefined, { numeric: true }));
        if (parts.length) {
          labelWitnesses.push(...parts.map((fact) => fact.id));
          return parts
            .map((fact) => label(fact.triple[2], new Set([...seen, id])))
            .join(` ${concept} `);
        }
      }
      const description = inference.facts.find(
        (fact) => fact.triple[0] === id && fact.triple[1] === ':instance',
      );
      const base = description?.triple[2] ?? id;
      if (/^[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+$/u.test(base)) {
        const words = base.toLowerCase().split('_');
        const sources = new Set(traceRelations(inference.facts, [description.id]).sourceIds);
        for (const source of material.sources.filter((entry) => sources.has(entry.id))) {
          const tokens = source.text.match(/[\p{L}\p{N}'-]+/gu) ?? [];
          const start = tokens.findIndex((_, index) =>
            words.every((word, offset) => tokens[index + offset]?.toLowerCase() === word),
          );
          if (start >= 0) {
            labelWitnesses.push(description.id);
            return tokens.slice(start, start + words.length).join(' ');
          }
        }
      }
      return qualifiedLabel(id, base);
    };
    const scopeSources = new Set(sourceScope.flatMap((fact) => fact.sourceIds));
    const qualifications = [
      ...new Set([
        ...conditions.map((fact) => fact.triple[2]),
        ...recording.sources
          .filter((source) => scopeSources.has(source.id))
          .map((source) => source.text),
      ]),
    ];
    const text = ids.length
      ? ids.map((id) => label(id)).join(', ')
      : match.negative
        ? 'No'
        : conditional
          ? qualifications.join('\n')
          : 'Yes';
    const proof = traceRelations(inference.facts, [
      ...match.witnesses,
      ...labelWitnesses,
      ...conditions.map((fact) => fact.id),
      ...sourceScope.map((fact) => JSON.stringify(fact.triple)),
    ]);
    if (
      answers.some(
        (answer) =>
          answer.text === text &&
          answer.conditional === conditional &&
          JSON.stringify(answer.qualifications) === JSON.stringify(qualifications) &&
          evidenceIdentity(answer.sourceIds) === evidenceIdentity(proof.sourceIds) &&
          JSON.stringify([...answer.ruleIds].sort()) === JSON.stringify([...proof.ruleIds].sort()),
      )
    )
      continue;
    // What the source adds to the asserted relation, in the source's own words:
    // “to the incident commander”. Descriptions of participants are not
    // qualifications; a clause whose words cannot be found keeps the sentence.
    const matched = new Set(assigned);
    // Actions the source's main clause reaches forward. A predicate that only
    // describes a participant (the release manager) is not one.
    const { clauses, predicates } = sourceClauses();
    const predicate = (id) => predicates.has(id);
    const qualifies = ({ triple: [from, role] }) =>
      clauses.has(from) &&
      !answerDescription.has(from) &&
      (clausalRoles.has(role) || (/^:ARG\d$/u.test(role) && predicate(from)));
    const scope = sourceScope
      .filter(
        (fact) =>
          matched.has(fact.triple[0]) &&
          qualifies(fact) &&
          !matched.has(fact.triple[2]) &&
          ![':name', ':wiki'].includes(fact.triple[1]),
      )
      .map((fact) => ({
        sourceId: fact.sourceIds?.[0],
        text: sourceClause(material, fact, matched),
      }))
      .filter((entry) => entry.text);
    // Show those clauses in place of their sentences; a condition keeps its sentence.
    const conditionTexts = new Set(conditions.map((fact) => fact.triple[2]));
    const scopedTexts = new Set(
      scope.map((entry) => material.sources.find((source) => source.id === entry.sourceId)?.text),
    );
    const dependsOn = [
      ...new Set([
        ...qualifications.filter((text) => !scopedTexts.has(text) || conditionTexts.has(text)),
        ...scope.map((entry) => entry.text),
      ]),
    ];
    answers.push({
      text,
      conditional,
      qualifications,
      ...(scope.length ? { dependsOn } : {}),
      ...(booleanQuestion ? { polarity: match.negative ? 'negative' : 'positive' } : {}),
      bindings: ids.map((id) => ({ id, text: label(id) })),
      ...proof,
      derivation: match.derivation,
      ...(assertions.length > 1
        ? {
            composition: {
              rule: 'and-introduction-v1',
              premises: assertionFacts.map((fact, index) => ({
                queryRoot: assertions[index].root,
                assertionId: fact.id,
              })),
            },
          }
        : {}),
      parses: material.usedParses.filter((entry) => proof.sourceIds.includes(entry.sourceId)),
    });
  }
  if (!limits?.descriptorFallback && !answers.length && descriptorParents.size)
    return evaluateAnswer(recording, knowledge, { ...limits, descriptorFallback: true });
  const bindingIdentity = (id) => {
    const occurrence = material.nodes.find((node) => node.id === id);
    const source = material.sources.find((source) => source.id === occurrence?.sourceId);
    return source ? [source.sentenceId ?? source.id, occurrence.nodeId] : id;
  };
  const distinct = new Set(
    answers.map((answer) =>
      JSON.stringify(
        booleanQuestion
          ? [answer.polarity]
          : [answer.text, answer.bindings.map((binding) => bindingIdentity(binding.id))],
      ),
    ),
  );
  const conflict =
    answers.some((answer) => answer.polarity === 'negative') &&
    answers.some((answer) => answer.polarity === 'positive');
  let status = !complete
    ? 'limited'
    : !answers.length
      ? 'open'
      : conflict
        ? 'conflict'
        : distinct.size > 1 && recording.answerExpectation?.mode !== 'set'
          ? 'ambiguous'
          : answers.every((answer) => answer.conditional)
            ? 'conditional'
            : 'supported';
  const resolved = ['supported', 'conditional'].includes(status);
  const usedInterpretations = [
    ...new Set([
      ...answers.flatMap((answer) => answer.ruleIds),
      ...answers.flatMap((answer) => answer.bindingIds ?? []),
      ...material.usedParses.map((entry) => entry.id),
      ...corrections.map((entry) => entry.id),
    ]),
  ];
  const basis = (knowledge.entries ?? [])
    .filter((entry) => usedInterpretations.some((id) => id.startsWith(`${entry.id}/`)))
    .map((entry) => ({
      ...entry,
      state: entry.state ?? 'applied',
    }));
  const openings = resolved
    ? []
    : query.edges
        .filter(
          (edge) =>
            !connectors.has(edge.from) && !(edge.role === ':polarity' && unknownIds.has(edge.to)),
        )
        .map((edge) => {
          const endpoints = [edge.from, edge.to];
          const partial = matchRelations(
            [
              [variables.get(edge.from), edge.role, variables.get(edge.to)],
              ...endpoints
                .filter((id) => !unknownIds.has(id))
                .map((id) => [
                  variables.get(id),
                  ':instance',
                  query.nodes.find((node) => node.id === id).concept,
                ]),
              ...endpoints
                .filter((id) => unknownIds.has(id))
                .flatMap((id) =>
                  (query.nodes.find((node) => node.id === id).semanticTypes ?? []).map((type) => [
                    variables.get(id),
                    '@semanticType',
                    type,
                  ]),
                ),
            ],
            inference.facts,
            matchOptions,
          );
          const witnesses = partial.matches
            .filter(
              (match) =>
                edge.from === edge.to ||
                match.values[variables.get(edge.from)] !== match.values[variables.get(edge.to)],
            )
            .map((match) => ({
              ...traceRelations(inference.facts, match.witnesses),
              bindings: endpoints.map((nodeId) => ({
                nodeId,
                id: match.values[variables.get(nodeId)],
              })),
              derivation: match.derivation,
            }));
          complete &&= partial.complete;
          return {
            kind: 'relation',
            id: edge.id,
            from: query.nodes.find((node) => node.id === edge.from).concept,
            role: edge.role,
            to: query.nodes.find((node) => node.id === edge.to).concept,
            state: witnesses.length ? 'unjoined' : partial.complete ? 'unmatched' : 'unresolved',
            reason: witnesses.length
              ? 'This relation occurs, but no complete, consistently bound assertion satisfies the question.'
              : partial.complete
                ? 'No attributed relation with these roles and concepts is available.'
                : 'The relation search reached its work limit.',
            sourceIds: [...new Set(witnesses.flatMap((witness) => witness.sourceIds))],
            ruleIds: [...new Set(witnesses.flatMap((witness) => witness.ruleIds))],
            candidateConnections: witnesses.map((witness) => ({
              kind: 'unjoined-evidence',
              ...witness,
            })),
          };
        });
  if (!resolved) {
    if (!answers.length && !unconstrained && complete)
      openings.unshift(
        ...conditionOpenings(patterns, material.rules, inference.facts, matchRelations),
      );
    if (unconstrained)
      openings.unshift({
        kind: 'question',
        state: 'unresolved',
        reason:
          'The question AMR supplies only an unknown, with no predicate, role or type to constrain its binding.',
      });
    if (guardedMatches.length)
      openings.unshift({
        kind: 'scope',
        state: 'guarded',
        reason:
          'A structural match carries polarity restrictions that the question has not established.',
        requirements: [
          ...new Set(
            guardedMatches.flatMap((fact) =>
              [fact, ...(fact.alternatives ?? [])].flatMap((proof) => proof.guards ?? []),
            ),
          ),
        ].map((id) => JSON.parse(id)),
        sourceIds: [
          ...new Set(
            guardedMatches.flatMap((fact) =>
              [fact, ...(fact.alternatives ?? [])].flatMap((proof) => proof.sourceIds),
            ),
          ),
        ],
      });
    if (assertions.length > 1 && !answers.length) {
      const clauses = decomposition.fragments.filter((fragment) => fragment.kind === 'clause');
      const partials = clauses.map((fragment) => {
        const terms = new Set(fragment.graph.nodes.map((node) => variables.get(node.id)));
        const partial = matchRelations(
          patterns.filter((pattern) => terms.has(pattern[0])),
          inference.facts,
          matchOptions,
        );
        complete &&= partial.complete;
        return partial.matches.filter((match) => {
          const witnesses = new Set(match.witnesses);
          return match.witnesses.every(
            (id) =>
              guardedEvidence(
                inference.facts.find((fact) => fact.id === id),
                witnesses,
              ).length,
          );
        });
      });
      if (partials.every((matches) => matches.length))
        openings.unshift({
          kind: 'connection',
          state: 'unjoined',
          reason:
            'Each clause has support, but their matches cannot be joined with the question’s participant identities.',
          queryNodeIds: query.nodes
            .filter(
              (node) =>
                clauses.filter((clause) => clause.graph.nodes.some((item) => item.id === node.id))
                  .length > 1,
            )
            .map((node) => node.id),
          sourceIds: [
            ...new Set(
              partials.flatMap((matches) =>
                matches.flatMap(
                  (match) => traceRelations(inference.facts, match.witnesses).sourceIds,
                ),
              ),
            ),
          ],
        });
    }
    for (const { root: claim } of assertions) {
      const concept = query.nodes.find((node) => node.id === claim).concept;
      const roots = new Set(
        inference.facts
          .filter((fact) => fact.triple[1] === ':instance' && fact.triple[2] === concept)
          .map((fact) => fact.triple[0]),
      );
      const assertions = inference.facts.filter(
        (fact) => roots.has(fact.triple[0]) && fact.triple[1] === '@asserted',
      );
      if (!assertions.length)
        openings.unshift({
          kind: 'assertion',
          concept,
          state: roots.size ? 'unasserted' : 'unmatched',
          reason: roots.size
            ? 'The requested event occurs only inside other meaning or an ungrounded condition; it has no licensed assertion.'
            : 'No source or applicable rule asserts the requested predicate.',
        });
    }
    for (const node of query.nodes.filter(
      (node) => !unknownIds.has(node.id) && !connectors.has(node.id),
    ))
      if (
        !inference.facts.some(
          (fact) => fact.triple[1] === ':instance' && fact.triple[2] === node.concept,
        )
      )
        openings.push({
          kind: 'concept',
          id: node.id,
          concept: node.concept,
          state: 'unmatched',
          reason: 'This question concept has no source occurrence or authored interpretation.',
        });
    if (!openings.length)
      openings.push({
        kind: 'assertion',
        concept: query.nodes.find((node) => node.id === claim).concept,
        state: 'unjoined',
        reason:
          'The available assertion does not meet every question obligation and polarity guard.',
      });
  }
  if (!complete) status = 'limited';
  for (const opening of relatedContributions(
    knowledge.contributions?.filter((c) =>
      material.sources.some((s) => s.development?.contributionId === c.id),
    ),
    query,
  )) {
    const c = knowledge.contributions.find((c) => c.id === opening.contributionId);
    const graphId = `aporia-query:${c.id}`;
    const samePartialContext =
      !c.partial ||
      (c.scopePlacementId === recording.project?.placementId &&
        partialIdentity(c.partial.caseSelection ?? null) ===
          partialIdentity(recording.caseState?.selection ?? null));
    const assessment = samePartialContext
      ? evaluateAnswer(
          {
            ...recording,
            inquiry: { text: c.question.text, graphId },
            graphs: [...recording.graphs, { ...c.question.graph, id: graphId }],
          },
          { ...knowledge, contributions: [] },
          {
            ...limits,
            grammarCache: grammar.cache(),
            retainPartialCoverage: Boolean(c.partial),
            partialCoverage: { ...limits?.partialCoverage, targets: c.partial?.parts ?? [] },
          },
        )
      : { status: 'open' };
    if (!['supported', 'conditional'].includes(assessment.status))
      openings.unshift({
        ...opening,
        ...(c.partial
          ? {
              partial: mergePartialContribution(
                c,
                assessment.partial ?? { parts: [], openings: [], complete: false },
              ),
            }
          : {}),
      });
  }
  const retained = (knowledge.contributions ?? []).filter(
    (c) =>
      c.partial &&
      c.scopePlacementId === recording.project?.placementId &&
      partialIdentity(c.partial.caseSelection ?? null) ===
        partialIdentity(recording.caseState?.selection ?? null) &&
      partialQueryRevision(preparedGraph(c.question.graph, limits?.preparation)) ===
        partialQueryRevision(query),
  );
  const partial =
    !conflictingQuery &&
    ((!resolved && !answers.length) || limits?.retainPartialCoverage || retained.length)
      ? partialQueryCoverage(query, material, inference.facts, {
          matcher: matchRelations,
          openings,
          scope: {
            placementId: recording.project?.placementId ?? null,
            caseSelection: recording.caseState?.selection
              ? partialIdentity(recording.caseState.selection)
              : null,
          },
          resolved: status === 'supported',
          targets: retained.flatMap((c) => c.partial.parts ?? []),
          ...limits?.partialCoverage,
        })
      : undefined;
  if (partial) partial.complete &&= inference.complete && !conflictingQuery;
  if (partial)
    partial.contributions = retained.map((c) => ({
      contributionId: c.id,
      partial: mergePartialContribution(c, partial),
    }));
  let reportedOpenings = openings;
  if (partial?.parts.length) {
    let inserted = false;
    reportedOpenings = openings.flatMap((opening) => {
      if (!['relation', 'connection'].includes(opening.kind)) return [opening];
      if (inserted) return [];
      inserted = true;
      return partial.openings;
    });
    if (!inserted) reportedOpenings.push(...partial.openings);
  }
  return {
    question: recording.inquiry.text,
    engine: answerEngine,
    status,
    answers: resolved ? answers : [],
    openings: reportedOpenings,
    ...(partial ? { partial } : {}),
    ...(recording.reasoning ? { reasoning: recording.reasoning } : {}),
    basis,
    candidates: !resolved ? answers : [],
    questionParses: conflictingQuery ? [] : corrections,
    sourceParses: material.usedParses,
    sources: material.sources.map(
      ({ id, nodeId, text, sentenceId, conceptId, revision, sourceRefs, authoring }) => ({
        id,
        nodeId,
        text,
        ...(sentenceId ? { sentenceId, conceptId, revision, sourceRefs, authoring } : {}),
      }),
    ),
    rules: material.rules.map(({ id, name, attribution, actor, origin }) => ({
      id,
      name,
      attribution,
      actor,
      ...(origin ? { origin } : {}),
    })),
    composition: {
      profile: clauseProfile,
      fragments: material.fragments,
      goals: decomposition,
      applications: [...new Set(answers.flatMap((answer) => answer.ruleIds))],
    },
    grammar: {
      profile: grammarProfile,
      corpora: grammar.corpora,
      plans: grammar.plans,
      stats: grammar.stats,
    },
    coverage: {
      sourceOccurrences: material.sources.length,
      preparedOccurrences: material.sourceGraphs.length,
      fragments: material.fragments.length,
      complete: material.sourceGraphs.length === material.sources.length,
    },
    ...(material.bindings.length ? { bindings: material.bindings } : {}),
    skipped: material.skipped,
    complete,
    rounds: inference.rounds,
    ...(account ? { work: account.work } : {}),
  };
}
