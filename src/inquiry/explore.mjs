/** Source-first AMR/embedding exploration. This returns attributed graph
 * candidates and openings, not an answer, observation, or Ranvier return.
 * The caller chooses the source and renders the result.
 */
import { acquire, dot } from '../models/acquisition.mjs';
import { focus } from '../amr/graph.mjs';
import {
  path,
  showPath,
  sharedPath,
  localOpening,
  visibleScope,
  focusArgumentPath,
} from '../amr/diagnostics.mjs';
import { inspectConjunction, inspectFocus } from '../amr/audit.mjs';
import { queryRetention } from '../amr/retention.mjs';

/** The reusable operation: exact English in, attributed candidates out.
 * Parsing and embedding are acquired for non-exact inquiries. Every source
 * passage is inspected; affinity orders them but does not exclude any.
 */
export async function explore({ sentences, queries }, progress = () => {}) {
  if (
    !Array.isArray(sentences) ||
    !sentences.length ||
    sentences.some((value) => typeof value !== 'string' || !value.trim()) ||
    !Array.isArray(queries) ||
    !queries.length ||
    queries.some((value) => typeof value !== 'string' || !value.trim())
  ) {
    throw new Error('explore needs nonempty English sentences and queries');
  }
  const exactIndexes = queries.map((text) =>
    sentences.flatMap((sentence, s) => (sentence === text ? [s] : [])),
  );
  // Exact source presence needs no model. A mixed batch still acquires graphs
  // for its other inquiries, but exact hits never become retrieval neighbors.
  if (exactIndexes.every((indexes) => indexes.length)) {
    return {
      source: sentences.map((text) => ({ text, amr: null })),
      inquiries: queries.map((text, q) => ({
        text,
        amr: null,
        exactSourceIndexes: exactIndexes[q],
        focus: null,
        candidates: [],
        opening: null,
      })),
      models: null,
    };
  }
  const texts = [...sentences, ...queries];
  const { parsed, views, vectors, models } = await acquire(texts, progress);
  const sourceViews = views.slice(0, sentences.length);
  const inquiries = queries.map((text, q) => {
    const amr = parsed[sentences.length + q];
    const query = views[sentences.length + q];
    // Exact source identity is stronger than a retrieved graph fragment. Keep
    // every identical source position, and do not show unrelated neighbors.
    // This attests only that the utterance is present, not that it is true.
    const exactSourceIndexes = exactIndexes[q];
    if (exactSourceIndexes.length)
      return {
        text,
        amr,
        exactSourceIndexes,
        focus: query ? query.labels.get(focus(query)) : null,
        candidates: [],
        opening: null,
      };
    if (!query)
      return {
        text,
        amr,
        focus: null,
        candidates: [],
        opening: 'query AMR invalid; retain the English inquiry',
      };
    const ranked = sentences
      .map((_, s) => ({ s, affinity: dot(vectors[s], vectors[sentences.length + q]) }))
      .sort((a, b) => b.affinity - a.affinity);
    const retention = queryRetention(text, query);
    if (retention.status === 'no-content-anchor') {
      // Retrieval may still suggest source passages, but the parsed graph has
      // lost the English inquiry's content. Do not turn its nodes into carry.
      return {
        text,
        amr,
        focus: null,
        parseLoss: retention,
        candidates: ranked.map(({ s, affinity }) => ({ sourceIndex: s, affinity })),
        opening: null,
      };
    }
    const candidates = ranked.map(({ s, affinity }) => {
      const source = views[s];
      if (!source)
        return {
          sourceIndex: s,
          affinity,
          opening: 'source AMR invalid; retain the English sentence',
        };
      const witness = sharedPath(query, source);
      const sourceFocus = [...source.labels].find(
        ([, label]) => label === query.labels.get(focus(query)),
      )?.[0];
      const argument = focusArgumentPath(query, source);
      return {
        sourceIndex: s,
        affinity,
        sharedPath: witness ? showPath(source, witness.sa, witness.sp) : null,
        queryPath: witness ? showPath(query, witness.qa, witness.qp) : null,
        sameRoles: witness?.sameRoles ?? null,
        sameConcepts: witness?.sameConcepts ?? null,
        pathIncludesFocus: witness?.touchesFocus ?? null,
        rootPath: sourceFocus
          ? showPath(source, source.top, path(source, source.top, sourceFocus))
          : null,
        argumentPath: argument
          ? {
              label: argument.label,
              text: showPath(source, argument.start, argument.steps),
              queryRole: argument.role,
              edges: argument.steps.length,
            }
          : null,
        scope: visibleScope(source),
        opening: localOpening(query, source),
      };
    });
    const conjunction = inspectConjunction(query, sourceViews);
    return {
      text,
      amr,
      focus: query.labels.get(focus(query)),
      candidates,
      parseWarning: retention.status === 'uncertain' ? retention : null,
      conjunction,
      focusAudit: conjunction ? null : inspectFocus(query, sourceViews, focus(query)),
      opening: null,
    };
  });
  return { source: sentences.map((text, i) => ({ text, amr: parsed[i] })), inquiries, models };
}
