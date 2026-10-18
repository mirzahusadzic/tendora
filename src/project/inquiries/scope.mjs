/** Select corpus placements without acquisition or persistence. */
export const readableScopeLabel = (name) => name.replaceAll(' · ', ' - ');

/** Bare names prefer roots; absolute label paths disambiguate nested placements. */
export function resolveInquiryPlacement(project, selector) {
  const { placements, concepts } = project.data;
  if (!selector) return placements[0].id;
  const byId = new Map(placements.map((placement) => [placement.id, placement]));
  if (byId.has(selector)) return selector;
  const names = new Map(concepts.map((concept) => [concept.id, concept.name]));
  const encode = (name) => name.replaceAll('~', '~0').replaceAll('/', '~1');
  const matchesName = (name, value) => name === value || readableScopeLabel(name) === value;
  const path = (placement) => {
    const parts = [];
    for (let current = placement; current; current = byId.get(current.parentId))
      parts.push(encode(readableScopeLabel(names.get(current.conceptId))));
    return '/' + parts.reverse().join('/');
  };
  let matches;
  if (selector.startsWith('/')) {
    const children = new Map();
    for (const placement of placements) {
      if (!children.has(placement.parentId)) children.set(placement.parentId, []);
      children.get(placement.parentId).push(placement);
    }
    let parents = [null];
    for (const segment of selector.slice(1).split('/')) {
      matches = parents.flatMap((parent) =>
        (children.get(parent) ?? []).filter((placement) =>
          matchesName(encode(names.get(placement.conceptId)), segment),
        ),
      );
      parents = matches.map((placement) => placement.id);
    }
  } else {
    matches = placements.filter((placement) =>
      matchesName(names.get(placement.conceptId), selector),
    );
    const roots = matches.filter((placement) => placement.parentId === null);
    if (roots.length) matches = roots;
  }
  if (matches.length === 1) return matches[0].id;
  const choices = matches.length ? matches : placements.filter((p) => p.parentId === null);
  const paths = choices.map(path);
  const alternatives = choices.map((placement, index) => {
    const value = paths[index];
    return (
      '  ' +
      JSON.stringify(value) +
      (paths.indexOf(value) !== paths.lastIndexOf(value)
        ? ' (placement ID: ' + JSON.stringify(placement.id) + ')'
        : '')
    );
  });
  throw new Error(
    (matches.length ? 'Ambiguous placement: ' : 'No placement matches: ') +
      JSON.stringify(readableScopeLabel(selector)) +
      '\n' +
      (matches.length ? 'Choose a full label path:' : 'Available root label paths:') +
      '\n' +
      alternatives.join('\n'),
  );
}

/** Traverse the selected branch; empty containers remain context, not evidence. */
export function projectInquiryBranch(project, placementId) {
  const placements = new Map(project.data.placements.map((p) => [p.id, p]));
  const concepts = new Map(project.data.concepts.map((c) => [c.id, c]));
  const children = new Map();
  for (const p of placements.values()) {
    if (!children.has(p.parentId)) children.set(p.parentId, []);
    children.get(p.parentId).push(p);
  }
  const selected = placements.get(placementId);
  if (!selected) throw new Error('Choose a concept to ask.');
  const ancestors = [];
  for (let p = placements.get(selected.parentId); p; p = placements.get(p.parentId))
    ancestors.unshift(concepts.get(p.conceptId).name);
  const stack = [{ placement: selected, path: ancestors }],
    candidates = [];
  while (stack.length) {
    const { placement, path } = stack.pop(),
      concept = concepts.get(placement.conceptId);
    const context = [...path, concept.name];
    candidates.push({
      placementId: placement.id,
      conceptId: concept.id,
      parentId: placement.parentId,
      sentenceCount: concept.passages.length,
      name: concept.name,
      description: concept.description ?? '',
      path: context,
      text: [concept.name, concept.description].filter(Boolean).join('\n'),
    });
    for (const child of (children.get(placement.id) ?? []).slice().reverse())
      stack.push({ placement: child, path: context });
  }
  return candidates;
}

export const projectInquiryCandidates = (project, placementId) =>
  projectInquiryBranch(project, placementId).filter((node) => node.sentenceCount > 0);
