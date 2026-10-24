/** Recoil: a read-only walk from a locus over the saved checks, toward what the
 * locus rests on (its origins) and toward what rests on it (its consequences).
 * Nothing is checked again. What the walk cannot see is returned as its
 * frontier: a check released from storage or made against earlier statements,
 * a question never checked, a statement without a reading, a rule whose origin
 * was not retained, or the walk's own bound. A frontier is never absence.
 *
 * A locus is a statement ({ kind: 'statement', id } or { text }), a role
 * ({ kind: 'role', placementId }) or a saved question ({ kind: 'question',
 * text, scopePlacementId }). Each locus is visited once per direction at the
 * project's revision. Only what a check cited is an edge; similar wording,
 * closest statements and proposals are not.
 */
import { sourceCatalog } from '../authoring/sources.mjs';
import { knowledgeSnapshot } from '../authoring/knowledge.mjs';
import { listEngineRuns } from '../storage/engine-runs.mjs';
import { readAcquisitions } from '../storage/acquisitions.mjs';
import { listInvestigations } from './investigation.mjs';

const questionPurposes = new Set(['inquiry', 'question-refresh']);
export const recoilFrontier = {
  unchecked: 'The question was saved but never checked.',
  changed: 'The check was made against earlier statements.',
  released: 'The full check was released from storage.',
  'no reading': 'The statement has no retained reading.',
  'rule origin not retained': 'The check used a rule whose origin it did not keep.',
  bound: 'The walk stopped at its bound before visiting this.',
};

export async function projectRecoil(project, locus, options) {
  const [runs, investigations, acquisitions] = await Promise.all([
    listEngineRuns(project),
    listInvestigations(project),
    readAcquisitions(project),
  ]);
  return recoil(
    {
      data: project.data,
      digest: project.digest,
      runs,
      asks: investigations.flatMap(({ data }) => data.asks),
      readings: acquisitions ? new Set(Object.keys(acquisitions.entries)) : null,
    },
    locus,
    options,
  );
}

