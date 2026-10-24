/** Public answer and evidence views over the same evaluated result. */
const concise = ({
  text,
  conditional,
  qualifications,
  dependsOn,
  readAs,
  sharedWording,
  reference,
  modalWord,
  wordForms,
  polarity,
}) => ({
  text,
  conditional,
  qualifications,
  ...(dependsOn ? { dependsOn } : {}),
  ...(readAs ? { readAs } : {}),
  ...(sharedWording ? { sharedWording } : {}),
  ...(reference ? { reference } : {}),
  ...(modalWord ? { modalWord } : {}),
  ...(wordForms ? { wordForms } : {}),
  ...(polarity ? { polarity } : {}),
});

const words = (concept) => concept.replace(/-\d+$/u, '').replaceAll('-', ' ');
/** How an answer read the question, for the readings named by a word or a
 * form; null for other answers. */
export function readingNote(answer, [open, close] = ['“', '”']) {
  if (answer.readAs === 'modal-word')
    return `The question and the source both say ${open}${answer.modalWord}${close}; read as in the source.`;
  if (answer.readAs === 'word-form')
    return answer.wordForms
      .map(({ asked, read }) =>
        words(asked) === words(read)
          ? `The question's ${open}${words(asked)}${close} is read in the source's sense.`
          : `The question's ${open}${words(asked)}${close} is read as the source's ${open}${words(read)}${close}.`,
      )
      .join(' ');
  return null;
}

function supportingInterpretations(answer, rules) {
  const facts = new Map(answer.facts.map((fact) => [fact.id, fact]));
  const visited = new Set(),
    order = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    const fact = facts.get(id);
    for (const premise of fact.premises ?? []) visit(premise);
    if (fact.ruleId) order.add(fact.ruleId);
  };
  for (const fact of answer.facts) visit(fact.id);
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  return [...order].map((id) => ({
    ...byId.get(id),
    sourceIds: [
      ...new Set(
        answer.facts.filter((fact) => fact.ruleId === id).flatMap((fact) => fact.sourceIds),
      ),
    ],
  }));
}

export function answerOutput(result, knowledge = {}, { explain = false } = {}) {
  const unique = (answers) => [
    ...new Map(
      answers.map((answer) => {
        const value = concise(answer);
        return [JSON.stringify(value), value];
      }),
    ).values(),
  ];
  const output = {
    question: result.question,
    status: result.status,
    answers: unique(result.answers),
    candidates: unique(result.candidates),
    complete: result.complete,
  };
  if (result.skipped.length) output.unavailable = result.skipped;
  if (result.openings?.length) output.openings = result.openings;
  if (result.reasoning) {
    const reasoning = result.reasoning;
    output.reasoning = {
      runId: reasoning.runId,
      status: reasoning.status,
      elapsedMs: reasoning.elapsedMs,
      answer: reasoning.answer,
      traceStatus: reasoning.traceStatus,
      policy: reasoning.policy,
      candidates: reasoning.candidates.map(({ text, sourceId, relevance, standing }) => ({
        text,
        sourceId,
        relevance,
        standing,
      })),
      openings: reasoning.openings,
      coverage: reasoning.coverage,
    };
    if (explain)
      Object.assign(output.reasoning, {
        candidates: reasoning.candidates,
        chains: reasoning.chains,
        applications: reasoning.applications,
        stages: reasoning.stages,
        calls: reasoning.calls,
        inputRef: reasoning.inputRef,
        resultRef: reasoning.resultRef,
        selectedFit: reasoning.selectedFit,
      });
  }
  if (!explain) return output;
  const stack = (answer) => {
    const sources = new Set(answer.sourceIds);
    const interpretationIds = [
      ...answer.ruleIds,
      ...result.questionParses.map((parse) => parse.id),
    ];
    return {
      ...concise(answer),
      basis: result.basis.filter((entry) =>
        interpretationIds.some((id) => id.startsWith(`${entry.id}/`)),
      ),
      sources: result.sources.filter((source) => sources.has(source.id)),
      interpretations: supportingInterpretations(answer, result.rules),
      sourceParses: answer.parses.map(({ id, sourceId }) => {
        const parse = knowledge.parses?.find((item) => item.id === id);
        return {
          id,
          sourceId,
          name: parse?.name,
          actor: parse?.actor,
          attribution: parse?.attribution,
          sourceRevision: parse?.sourceRevision,
          edits: parse?.edits,
        };
      }),
    };
  };
  output.evidence = {
    answers: result.answers.map(stack),
    candidates: result.candidates.map(stack),
    questionParses: result.questionParses,
    ...(result.openings?.length
      ? {
          sources: result.sources.filter((source) =>
            result.openings.some((opening) => opening.sourceIds?.includes(source.id)),
          ),
          interpretations: result.rules.filter((rule) =>
            result.openings.some((opening) => opening.ruleIds?.includes(rule.id)),
          ),
        }
      : {}),
  };
  return output;
}
