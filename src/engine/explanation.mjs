/** Why a question stays open, in words: what the question needs and why the
 * sources do not give it, from the check's retained openings, without adding
 * matches or inference. Shared by the workbench and the CLI. */
import { meaningConcepts } from './concepts.mjs';

const words = (value) =>
  String(value ?? '')
    .replace(/-\d+$/u, '')
    .replaceAll('-', ' ');
const reference = new Set(['this', 'that', 'these', 'those']);
// Modal operators read in the words a question uses for them.
const modalWords = { 'recommend-01': 'should', 'obligate-01': 'must' };
const modalReasons = {
  'recommend-01':
    'No source says this should or must be done; a statement of what is done does not establish it.',
  'obligate-01':
    'No source says this must be done; what should or may be done does not establish it.',
};

/** The question's relationships in words, by edge: the participant, how it is
 * related, and to what (“collect / as impelled action of: cause”). */
export function relationPhrases(graph, text = '') {
  const material = meaningConcepts(graph, { sourceId: 'meaning', text });
  const entries = new Map(material.entries.map((item) => [item.id, item]));
  const phrases = new Map();
  for (const item of material.entries) {
    const parent = entries.get(item.parentId);
    if (!parent || !item.relationProof) continue;
    const edge = graph.edges.find(
      (e) =>
        e.role === item.role &&
        ((e.from === parent.nodeId && e.to === item.nodeId) ||
          (e.to === parent.nodeId && e.from === item.nodeId)),
    );
    if (edge) phrases.set(edge.id, { cells: [parent.name, item.relation, item.name] });
  }
  return phrases;
}

/** What the question needs and why it is missing, grouped by reason. */
export function openingNeeds(run, relations = new Map()) {
  const openings = run.answer?.openings ?? run.openings ?? [];
  const assertions = new Set(
    openings.filter((item) => item.kind === 'assertion').map((item) => item.concept),
  );
  const missingAssertions = new Set(
    openings
      .filter((item) => item.kind === 'assertion' && item.state === 'unmatched')
      .map((item) => item.concept),
  );
  const relatedConcepts = new Set(
    openings.filter((item) => item.kind === 'relation').flatMap((item) => [item.from, item.to]),
  );
  const missing = openings.filter((item) => {
    if (item.state === 'unjoined' && item.kind === 'relation') return false;
    if (
      item.kind === 'concept' &&
      (assertions.has(item.concept) || relatedConcepts.has(item.concept))
    )
      return false;
    // A missing assertion already explains its outgoing relationships. Keep
    // unrelated participant and reference gaps visible instead of repeating it.
    return !(item.kind === 'relation' && missingAssertions.has(item.from));
  });
  // A proposal whose shared words cover this relation: read differently, not missing.
  const sameWords = (item) =>
    (run.answer?.clarifications ?? [])
      .map((candidate) => candidate.sharedWording)
      .find(
        (wording) =>
          wording &&
          [item.from, item.to].every((concept) =>
            wording.toLowerCase().includes(words(concept).toLowerCase().split(' ')[0].slice(0, 4)),
          ),
      );
  const entries = missing.map((item) => {
    const relationship = relations.get(item.id)?.cells.slice(0, 3);
    const referent = item.role === ':mod' && reference.has(item.to);
    const needed =
      item.kind === 'assertion' || item.kind === 'concept'
        ? `“${modalWords[item.concept] ?? words(item.concept)}”`
        : referent
          ? `“${words(item.to)} ${words(item.from)}”`
          : relationship
            ? `${relationship[0]} / ${relationship[1]}: ${relationship[2]}`
            : item.from && item.role && item.to
              ? `${words(item.from)}\n${words(item.role?.slice(1))}: ${words(item.to)}`
              : (item.text ??
                {
                  scope: 'Compatible conditions',
                  connection: 'The same participants across statements',
                  question: 'A question with a relationship to check',
                }[item.kind] ??
                'A complete source connection');
    let reason;
    if (item.kind === 'question')
      reason =
        'The retained reading has no relationship or participant type to constrain an answer.';
    else if (item.state === 'unresolved')
      reason = 'The check did not resolve this connection. It is not established as missing.';
    else if (item.kind === 'assertion' && item.state === 'unmatched' && modalReasons[item.concept])
      reason = modalReasons[item.concept];
    else if (item.kind === 'assertion')
      reason =
        item.state === 'unasserted'
          ? 'Mentioned inside another statement or condition, but not established as a fact.'
          : item.state === 'unjoined'
            ? 'Sources contain this meaning, but do not satisfy the whole question.'
            : 'No source statement or applicable rule establishes this meaning.';
    else if (item.kind === 'relation')
      reason = referent
        ? 'No source connection identifies this reference.'
        : sameWords(item)
          ? `A source says “${sameWords(item)}” too, but each was read differently. Confirm the connection to use it.`
          : 'No source connects these participants in this relationship.';
    else
      reason =
        {
          condition:
            'A rule could apply, but this condition is not established for the same participants.',
          scope: 'The source has polarity or conditions that the question has not established.',
          connection: 'Supported statements refer to participants that have not been joined.',
          concept: 'No source or confirmed interpretation supplies this meaning.',
          aporia: 'This source connection remains unresolved.',
        }[item.kind] ?? 'The available evidence does not establish this connection.';
    return { cells: [needed, reason], openings: [item], cellTones: { 0: 'warning' } };
  });
  if (!entries.length)
    entries.push({
      cells: [
        'A complete answer',
        {
          conflict: 'The sources give conflicting answers.',
          ambiguous: 'Several answers fit; the evidence does not select one answer.',
          limited: 'The check reached its limit before establishing an answer.',
        }[run.status] ??
          (openings.some((item) => item.state === 'unjoined')
            ? 'Matching relationships occur in sources, but their participants do not join into one answer.'
            : 'The available sources do not establish the whole question.'),
      ],
      cellTones: { 0: 'warning' },
    });
  const grouped = new Map();
  for (const entry of entries) {
    const [need, reason] = entry.cells;
    if (!grouped.has(reason)) grouped.set(reason, { needs: new Set(), openings: [] });
    grouped.get(reason).needs.add(need);
    grouped.get(reason).openings.push(...(entry.openings ?? []));
  }
  return [...grouped].map(([reason, { needs, openings }]) => ({
    needs: [...needs],
    reason,
    openings,
  }));
}
