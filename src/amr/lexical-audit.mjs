/** Lexical evidence for acquired predicates, not a semantic correctness test. */
export const lexicalAuditProfile = 'amr-propbank-lexical-v2';
const tokensOf = (text) =>
  [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)].map((match) => ({
    text: match[0],
    word: match[0].normalize('NFKC').toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
const normalized = (text) =>
  tokensOf(text)
    .map((token) => token.word)
    .join(' ');
const predicate = /^(.+)-(\d{2})$/u;
// Only candidate hints omit closed-class words. Actual predicate checks still
// examine every source token, including auxiliaries and pronouns.
const functionWords = new Set(
  'a an the to of for in on at by from as with and or but if when while that this these those i me my you your he him his she her it its we our they their who what which where how why do does did done be is are was were been being have has had having can could may might will would shall should must'.split(
    ' ',
  ),
);
// These AMR operators can be expressed by function words or grammatical
// constructions. Absence of their spelling does not diagnose a lexical error.
const operators = new Set([
  'possible-01',
  'obligate-01',
  'recommend-01',
  'cause-01',
  'contrast-01',
]);
const regularForms = (word) => {
  const forms = new Set([word, word + 's', word + 'ed', word + 'ing']);
  if (/(?:s|x|z|ch|sh|o)$/u.test(word)) forms.add(word + 'es');
  if (/[^aeiou]y$/u.test(word)) {
    forms.add(word.slice(0, -1) + 'ies');
    forms.add(word.slice(0, -1) + 'ied');
  }
  if (word.endsWith('e')) {
    forms.add(word + 'd');
    forms.add(word.slice(0, -1) + 'ing');
  }
  if (word.endsWith('ie')) forms.add(word.slice(0, -2) + 'ying');
  if (/[^aeiou][aeiou][^aeiouwxy]$/u.test(word))
    for (const suffix of ['ed', 'ing']) forms.add(word + word.at(-1) + suffix);
  return forms;
};

/** PropBank aliases and annotated predicate surfaces are read-only lexical data.
 * The caller owns resource loading; this module performs no I/O or model calls.
 */
export function createLexicalAuditor(resource) {
  const lexemes = new Map(),
    lengths = new Set();
  for (const [frame, [, aliases]] of Object.entries(resource.frames))
    for (const form of new Set(aliases)) {
      const lexeme = normalized(form);
      if (!lexeme) continue;
      const [head, ...tail] = lexeme.split(' ');
      for (const first of regularForms(head)) {
        const surface = [first, ...tail].join(' ');
        if (!lexemes.has(surface)) lexemes.set(surface, new Map());
        const entries = lexemes.get(surface);
        // Prefer a literal dictionary alias over an inferred inflection when
        // multiple aliases of the same frame yield the same surface.
        if (!entries.has(frame) || surface === lexeme)
          entries.set(frame, {
            lexeme: form,
            method: surface === lexeme ? 'propbank-lexeme' : 'propbank-inflection',
          });
      }
      lengths.add(tail.length + 1);
    }
  const maxLength = Math.max(...lengths);

  return (text, graph) => {
    const tokens = tokensOf(text),
      used = new Set(),
      checks = [],
      stats = { fastMatches: 0, dictionaryChecks: 0, dictionaryMatches: 0 };
    const evidence = (first, count, lexeme, method) => ({
      text: text.slice(tokens[first].start, tokens[first + count - 1].end),
      start: tokens[first].start,
      end: tokens[first + count - 1].end,
      lexeme,
      method,
    });
    const find = (lexeme, method, inflect = true) => {
      const words = normalized(lexeme).split(' ');
      if (!words[0]) return null;
      // Inflect the first word of a multiword predicate; particles stay fixed.
      const first = inflect ? regularForms(words[0]) : new Set([words[0]]);
      for (let i = 0; i + words.length <= tokens.length; i++)
        if (
          first.has(tokens[i].word) &&
          words.slice(1).every((word, j) => word === tokens[i + j + 1].word)
        )
          return evidence(i, words.length, lexeme, method);
      return null;
    };
    const consume = (match) => {
      for (let i = 0; i < tokens.length; i++)
        if (tokens[i].start >= match.start && tokens[i].end <= match.end) used.add(i);
    };
    for (const node of graph.nodes) {
      if (node.literal !== undefined) {
        const match = find(String(node.literal), 'literal', false);
        if (match) consume(match);
        continue;
      }
      const parts = node.concept.match(predicate);
      if (!parts) {
        const match = find(node.concept, 'concept');
        if (match) consume(match);
        continue;
      }
      const [, lemma, sense] = parts;
      if (sense === '91') {
        checks.push({ nodeId: node.id, predicate: node.concept, status: 'structural' });
        continue;
      }
      const frame = resource.frames[node.concept];
      let match = find(lemma, 'surface');
      if (match) stats.fastMatches++;
      else if (frame) {
        stats.dictionaryChecks++;
        for (const [forms, method, inflect] of [
          [frame[1], 'propbank-alias', true],
          [frame[2], 'propbank-example', false],
        ]) {
          for (const form of forms) {
            match = find(form, method, inflect);
            if (match) break;
          }
          if (match) break;
        }
        if (match) stats.dictionaryMatches++;
      }
      if (!match && frame) {
        // AMR uses predicate roles to encode agent nouns and -able adjectives.
        // These remain weak morphological evidence, not sense validation.
        const stems = new Set([lemma, lemma.replace(/e$/u, ''), lemma.replace(/y$/u, 'i')]);
        if (/[^aeiou][aeiou][^aeiouwxy]$/u.test(lemma)) stems.add(lemma + lemma.at(-1));
        const suffixes = [
          'al',
          'ance',
          'ence',
          'ment',
          'tion',
          'sion',
          'ship',
          'ity',
          'ness',
          'ability',
          'ibility',
        ];
        if (graph.edges.some((e) => e.from === node.id && e.role === ':ARG0'))
          suffixes.push('er', 'or', 'ator', 'ant', 'ent');
        if (
          graph.edges.some(
            (e) =>
              e.to === node.id &&
              e.role === ':ARG1' &&
              graph.nodes.some((n) => n.id === e.from && n.concept === 'possible-01'),
          )
        )
          suffixes.push('able', 'ible');
        for (const stem of stems)
          for (const suffix of suffixes) match ??= find(stem + suffix, 'morphology');
        if (
          !match &&
          graph.edges.some(
            (edge) =>
              edge.from === node.id &&
              edge.role === ':polarity' &&
              graph.nodes.some((n) => n.id === edge.to && n.concept === '-'),
          )
        )
          for (const form of new Set([...regularForms(lemma), ...frame[1], ...frame[2]]))
            match ??= find('un' + form, 'negative-morphology', false);
      }
      if (match) consume(match);
      checks.push({
        nodeId: node.id,
        predicate: node.concept,
        status: !frame
          ? 'unlisted'
          : match
            ? 'related'
            : operators.has(node.concept)
              ? 'operator'
              : 'unverified',
        ...(match ? { evidence: match } : {}),
        ...(frame ? { description: frame[0], roles: frame[3], files: frame[4] } : {}),
      });
    }
    const findings = checks.filter((check) => ['unverified', 'unlisted'].includes(check.status));
    const candidates = [];
    if (findings.length)
      for (let i = 0; i < tokens.length; i++)
        for (let count = 1; count <= Math.min(maxLength, tokens.length - i); count++) {
          if (Array.from({ length: count }, (_, j) => i + j).some((j) => used.has(j))) continue;
          const lexeme = tokens
            .slice(i, i + count)
            .map((t) => t.word)
            .join(' ');
          if (functionWords.has(lexeme)) continue;
          for (const [frame, match] of lexemes.get(lexeme) ?? []) {
            if (
              graph.nodes.some(
                (n) => n.concept === frame || n.concept === frame.replace(/-\d{2}$/u, ''),
              )
            )
              continue;
            const [description, , , roles, files] = resource.frames[frame];
            candidates.push({
              predicate: frame,
              description,
              roles,
              files,
              evidence: evidence(i, count, match.lexeme, match.method),
            });
          }
        }
    return {
      profile: lexicalAuditProfile,
      checks,
      candidates,
      stats,
      findings: findings.map((check) => ({
        ...check,
        reason:
          check.status === 'unlisted'
            ? `${check.predicate} is not listed in PropBank ${resource.source.release}; frame inventories may differ.`
            : `${check.predicate} has no matched source word, PropBank alias or attested predicate form. The reading is unverified; an implicit or abstract expression is also possible.`,
      })),
    };
  };
}
