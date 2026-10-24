/** A kind statement read as an extension (Björklund, Drewes & Jonsson 2023,
 * graph extension grammars): a context node is fused with any existing node
 * that a local condition allows, and new structure is placed on it.
 *
 * “Shared work is joint work.” is read `work :mod joint :domain (work :ARG1-of
 * share)`, prepared as its inverse: the subject `:mod` the claim. The
 * subject's description is the condition, bounded by the
 * sentence; every node it fits, in any statement, gains the predicate's
 * description: the programmer's shared work is joint work. One way only:
 * what is joint is not thereby shared.
 *
 * Kinds only. A statement that is negated, asked, conditional, modal, named,
 * counted or about a pronoun says something of a particular, not of a kind,
 * and extends nothing; nor does one whose two sides share a participant.
 *
 * One way needs the right way. A reader may put the predicate where the
 * subject is (“The joy of making is a closed loop …” read as the loop being
 * joy), so the reading must agree with the sentence: the words only the
 * subject's side has come before the copula, those only the predicate's side
 * has after it. When the text cannot tell, nothing is extended.
 */
import { claimRoot } from './claims.mjs';
import { sourceSemanticTypes } from './semantic-types.mjs';

const pronouns = new Set(['i', 'you', 'he', 'she', 'it', 'we', 'they']);
// Abstract heads and connectives have no words of their own.
const unworded = new Set(['person', 'thing', 'and', 'or']);
const stem = (concept) => {
  const word = concept.replace(/-\d+$/u, '').split('-')[0].toLowerCase();
  return word.slice(0, Math.min(word.length, Math.max(4, word.length - 3)));
};
/** Where the sentence says a concept: the first word that starts with its stem. */
const position = (text, concept) => {
  const at = [
    ...String(text)
      .toLowerCase()
      .matchAll(/[\p{L}\p{N}]+/gu),
  ].find((word) => word[0].startsWith(stem(concept)));
  return at ? at.index : null;
};
const particular = new Set([
  ':name',
  ':wiki',
  ':quant',
  ':polarity',
  ':condition',
  ':concession',
  ':mode',
]);

export function kindReading(graph, text) {
  const root = claimRoot(graph);
  // The copula: the claim :domain its subject, or as prepared, the subject
  // :mod the claim. Nothing else points at a claim root.
  const copulas = [
    ...graph.edges.filter((edge) => edge.from === root && edge.role === ':domain'),
    ...graph.edges.filter((edge) => edge.to === root && edge.role === ':mod'),
  ];
  if (copulas.length !== 1 || graph.edges.some((edge) => edge.to === root && edge !== copulas[0]))
    return null;
  const copula = copulas[0];
  if (graph.edges.some((edge) => particular.has(edge.role))) return null;
  if (
    graph.nodes.some(
      (node) =>
        node.concept === 'amr-unknown' || pronouns.has(node.concept) || node.literal !== undefined,
    )
  )
    return null;
  const subject = copula.role === ':domain' ? copula.to : copula.from,
    edges = graph.edges.filter((edge) => edge !== copula);
  const reach = (start, stop) => {
    const seen = new Set([start]);
    for (const id of seen)
      for (const edge of edges) {
        const next = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
        if (next !== null && next !== stop) seen.add(next);
      }
    return seen;
  };
  const described = reach(subject, root),
    predicated = reach(root, subject);
  if ([...described].some((id) => predicated.has(id))) return null;
  if (graph.nodes.some((node) => !described.has(node.id) && !predicated.has(node.id))) return null;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const copulaAt = String(text).search(/\b(?:is|are)\b/iu);
  const words = (ids, others) => {
    const own = [...ids].map((id) => nodes.get(id).concept).filter((c) => !unworded.has(c));
    const theirs = new Set([...others].map((id) => nodes.get(id).concept).map((c) => stem(c)));
    return own.filter((c) => !theirs.has(stem(c))).map((c) => position(text, c));
  };
  const before = words(described, predicated),
    after = words(predicated, described);
  if (
    copulaAt < 0 ||
    !before.length ||
    !after.length ||
    before.some((at) => at === null || at > copulaAt) ||
    after.some((at) => at === null || at < copulaAt)
  )
    return null;
  const names = new Map(
    graph.nodes.map((node, index) => [node.id, `${described.has(node.id) ? '?' : '$'}k${index}`]),
  );
  // The predicate's head is the subject itself: what it is said to be.
  names.set(root, names.get(subject));
  const within = (ids) =>
    edges
      .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      .map((edge) => [names.get(edge.from), edge.role, names.get(edge.to)]);
  const when = [
    ...[...described].map((id) => [names.get(id), ':instance', nodes.get(id).concept]),
    ...within(described),
  ];
  const sameKind = nodes.get(root).concept === nodes.get(subject).concept;
  const then = [
    ...[...predicated]
      .filter((id) => id !== root || !sameKind)
      .flatMap((id) => {
        const node = nodes.get(id);
        return [
          [names.get(id), ':instance', node.concept],
          ...sourceSemanticTypes(node).map((type) => [names.get(id), '@semanticType', type]),
          ...(id !== root && (node.authoredLabel || node.surfaceLabel)
            ? [[names.get(id), '@label', node.authoredLabel ?? node.surfaceLabel]]
            : []),
        ];
      }),
    ...within(predicated),
  ];
  if (!then.length) return null;
  return { when, then, subject: names.get(subject) };
}
