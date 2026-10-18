/** Readable relational material from grounded HRG occurrences, without new assertions. */
import { compileCorpus, grammarFacts } from './hrg-corpus.mjs';
import { graphFacts } from './development.mjs';

const words = (value) => String(value).replace(/-\d+$/u, '').replaceAll('-', ' ');
const relations = {
  ':condition': 'if',
  ':location': 'where',
  ':time': 'when',
  ':purpose': 'purpose',
  ':cause': 'because',
  ':polarity': 'truth',
  ':mod': 'quality',
  ':domain': 'describes',
  ':poss': 'belongs to',
  ':topic': 'about',
};

/** Tree appearances retain a shared concept identity; tree nesting is not an is-a claim. */
export function conceptMaterial(graph, { sourceId, text = '', frames = {}, grammar } = {}) {
  const facts = graphFacts(graph, sourceId);
  grammar ??= compileCorpus(facts).grammar;
  const grounded = grammarFacts(grammar, facts);
  // A missing production must remove the corresponding material, not fall back to raw edges.
  const available = new Set(
    grounded.filter((f) => f.triple[1] === ':instance').map((f) => f.triple[0]),
  );
  const nodes = new Map(graph.nodes.filter((n) => available.has(n.id)).map((n) => [n.id, n]));
  const edges = grounded
    .filter((f) => f.triple[1].startsWith(':') && f.triple[1] !== ':instance')
    .map((f) => ({ from: f.triple[0], role: f.triple[1], to: f.triple[2], proof: f.grammar }));
  const hidden = new Set();
  for (const e of edges)
    if (e.role === ':wiki' && edges.filter((x) => x.from === e.to || x.to === e.to).length === 1)
      hidden.add(e.to);
  const labels = new Map();
  for (const n of nodes.values()) {
    const name = edges.find((e) => e.from === n.id && e.role === ':name');
    const parts = name && edges.filter((e) => e.from === name.to && /^:op\d+$/u.test(e.role));
    if (parts?.length) {
      hidden.add(name.to);
      for (const e of parts) hidden.add(e.to);
    }
    const label =
      n.concept === 'amr-unknown'
        ? 'answer sought'
        : n.literal !== undefined
          ? String(n.literal).replace(/^"|"$/gu, '')
          : ((n.authoredLabel?.length <= 48 ? n.authoredLabel : null) ??
            n.surfaceLabel ??
            (parts?.length
              ? parts
                  .sort((a, b) => a.role.localeCompare(b.role, undefined, { numeric: true }))
                  .map((e) => String(nodes.get(e.to)?.literal ?? '').replace(/^"|"$/gu, ''))
                  .join(' ')
              : words(n.concept)));
    labels.set(n.id, label.replace(/[.!?]+$/u, ''));
  }
  // Fold the lexical decomposition of a nominal participant into its source label.
  // Its graph and all ports remain available; this is only a reading abbreviation.
  const folded = new Map();
  for (const e of edges) {
    if (e.from === graph.top || !/^:ARG[01]$/u.test(e.role)) continue;
    if (labels.get(e.from) !== labels.get(e.to)) continue;
    if (edges.filter((x) => x.from === e.from || x.to === e.from).length !== 1) continue;
    hidden.add(e.from);
    if (!folded.has(e.to)) folded.set(e.to, []);
    folded.get(e.to).push(e.from);
  }
  const roleName = (e, inverse = false) => {
    const frame = frames[nodes.get(e.from)?.concept];
    const role =
      frame?.[3]?.[e.role] ??
      relations[e.role] ??
      (/^:ARG\d+$/u.test(e.role)
        ? `participant ${e.role.slice(4)}`
        : /^:op\d+$/u.test(e.role)
          ? `part ${e.role.slice(3)}`
          : words(e.role.slice(1)));
    return inverse ? `as ${role} of` : role;
  };
  const seen = new Map(),
    entries = [];
  const forward = new Set([graph.top]);
  for (const id of forward) for (const e of edges) if (e.from === id) forward.add(e.to);
  function visit(id, incoming = null, parentId = null) {
    if (!nodes.has(id) || hidden.has(id)) return null;
    const identity = `${sourceId}#${id}`;
    const reference = seen.get(id);
    const item = {
      id: reference ? `${parentId}/reference/${encodeURIComponent(incoming.role)}/${id}` : identity,
      conceptId: identity,
      nodeId: id,
      memberIds: [id, ...(folded.get(id) ?? [])],
      name: labels.get(id),
      relation: incoming ? roleName(incoming, incoming.to !== id) : null,
      role: incoming?.role ?? null,
      relationProof: incoming?.proof ?? null,
      parentId,
      referenceTo: reference?.id ?? null,
      open: nodes.get(id).concept === 'amr-unknown',
      children: [],
    };
    entries.push(item);
    if (reference) return item;
    seen.set(id, item);
    const adjacent = edges.filter(
      (e) => e.from === id || (e.to === id && !forward.has(e.from) && !seen.has(e.from)),
    );
    adjacent.sort(
      (a, b) =>
        Number(a.from !== id) - Number(b.from !== id) ||
        a.role.localeCompare(b.role, undefined, { numeric: true }),
    );
    for (const e of adjacent) {
      if (e === incoming) continue;
      const child = visit(e.from === id ? e.to : e.from, e, item.id);
      if (child) item.children.push(child);
    }
    return item;
  }
  const roots = [];
  for (const id of [graph.top, ...nodes.keys()]) {
    if (seen.has(id) || hidden.has(id)) continue;
    const root = visit(id);
    if (root) roots.push(root);
  }
  return { roots, entries, grammar, sourceId, text };
}
