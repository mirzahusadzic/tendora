/** Offline role canonicalization, checked against the pinned PENMAN 1.3.1 AMR model. */
const lexicalOf = new Set([':consist-of', ':prep-on-behalf-of', ':prep-out-of']);
const inverted = (role) => role.endsWith('-of') && !lexicalOf.has(role);
const aliases = { ':mod-of': ':domain', ':domain-of': ':mod' };

export function canonicalRelation([from, role, to]) {
  if (!role.startsWith(':')) return [from, role, to];
  while (inverted(role) && inverted(role.slice(0, -3))) role = role.slice(0, -6);
  role = aliases[role] ?? role;
  return inverted(role) ? [to, role.slice(0, -3), from] : [from, role, to];
}

export function canonicalGraph(graph) {
  let changed = false;
  const edges = graph.edges.map((edge) => {
    const [from, role, to] = canonicalRelation([edge.from, edge.role, edge.to]);
    if (from === edge.from && role === edge.role && to === edge.to) return edge;
    changed = true;
    return { ...edge, from, role, to };
  });
  return changed ? { ...graph, edges } : graph;
}

/** A :wiki link is the parser's guess at a real-world referent, and readings of
 * one name disagree ("Jordan" in a question linked to a famous Jordan, in the
 * statement to no one). Reasoning reads names by their parts, so every prepared
 * reading drops its links; comparison ignores them the same way (SEMCAT's
 * ignoreWiki). */
export function withoutWikiLinks(graph) {
  const links = graph.edges.filter((edge) => edge.role === ':wiki');
  if (!links.length) return graph;
  const edges = graph.edges.filter((edge) => edge.role !== ':wiki');
  const linked = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const orphans = new Set(
    links
      .map((edge) => edge.to)
      .filter(
        (id) =>
          !linked.has(id) && graph.nodes.find((node) => node.id === id)?.literal !== undefined,
      ),
  );
  return { ...graph, nodes: graph.nodes.filter((node) => !orphans.has(node.id)), edges };
}

/** A rule read from linked readings drops the same :wiki triples, with the
 * link's target when the link was all that connected it, unless that would
 * leave a conclusion variable unbound. */
export function ruleWithoutWikiLinks(rule) {
  const all = [...rule.when, ...rule.then, ...(rule.guards ?? [])];
  const links = all.filter((triple) => triple[1] === ':wiki');
  if (!links.length) return rule;
  const related = (term) =>
    all.some(
      (triple) =>
        triple[1].startsWith(':') &&
        ![':wiki', ':instance'].includes(triple[1]) &&
        (triple[0] === term || triple[2] === term),
    );
  const targets = new Set(links.map((triple) => triple[2]).filter((term) => !related(term)));
  const keep = (triples) =>
    triples?.filter((triple) => triple[1] !== ':wiki' && !targets.has(triple[0]));
  const variable = (term) => /^\?[A-Za-z][\w-]*$/u.test(term);
  const when = keep(rule.when);
  const then = keep(rule.then);
  const guards = keep(rule.guards);
  const bound = new Set(when.flat().filter(variable));
  if (
    !when.length ||
    !then.length ||
    [...then, ...(guards ?? [])].flat().some((term) => variable(term) && !bound.has(term))
  )
    return rule;
  return { ...rule, when, then, ...(guards ? { guards } : {}) };
}
