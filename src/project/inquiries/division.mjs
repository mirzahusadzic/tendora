/** Collection and division: do these statements belong together, or apart?
 * Two statements are connected when they share a participant (by name) or a
 * content concept (a predicate's lemma, a thing's concept), never a generic
 * one (person, thing, a role frame, a quantifier) nor one nearly every
 * statement has. Then
 *   division     a role whose own statements fall into groups connected to
 *                nothing in the others: one role, or several?
 *   collection   a statement that shares more with another role's statement
 *                than with any of its own role's: does it belong there?
 * Proposals for a person to make in the role tree, never made here.
 * Read-only and offline. */
import { corpusView } from './corpus.mjs';

const generic = new Set([
  'person',
  'thing',
  'name',
  'and',
  'or',
  'multi-sentence',
  'possible-01',
  'obligate-01',
  'recommend-01',
  'permit-01',
  'cause-01',
  'have-condition-91',
  'date-entity',
  'time',
  'it',
  'they',
  'we',
  'you',
  'i',
  // Quantifiers and focus words say how much or which, not what about.
  'both',
  'another',
  'other',
  'only',
  'all',
  'each',
  'every',
  'some',
  'any',
  'same',
  'one',
  'this',
  'that',
  'also',
  'still',
  'again',
  'even',
  'just',
  'more',
  'most',
]);

/** What a statement is about: its participants by name, its content
 * concepts by lemma. */
function keys(graph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const named = new Set();
  const found = new Set();
  for (const edge of graph.edges.filter((entry) => entry.role === ':name')) {
    named.add(edge.from);
    const words = graph.edges
      .filter((op) => op.from === edge.to && /^:op\d+$/u.test(op.role))
      .map((op) => String(nodes.get(op.to)?.literal ?? '').replace(/^"|"$/gu, ''))
      .join(' ');
    if (words) found.add(`name:${words.toLowerCase()}`);
  }
  // A measure's unit (the minute of ten minutes) says how much, not what about.
  const units = new Set(graph.edges.filter((edge) => edge.role === ':unit').map((edge) => edge.to));
  for (const node of graph.nodes) {
    const concept = node.concept;
    if (units.has(node.id) || concept?.endsWith('-quantity')) continue;
    if (!concept || node.literal !== undefined || named.has(node.id) || node.concept === 'name')
      continue;
    const lemma = concept.replace(/-\d+$/u, '');
    if (generic.has(concept) || generic.has(lemma) || /-91$/u.test(concept)) continue;
    if (concept.startsWith('amr-') || concept.endsWith('-entity') || lemma === 'either') continue;
    found.add(`concept:${lemma}`);
  }
  return found;
}

export async function divisionReport(project) {
  const view = await corpusView(project);
  const items = view.statements.filter((item) => item.graph);
  // A concept nearly every statement has connects everything and tells
  // nothing: one in more than a tenth of the statements (and five) is left
  // out. A name is never: it is who the statements are about.
  const all = new Map(items.map((item) => [item.id, keys(item.graph)]));
  const counts = new Map();
  for (const found of all.values())
    for (const key of found) counts.set(key, (counts.get(key) ?? 0) + 1);
  const common = Math.max(5, items.length / 10);
  const about = new Map(
    [...all].map(([id, found]) => [
      id,
      new Set([...found].filter((key) => key.startsWith('name:') || counts.get(key) <= common)),
    ]),
  );
  const shared = (a, b) => [...about.get(a)].filter((key) => about.get(b).has(key));
  const byRole = new Map();
  for (const item of items) {
    if (!byRole.has(item.placementId)) byRole.set(item.placementId, []);
    byRole.get(item.placementId).push(item);
  }
  const findings = [];
  // Division: the connected groups of a role's own statements.
  for (const [, own] of byRole) {
    if (own.length < 2) continue;
    const group = new Map(own.map((item) => [item.id, item.id]));
    const find = (id) => (group.get(id) === id ? id : find(group.get(id)));
    for (let i = 0; i < own.length; i++)
      for (let j = i + 1; j < own.length; j++)
        if (shared(own[i].id, own[j].id).length) group.set(find(own[i].id), find(own[j].id));
    const groups = new Map();
    for (const item of own) {
      const root = find(item.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(item.id);
    }
    if (groups.size < 2) continue;
    const role = view.role(own[0].id);
    findings.push({
      method: 'division',
      kind: 'division',
      summary: `${role}'s statements fall into ${groups.size} groups that share nothing.`,
      role,
      groups: [...groups.values()].map((ids) => view.named(ids)),
      statements: view.named(own.map((item) => item.id)),
      proposal: `Is ${role} one role, or ${groups.size}? Its groups could be roles of their own.`,
    });
  }
  // Collection: a statement closer to another role's statement than to its
  // own; two that lean on each other are one finding, and may be the tie
  // between their roles rather than misplaced.
  const leans = new Map();
  for (const item of items) {
    const ownBest = Math.max(
      0,
      ...byRole
        .get(item.placementId)
        .filter((other) => other.id !== item.id)
        .map((other) => shared(item.id, other.id).length),
    );
    let best = null;
    for (const other of items)
      if (other.placementId !== item.placementId) {
        const common = shared(item.id, other.id);
        if (
          common.length >= 2 &&
          common.length > ownBest &&
          common.length > (best?.common.length ?? 0)
        )
          best = { other, common };
      }
    if (best) leans.set(item.id, best);
  }
  for (const [id, { other, common }] of leans) {
    const mutual = leans.get(other.id)?.other.id === id;
    if (mutual && other.id < id) continue;
    const item = view.byId.get(id);
    findings.push({
      method: 'division',
      kind: 'collection',
      summary: mutual
        ? `“${item.text}” [${view.role(id)}] and “${other.text}” [${view.role(other.id)}] share more with each other than with their own roles.`
        : `“${item.text}” shares more with ${view.role(other.id)}'s “${other.text}” than with any of ${view.role(id)}'s.`,
      shares: common.map((key) => key.replace(/^\w+:/u, '')),
      statements: view.named([id, other.id]),
      proposal: mutual
        ? `Do they say one thing from two roles (the tie between ${view.role(id)} and ${view.role(other.id)}), or does one belong with the other?`
        : `Does “${item.text}” belong with ${view.role(other.id)}, or does it tie ${view.role(id)} to ${view.role(other.id)}?`,
    });
  }
  return {
    revision: project.digest,
    roles: byRole.size,
    statements: items.length,
    findings,
  };
}

/** The report as plain text, for the CLI. */
export function formatDivision(report) {
  const lines = [
    `Collection and division over ${report.statements} statements in ${report.roles} roles: ${
      report.findings.length
        ? `${report.findings.length} ${report.findings.length === 1 ? 'proposal' : 'proposals'}.`
        : 'each role holds together, and no statement leans elsewhere.'
    }`,
  ];
  for (const finding of report.findings) {
    lines.push('', `${finding.kind}: ${finding.proposal}`);
    if (finding.groups)
      finding.groups.forEach((group, index) =>
        lines.push(`  group ${index + 1}:`, ...group.map((item) => `    “${item.statement}”`)),
      );
    else
      lines.push(
        `  shares: ${finding.shares.join(', ')}`,
        ...finding.statements.map((item) => `  “${item.statement}” [${item.role}]`),
      );
  }
  return lines.join('\n');
}
