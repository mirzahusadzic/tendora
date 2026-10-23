/** Lexical evidence for acquired predicates, not a semantic correctness test. */
export const lexicalAuditProfile = 'amr-propbank-lexical-v3';
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
const units =
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(
    ' ',
  );
const counted = Object.fromEntries([
  ...'twenty thirty forty fifty sixty seventy eighty ninety'
    .split(' ')
    .map((word, i) => [word, 20 + i * 10]),
  ...'first second third fourth fifth sixth seventh eighth ninth tenth'
    .split(' ')
    .map((word, i) => [word, i + 1]),
  ...'january february march april may june july august september october november december'
    .split(' ')
    .map((word, i) => [word, i + 1]),
  ['once', 1],
  ['twice', 2],
  ['thrice', 3],
  ['dozen', 12],
  ['half', 0.5],
]);
const clock = (hour, minute = '00') => `${hour}:${minute}`;
/** Numbers and clock times a text gives, in digits or words. A reading's
 * number or time is checked against these; nothing is inferred beyond them.
 */
function givenValues(text) {
  const numbers = new Set(),
    times = new Set();
  for (const match of text.matchAll(/\d+(?:\.\d+)?/gu)) numbers.add(Number(match[0]));
  for (const match of text.matchAll(/\b(\d{1,2}):(\d{2})\b/gu))
    times.add(clock(Number(match[1]), match[2]));
  const tokens = tokensOf(text);
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i].word,
      next = tokens[i + 1];
    let value = units.includes(word)
      ? units.indexOf(word)
      : (counted[word] ?? (/^\d+$/u.test(word) ? Number(word) : undefined));
    if (value === undefined) continue;
    // “sixty-four” and “sixty four” give 64, not 60.
    if (
      word in counted &&
      counted[word] >= 20 &&
      units.indexOf(next?.word) > 0 &&
      /^[-\s]$/u.test(text.slice(tokens[i].end, next.start))
    ) {
      value += units.indexOf(next.word);
      i++;
    }
    numbers.add(value);
    if (Number.isInteger(value) && value >= 1 && value <= 12) {
      const after = tokens
        .slice(i + 1, i + 4)
        .map((token) => token.word)
        .join(' ');
      const pm = /^(?:in the (?:afternoon|evening)|pm|p m)\b/u.test(after),
        am = /^(?:in the morning|am|a m)\b/u.test(after);
      if (!am) times.add(clock((value % 12) + 12));
      if (!pm) times.add(clock(value % 12 || (am ? 0 : 12)));
    }
  }
  if (/\bnoon\b/iu.test(text)) times.add(clock(12));
  if (/\bmidnight\b/iu.test(text)) times.add(clock(0));
  return { numbers, times };
}
/** Replace a number or clock time the text does not give with the one it
 * does, when the text leaves exactly one: “sixty-four percent” read as 60.4
 * becomes 64. Anything less certain stays as acquired, for review.
 */
export function repairReading(text, graph, checks) {
  const given = givenValues(text),
    repairs = [];
  const literalValue = (node) => String(node.literal).replace(/^"|"$/gu, '');
  for (const [kind, values, key] of [
    ['A number', given.numbers, (value) => Number(value)],
    [
      'A clock time',
      given.times,
      (value) => clock(...value.split(':').map((v, i) => (i ? v : Number(v)))),
    ],
  ]) {
    const wrong = checks.filter((c) => c.status === 'unattested' && c.description === kind);
    if (wrong.length !== 1) continue;
    const used = new Set(
      graph.nodes
        .filter((n) => n.literal !== undefined && n.id !== wrong[0].nodeId)
        .map((n) => literalValue(n))
        .filter((value) =>
          (kind === 'A number' ? /^\d+(?:\.\d+)?$/u : /^\d{1,2}:\d{2}$/u).test(value),
        )
        .map(key),
    );
    const left = [...values].filter((value) => !used.has(value));
    if (left.length !== 1) continue;
    const node = graph.nodes.find((n) => n.id === wrong[0].nodeId);
    const to = String(left[0]);
    repairs.push({
      nodeId: node.id,
      from: literalValue(node),
      to,
      reason: `The text gives ${to}, not ${literalValue(node)}.`,
    });
  }
  if (!repairs.length) return { graph, repairs };
  const changed = new Map(repairs.map((r) => [r.nodeId, r.to]));
  return {
    graph: {
      ...graph,
      nodes: graph.nodes.map((n) =>
        changed.has(n.id)
          ? {
              ...n,
              concept: changed.get(n.id),
              literal: String(n.literal).startsWith('"')
                ? JSON.stringify(changed.get(n.id))
                : changed.get(n.id),
            }
          : n,
      ),
    },
    repairs,
  };
}
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
    let given;
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
        else {
          // AMR spells “a”, “daily” and “each” as 1, so 1 needs no word.
          const value = String(node.literal).replace(/^"|"$/gu, ''),
            time = value.match(/^(\d{1,2}):(\d{2})$/u);
          given ??= givenValues(text);
          if (
            time
              ? !given.times.has(clock(Number(time[1]), time[2]))
              : /^\d+(?:\.\d+)?$/u.test(value) &&
                Number(value) !== 1 &&
                !given.numbers.has(Number(value))
          )
            checks.push({
              nodeId: node.id,
              predicate: value,
              status: 'unattested',
              description: time ? 'A clock time' : 'A number',
            });
        }
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
    const findings = checks.filter((check) =>
      ['unverified', 'unlisted', 'unattested'].includes(check.status),
    );
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
          check.status === 'unattested'
            ? `The reading has ${check.predicate}, but the text gives no such ${check.description === 'A clock time' ? 'time' : 'number'}.`
            : check.status === 'unlisted'
              ? `${check.predicate} is not listed in PropBank ${resource.source.release}; frame inventories may differ.`
              : `${check.predicate} has no matched source word, PropBank alias or attested predicate form. The reading is unverified; an implicit or abstract expression is also possible.`,
      })),
    };
  };
}
