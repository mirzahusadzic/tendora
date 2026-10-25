/** Revisit persistent open contributions by graph context, never by question text. */
import { connectQuestion } from '../amr/development.mjs';
import { withoutWikiLinks } from '../amr/roles.mjs';

export function relatedContributions(contributions, query) {
  return (contributions ?? []).flatMap((c) => {
    if (
      !c.question ||
      c.responses.some((r) => !r.withdrawn && r.composition?.connection !== 'unresolved')
    )
      return [];
    const aporias = (c.partial?.aporias ?? c.partial?.openings ?? []).filter(
      (opening) => opening.state !== 'supported' && opening.anchor,
    );
    const nodes = new Map(c.question.graph.nodes.map((node) => [node.id, node]));
    const generic = new Set(['person', 'thing', 'and', 'amr-unknown', 'amr-empty']);
    const concepts = new Set(
      query.nodes.filter((node) => !generic.has(node.concept)).map((node) => node.concept),
    );
    const anchored = aporias.filter((opening) => {
      const ids =
        opening.anchor.kind === 'edge'
          ? [opening.anchor.from, opening.anchor.to]
          : [opening.anchor.nodeId];
      return ids.some((id) => {
        const concept = nodes.get(id)?.concept;
        return concept && !generic.has(concept) && concepts.has(concept);
      });
    });
    if (anchored.length)
      return anchored.map((opening) => ({
        id: opening.id ?? opening.identity,
        identity: opening.identity,
        kind: 'aporia',
        contributionId: c.id,
        text: c.question.text,
        anchor: opening.anchor,
        scope: opening.scope ?? c.scopePlacementId,
        state: opening.state,
        reason:
          opening.reason ?? 'A related partial contribution retains this concrete open connection.',
      }));
    for (const reading of [
      c.question,
      ...c.wordings.filter((w) => !w.withdrawn),
      ...(c.partial?.parts ?? []).filter((part) => part.graph),
    ]) {
      // Like the prepared query, a saved reading is matched without its :wiki links.
      const graph = withoutWikiLinks(reading.graph);
      let match = connectQuestion(graph, query, { partial: true });
      if (!match.matches.length) match = connectQuestion(query, graph, { partial: true });
      if (!match.complete || !match.matches.length) continue;
      if (aporias.length)
        return aporias.map((opening) => ({
          id: opening.id ?? opening.identity,
          identity: opening.identity,
          kind: 'aporia',
          contributionId: c.id,
          text: c.question.text,
          anchor: opening.anchor,
          scope: opening.scope ?? c.scopePlacementId,
          state: opening.state,
          reason:
            opening.reason ??
            'A related partial contribution retains this concrete open connection.',
          derivation: match.matches[0].derivation,
        }));
      return [
        {
          id: `aporia:${c.id}`,
          kind: 'aporia',
          contributionId: c.id,
          text: c.question.text,
          anchor: c.anchor ?? null,
          reason: c.partial?.parts?.length
            ? 'A related partial contribution retains source support and open connections. Recheck its current evidence before developing it.'
            : c.responses.some((r) => !r.withdrawn)
              ? 'The statement is saved; it does not yet establish every connection in this question.'
              : 'This question is saved without an answer. Develop it when supporting material is available.',
          derivation: match.matches[0].derivation,
        },
      ];
    }
    return [];
  });
}
