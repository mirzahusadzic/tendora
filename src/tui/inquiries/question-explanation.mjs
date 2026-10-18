/** Explain retained answer diagnostics without adding matches or inference. */
const words = (value) =>
  String(value ?? '')
    .replace(/-\d+$/u, '')
    .replaceAll('-', ' ');
const reference = new Set(['this', 'that', 'these', 'those']);

export function questionExplanation(run, relations) {
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
  const entries = missing.map((item) => {
    const relationship = relations.get(item.id)?.cells.slice(0, 3);
    const referent = item.role === ':mod' && reference.has(item.to);
    const needed =
      item.kind === 'assertion' || item.kind === 'concept'
        ? `“${words(item.concept)}” in the question reading`
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
  return {
    heading: 'Why no answer',
    table: {
      headers: ['Question needs', 'What is missing'],
      widths: [null, null],
      minWidth: 62,
      repeatColumns: 0,
      rowSpacing: 1,
      entries: [...grouped].map(([reason, { needs, openings }], index) => ({
        cells: [[...needs].join('\n'), reason],
        openings,
        choiceIndex: 1000000 + index,
        cellTones: { 0: 'warning' },
      })),
    },
  };
}