/** `readings`, when given, holds the text revisions that have a retained reading. */
export function recoil({ data, digest, runs, asks = [], readings = null }, locus, options = {}) {
  const { limit = 500 } = options;
  const catalog = sourceCatalog(data).map((item) => ({
    ...item,
    id: item.development ? item.sentenceId : `${item.nodeId}/s${item.index + 1}`,
  }));
  const statements = new Map(catalog.map((item) => [item.id, item]));
  const placements = new Map(data.placements.map((placement) => [placement.id, placement]));
  const concepts = new Map(data.concepts.map((concept) => [concept.id, concept]));
  const within = (placementId, scopeId) => {
    for (let at = placementId; at; at = placements.get(at)?.parentId)
      if (at === scopeId) return true;
    return false;
  };
  const authoredRules = new Map(knowledgeSnapshot(data).rules.map((rule) => [rule.id, rule]));

  // The latest check of each saved question; a question saved without one is unchecked.
  // A case is the situation it states: asked again with the same statements, it
  // is the same question, whatever the case's own identifier.
  const caseIdentity = (selection) =>
    selection?.sources?.length
      ? selection.sources.map((source) => source.text).join('\n')
      : (selection?.placementId ?? null);
  const questionKey = (text, scope, selection) =>
    JSON.stringify([text.trim(), scope, caseIdentity(selection)]);
  const questions = new Map();
  for (const run of runs) {
    const text = run.questions?.[0]?.text;
    if (!text || (run.purpose && !questionPurposes.has(run.purpose))) continue;
    const key = questionKey(text, run.scopePlacementId, run.caseSelection);
    const prior = questions.get(key);
    if (!prior || prior.run.startedAt < run.startedAt)
      questions.set(key, {
        id: key,
        text,
        scopePlacementId: run.scopePlacementId,
        caseSelection: run.caseSelection ?? prior?.caseSelection ?? null,
        run,
      });
  }
  for (const ask of asks) {
    const key = questionKey(ask.question, ask.scopePlacementId, ask.caseSelection);
    if (ask.question.trim() && !questions.has(key))
      questions.set(key, {
        id: key,
        text: ask.question,
        scopePlacementId: ask.scopePlacementId,
        caseSelection: ask.caseSelection,
        run: null,
      });
    else if (questions.has(key) && !questions.get(key).caseSelection)
      questions.get(key).caseSelection = ask.caseSelection;
  }
  const unseen = (question) =>
    !question.run
      ? 'unchecked'
      : question.run.projectDigest !== digest
        ? 'changed'
        : !question.run.answer
          ? 'released'
          : null;

  // A rule derived from a statement names it: `<statement>/clause/<clause>/<kind>`.
  const derivedFrom = (ruleId) => /^(.*)\/clause\/[^/]+\/[^/]+$/u.exec(ruleId)?.[1];
  const ruleOrigins = (ruleId) => {
    if (statements.has(derivedFrom(ruleId))) return [derivedFrom(ruleId)];
    const rule = authoredRules.get(ruleId);
    if (!rule) return null;
    return (rule.sources ?? [])
      .map(
        (source) =>
          catalog.find((item) => item.nodeId === source.nodeId && item.text === source.text)?.id,
      )
      .filter(Boolean);
  };
  // What each visible check cites, at this revision.
  const citations = new Map(),
    caseTexts = new Map();
  for (const question of questions.values()) {
    if (unseen(question)) continue;
    const answer = question.run.answer;
    const revisions = new Map();
    for (const source of answer.sources ?? []) {
      revisions.set(source.id, source.revision);
      if (!statements.has(source.id)) caseTexts.set(source.id, source.text);
    }
    const links = [];
    const cite = (id, relation, fragments = []) =>
      links.push({
        kind: statements.has(id) ? 'statement' : 'case',
        id,
        relation,
        fragments: fragments.filter((fragment) => fragment.startsWith(`${id}/`)),
        current:
          !statements.has(id) ||
          !revisions.has(id) ||
          revisions.get(id) === statements.get(id).revision,
      });
    for (const binding of answer.answers) {
      for (const id of binding.sourceIds) cite(id, 'answer', binding.fragmentIds ?? []);
      for (const id of binding.ruleIds ?? [])
        links.push({ kind: 'rule', id, relation: 'answer', fragments: [], current: true });
    }
    for (const binding of answer.candidates ?? [])
      for (const id of binding.sourceIds) cite(id, 'possible answer', binding.fragmentIds ?? []);
    for (const part of answer.partial?.parts ?? [])
      for (const id of part.sourceIds ?? []) cite(id, 'supported part');
    citations.set(question.id, links);
  }
  /** The questions whose current checks rest on a statement, directly or through a rule. */
  const restingOn = (statementId) => {
    const found = [];
    for (const [key, links] of citations)
      for (const link of links)
        if (link.kind === 'statement' && link.id === statementId && link.current)
          found.push({ question: key, relation: 'rests on' });
        else if (link.kind === 'rule' && ruleOrigins(link.id)?.includes(statementId))
          found.push({ question: key, relation: 'rests on a rule read from' });
    return found;
  };

  const label = (kind, id) =>
    kind === 'statement'
      ? statements.get(id)?.text
      : kind === 'role'
        ? (concepts.get(placements.get(id)?.conceptId)?.name ?? 'Removed role')
        : kind === 'question'
          ? questionLabel(questions.get(id))
          : kind === 'case'
            ? (caseTexts.get(id) ?? id)
            : kind === 'rule'
              ? (authoredRules.get(id)?.name ??
                (statements.has(derivedFrom(id))
                  ? `Rule read from “${statements.get(derivedFrom(id)).text}”`
                  : id))
              : kind === 'reading'
                ? `Reading of “${statements.get(id)?.text}”`
                : id;
  // A question asked with a case is named with it, as Development names it.
  const questionLabel = (question) => {
    const selection = question?.caseSelection;
    const named =
      selection?.label ?? selection?.sources?.map((source) => source.text).join(' ') ?? null;
    return question && (named ? `${question.text} / Case: ${named}` : question.text);
  };
  const start = resolveLocus(locus, { statements, catalog, placements, questions, questionKey });
  const contained = (roleId) => catalog.filter((item) => within(item.nodeId, roleId));
  const visits = [],
    frontier = [],
    seen = new Set(),
    queue = [];
  const enqueue = (entry) => {
    const key = JSON.stringify([entry.kind, entry.id, entry.direction]);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(entry);
  };
  const hide = (entry, reason) => {
    const key = JSON.stringify(['frontier', entry.kind, entry.id, entry.direction]);
    if (seen.has(key)) return;
    seen.add(key);
    frontier.push({ ...entry, label: label(entry.kind, entry.id), reason });
  };

  const origins = (entry) => {
    const next = (kind, id, relation, extra = {}) =>
      enqueue({ kind, id, direction: 'origin', from: entry.id, relation, ...extra });
    if (entry.kind === 'statement') {
      next('role', statements.get(entry.id).nodeId, 'placed at');
      if (readings && !readings.has(statements.get(entry.id).revision))
        hide({ kind: 'reading', id: entry.id, direction: 'origin', from: entry.id }, 'no reading');
    } else if (entry.kind === 'role' && entry.locus)
      for (const item of contained(entry.id)) next('statement', item.id, 'contains');
    else if (entry.kind === 'question') {
      const reason = unseen(questions.get(entry.id));
      if (reason) return hide({ ...entry, locus: undefined }, reason);
      for (const link of citations.get(entry.id))
        if (!link.current)
          hide({ kind: 'statement', id: link.id, direction: 'origin', from: entry.id }, 'changed');
        else
          next(
            link.kind,
            link.id,
            link.relation,
            link.fragments.length ? { fragments: link.fragments } : {},
          );
    } else if (entry.kind === 'rule') {
      const found = ruleOrigins(entry.id);
      if (!found) return hide(entry, 'rule origin not retained');
      for (const id of found) next('statement', id, 'read from');
    }
  };
  const consequences = (entry) => {
    const next = (kind, id, relation) =>
      enqueue({ kind, id, direction: 'consequence', from: entry.id, relation });
    if (entry.kind === 'statement')
      for (const { question, relation } of restingOn(entry.id))
        next('question', question, relation);
    else if (entry.kind === 'role' && entry.locus) {
      for (const question of questions.values())
        if (question.scopePlacementId === entry.id) next('question', question.id, 'asked at');
      for (const item of contained(entry.id))
        for (const { question } of restingOn(item.id))
          next('question', question, 'rests on a statement here');
    } else if (entry.kind === 'question')
      next('role', questions.get(entry.id).scopePlacementId, 'asked at');
  };

  for (const direction of ['origin', 'consequence'])
    enqueue({ ...start, direction, from: null, relation: null, locus: true });
  while (queue.length) {
    const entry = queue.shift();
    if (visits.length >= limit) {
      hide(entry, 'bound');
      continue;
    }
    visits.push({ ...entry, label: label(entry.kind, entry.id) });
    (entry.direction === 'origin' ? origins : consequences)(entry);
  }

  // A question whose scope reaches the locus either rests on it (a consequence),
  // is unaffected at this revision, or is hidden from the walk (frontier).
  let unaffected = 0;
  if (start.kind !== 'question') {
    const role = start.kind === 'statement' ? statements.get(start.id).nodeId : start.id;
    const reached = new Set(
      visits.filter((visit) => visit.kind === 'question').map((visit) => visit.id),
    );
    for (const question of questions.values()) {
      const reaches =
        within(role, question.scopePlacementId) ||
        (start.kind === 'role' && within(question.scopePlacementId, role));
      if (!reaches || reached.has(question.id)) continue;
      const reason = unseen(question);
      if (reason)
        hide(
          { kind: 'question', id: question.id, direction: 'consequence', from: start.id },
          reason,
        );
      else unaffected++;
    }
  }
  // Sideways: what shares the locus's place. For a statement, the statements
  // the questions resting on it also cite (directly or through a rule read
  // from them); for a role, the other roles those come from; for a question,
  // the other questions resting on the statements it rests on.
  const alongside = [],
    beside = new Set();
  const side = (entry) => {
    const key = JSON.stringify([entry.kind, entry.id]);
    if (beside.has(key)) return;
    beside.add(key);
    alongside.push({
      ...entry,
      label: label(entry.kind, entry.id),
      via: label('question', entry.through) ?? label('statement', entry.through),
    });
  };
  const carriers = (question) =>
    (citations.get(question) ?? []).flatMap((link) =>
      link.kind === 'statement' && link.current
        ? [link.id]
        : link.kind === 'rule'
          ? (ruleOrigins(link.id) ?? [])
          : [],
    );
  if (start.kind === 'statement' || start.kind === 'role') {
    const own = new Set(
      start.kind === 'statement' ? [start.id] : contained(start.id).map((item) => item.id),
    );
    const resting = visits
      .filter((visit) => visit.direction === 'consequence' && visit.kind === 'question')
      .map((visit) => visit.id);
    for (const question of resting)
      for (const id of carriers(question))
        if (!own.has(id))
          side(
            start.kind === 'statement'
              ? { kind: 'statement', id, through: question, relation: 'carries with it' }
              : {
                  kind: 'role',
                  id: statements.get(id).nodeId,
                  through: question,
                  relation: 'carries with it',
                },
          );
  } else
    for (const id of carriers(start.id))
      for (const { question } of restingOn(id))
        if (question !== start.id)
          side({
            kind: 'question',
            id: question,
            through: id,
            relation: 'rests on the same statement',
          });
  const strip = ({ locus: _locus, ...visit }) => visit;
  return {
    locus: { ...start, label: label(start.kind, start.id) },
    revision: digest,
    origins: visits.filter((visit) => visit.direction === 'origin' && !visit.locus).map(strip),
    consequences: visits
      .filter((visit) => visit.direction === 'consequence' && !visit.locus)
      .map(strip),
    frontier: frontier.map(strip),
    alongside,
    // Questions whose scope reaches the locus, checked at this revision, whose
    // answers do not rest on it.
    unaffected,
  };
}

function resolveLocus(locus, { statements, catalog, placements, questions, questionKey }) {
  if (locus.kind === 'statement') {
    const id =
      locus.id ?? catalog.find((item) => item.text.trim() === locus.text?.trim())?.id ?? null;
    if (!statements.has(id)) throw new Error('No such statement in this project.');
    return { kind: 'statement', id };
  }
  if (locus.kind === 'role') {
    if (!placements.has(locus.placementId)) throw new Error('No such role in this project.');
    return { kind: 'role', id: locus.placementId };
  }
  if (locus.kind === 'question') {
    const id = questionKey(locus.text, locus.scopePlacementId, locus.caseSelection);
    if (!questions.has(id)) throw new Error('No such saved question in this project.');
    return { kind: 'question', id };
  }
  throw new Error(`Unknown locus: ${locus.kind}`);
}
