/** Group navigation attempts without merging their authored records or case snapshots. */
export function inquiryGroups(investigations, placementId) {
  const groups = new Map(),
    seen = new Set();
  for (const entry of [...investigations]
    .filter(Boolean)
    .sort((a, b) => (b.data.updatedAt ?? '').localeCompare(a.data.updatedAt ?? ''))) {
    if (seen.has(entry.data.id)) continue;
    seen.add(entry.data.id);
    for (const ask of [...entry.data.asks].reverse()) {
      if (
        !ask.question.trim() ||
        (ask.scopePlacementId !== placementId && ask.caseSelection?.placementId !== placementId)
      )
        continue;
      const selectedCase = ask.caseSelection;
      const key = JSON.stringify([
        ask.question,
        ask.scopePlacementId,
        selectedCase
          ? [
              selectedCase.placementId,
              selectedCase.sources.map((source) => source.textDigest ?? source.text).sort(),
            ]
          : null,
      ]);
      const attempt = { entry, ask };
      if (groups.has(key)) groups.get(key).attempts.push(attempt);
      else groups.set(key, { id: key, label: ask.question, ...attempt, attempts: [attempt] });
    }
  }
  return [...groups.values()];
}

export const currentRun = (ask) =>
  ask.runs.findLast((run) => run.question === ask.question && run.revision === ask.revision);

export function inquiryAttempts(choice) {
  return choice.attempts.flatMap(({ entry, ask }) => [
    ...(!currentRun(ask) ? [{ entry, ask, run: null, at: entry.data.updatedAt }] : []),
    ...[...ask.runs]
      .reverse()
      .map((run) => ({ entry, ask, run, at: run.at ?? entry.data.updatedAt })),
  ]);
}
