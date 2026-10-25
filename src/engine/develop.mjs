/** Acquire language once; compile and retain the author's question-driven contribution. */
import { randomUUID } from 'node:crypto';
import { parseTexts } from '../models/acquisition.mjs';
import { prepareGraphs, normalizedRoleProfile } from '../models/graph-preparation.mjs';
import { acquiredTexts, retainAcquisitions } from '../project/storage/acquisitions.mjs';
import {
  composeAnswer,
  compileWording,
  answerFromCarrier,
  connectQuestion,
} from '../amr/development.mjs';
import {
  validateContributions,
  contributionRevision,
  contributionTitle,
} from '../project/authoring/development.mjs';
import { validateGraph } from '../amr/revision.mjs';
import { propbankAuditor } from '../models/propbank.mjs';
import { labelReading } from '../amr/labels.mjs';

export async function readLanguage(
  project,
  text,
  { signal, progress = () => {}, offline = false } = {},
) {
  const started = performance.now();
  let retained = (await acquiredTexts(project, [text]))?.[0];
  const reused = retained?.status === 'retained';
  if (retained?.status !== 'retained') {
    if (offline)
      throw new Error('This text has no retained reading. Acquire it before working offline.');
    const parsed = await parseTexts([text], progress, signal).catch((error) => {
        error.client = 'AMR';
        throw error;
      }),
      result = parsed.results[0];
    if (result.decode_status !== 'ok' || !result.penman)
      throw new Error('Could not read this text.');
    await retainAcquisitions(project, [
      {
        text,
        penman: result.penman,
        acquisition: result,
        origin: { kind: 'development-acquisition', at: new Date().toISOString() },
      },
    ]);
    retained = (await acquiredTexts(project, [text]))[0];
  }
  const acquiredMs = performance.now() - started;
  const result = (
    await prepareGraphs([{ penman: retained.penman }], { signal, profile: normalizedRoleProfile })
  ).results[0];
  if (!result.ok)
    throw new Error('The acquired reading could not be prepared. Try a clearer sentence.');
  const { audit } = await propbankAuditor();
  const lexical = audit(text, result.graph);
  return {
    text,
    graph: labelReading(result.graph, text, lexical.checks),
    acquisition: {
      text,
      ref: retained.ref,
      penman: retained.penman,
      reused,
      acquiredMs,
      preparedMs: performance.now() - started - acquiredMs,
    },
  };
}

export function contributionContexts(data, question, scopePlacementId) {
  const found = [];
  for (const c of data.contributions ?? []) {
    if (c.scopePlacementId !== scopePlacementId) continue;
    const material = [...c.responses.filter((r) => !r.withdrawn), c.question].filter(Boolean);
    for (const r of material) {
      if (r === c.question && found.some((context) => context.contributionId === c.id)) continue;
      const result = connectQuestion(question, r.graph, { partial: true });
      const connections =
        result.branches.length === 1 && result.matches.length
          ? [{ root: question.top, ...result }]
          : result.branches;
      for (const connection of connections) {
        if (!connection.complete || connection.matches.length !== 1) continue;
        const variable = result.variables.get(connection.root),
          nodeId = connection.matches[0].values[variable],
          node = r.graph.nodes.find((candidate) => candidate.id === nodeId);
        if (!nodeId || !node) continue;
        found.push({
          contributionId: c.id,
          question: contributionTitle(c),
          questionNodeId: connection.root,
          partId: r.id ?? 'question',
          nodeId,
          revision: contributionRevision(r.graph),
          label:
            node.authoredLabel ??
            node.surfaceLabel ??
            node.concept.replace(/-\d+$/u, '').replaceAll('-', ' '),
          bindings: connection.matches[0].values,
          derivation: connection.matches[0].derivation,
        });
      }
    }
  }
  return found;
}

async function readResponse(project, question, text, options) {
  const value = text.trim();
  let reading = null;
  const truth = question && /^(yes|no)[.!]?$/iu.test(value) ? /^yes/iu.test(value) : null;
  if (truth === null) {
    reading = await readLanguage(project, value, options);
    if (question && reading.graph.nodes.some((n) => n.concept === 'amr-empty')) {
      const carrier = await readLanguage(
        project,
        `The answer is ${value.replace(/[.!?]+$/u, '')}.`,
        options,
      );
      reading = {
        text: value,
        graph: answerFromCarrier(carrier.graph),
        acquisition: carrier.acquisition,
      };
    }
  }
  const composed = question
    ? composeAnswer(question, reading?.graph, { truth, label: value })
    : { graph: validateGraph(reading.graph), operation: 'authored-statement' };
  if (
    !question &&
    composed.graph.nodes.some((n) => ['amr-unknown', 'amr-empty'].includes(n.concept))
  )
    throw Object.assign(new Error('This sentence has an unanswered part: ' + value), {
      code: 'OPEN_MATERIAL',
      text: value,
    });
  return {
    id: randomUUID(),
    text: value,
    graph: composed.graph,
    composition: composed,
    ...(reading ? { acquisition: reading.acquisition } : {}),
    at: new Date().toISOString(),
    ...authorship(options),
  };
}

/** Who wrote a statement (`actor`: a label, not a verified identity;
 * "unrecorded" when the caller names none) and through what (`via`: a library
 * call unless the caller says), recorded when it is written. */
const authorship = ({ actor = 'unrecorded', via = 'library' } = {}) => ({ actor, via });

export const materialSentences = (text) =>
  [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);

/** A paragraph contributes independent attributed statements, without an invented question. */
export async function addMaterial(
  project,
  { text, scopePlacementId, anchor = null },
  options = {},
) {
  const sentences = materialSentences(text);
  if (!sentences.length) throw new Error('Write a statement to save. Nothing has been changed.');
  if (!project.data.placements.some((p) => p.id === scopePlacementId))
    throw new Error('Choose where this material belongs.');
  const responses = [];
  for (const sentence of sentences)
    responses.push(await readResponse(project, null, sentence, options));
  const c = {
    version: 1,
    kind: 'material',
    id: randomUUID(),
    scopePlacementId,
    question: null,
    responses,
    wordings: [],
    ...(anchor ? { anchor } : {}),
  };
  const data = structuredClone(project.data);
  (data.contributions ??= []).push(c);
  validateContributions(data);
  return { data, contribution: c };
}

export async function reviseMaterial(project, { contributionId, text }, options = {}) {
  const c = project.data.contributions.find((c) => c.id === contributionId);
  if (!c || c.question) throw new Error('Choose a material contribution to edit.');
  const remaining = materialSentences(text),
    edits = [];
  for (const r of c.responses.filter((r) => !r.withdrawn)) {
    const at = remaining.indexOf(r.text);
    edits.push({ id: r.id, text: at < 0 ? '' : remaining.splice(at, 1)[0] });
  }
  edits.push(...remaining.map((text) => ({ id: null, text })));
  return reviseContribution(project, { contributionId, question: null, responses: edits }, options);
}

export async function developContribution(
  project,
  {
    scopePlacementId,
    question,
    answer = '',
    contributionId = null,
    wording = false,
    perspective = false,
    basisResponseId = null,
    answerNodeId = null,
    answerNodeIds = {},
    replaceResponseId = null,
    origin = null,
    anchor = null,
  },
  options = {},
) {
  const data = structuredClone(project.data);
  let c = data.contributions?.find((c) => c.id === contributionId);
  if (contributionId && !c) throw new Error('Contribution unavailable.');
  const replaced =
    replaceResponseId && c?.responses.find((r) => r.id === replaceResponseId && !r.withdrawn);
  if (replaceResponseId && (!replaced || !answer.trim() || wording || perspective))
    throw new Error('Choose an active source contribution to revise.');
  if (!c) {
    const reading = await readLanguage(project, question.trim(), options);
    if (reading.graph.nodes.some((n) => n.concept === 'amr-empty'))
      throw new Error('Write a complete question to develop.');
    const contexts = contributionContexts(data, reading.graph, scopePlacementId);
    c = {
      version: 1,
      id: randomUUID(),
      scopePlacementId,
      question: reading,
      responses: [],
      wordings: [],
      ...(origin ? { origin } : {}),
      ...(anchor ? { anchor } : contexts.length === 1 ? { anchor: contexts[0] } : {}),
      ...(contexts.length > 1 ? { candidates: contexts } : {}),
    };
    (data.contributions ??= []).push(c);
  }
  if (wording || perspective) {
    if (wording && !c.question)
      throw new Error('Choose a question before declaring another wording.');
    const reading = await readLanguage(project, question.trim(), options);
    const basis = perspective && c.responses.find((r) => !r.withdrawn && r.id === basisResponseId);
    if (perspective && !basis)
      throw new Error('Choose an active contribution for this perspective.');
    c.wordings.push({
      id: randomUUID(),
      ...reading,
      ...authorship(options),
      ...(perspective
        ? {
            kind: 'perspective',
            basisResponseId,
            ...(answerNodeId ? { answerNodeId } : {}),
            ...(Object.keys(answerNodeIds).length ? { answerNodeIds } : {}),
            rule: compileWording(basis.graph, reading.graph, {
              perspective: true,
              answerNodeId,
              answerNodeIds,
            }),
          }
        : {
            rule: compileWording(c.question.graph, reading.graph),
            reverseRule: compileWording(reading.graph, c.question.graph),
          }),
    });
  } else if (answer.trim()) {
    c.responses.push({
      ...(await readResponse(project, c.question?.graph, answer, options)),
      ...(replaced ? { replaces: replaced.id } : {}),
    });
    if (replaced) replaced.withdrawn = true;
  }
  validateContributions(data);
  return { data, contribution: c };
}

/** Save the language shown in the contribution editor as one atomic revision. */
export async function reviseContribution(
  project,
  { contributionId, question, responses },
  options = {},
) {
  const data = structuredClone(project.data),
    c = data.contributions?.find((c) => c.id === contributionId);
  if (!c) throw new Error('Contribution unavailable.');
  for (const dependent of data.contributions ?? []) {
    if (
      dependent.anchor?.contributionId !== c.id ||
      dependent.anchor.revision ||
      !dependent.question
    )
      continue;
    const basis =
      dependent.anchor.partId === 'question'
        ? c.question
        : c.responses.find((response) => response.id === dependent.anchor.partId);
    if (!basis) continue;
    const alignment = connectQuestion(dependent.question.graph, basis.graph, { partial: true }),
      variable = alignment.variables.get(dependent.question.graph.top),
      nodeId = dependent.anchor.nodeId ?? dependent.anchor.bindings?.[variable];
    Object.assign(dependent.anchor, {
      ...(nodeId ? { nodeId } : {}),
      revision: contributionRevision(basis.graph),
    });
  }
  if (c.question && !question?.trim()) throw new Error('Question is required.');
  const active = c.responses.filter((r) => !r.withdrawn);
  if (
    !Array.isArray(responses) ||
    responses.some((r) => typeof r.text !== 'string') ||
    active.some((r) => responses.filter((edit) => edit.id === r.id).length !== 1) ||
    responses.some((r) => r.id && !active.some((old) => old.id === r.id))
  )
    throw new Error('The contribution changed. Reopen its editor.');
  const questionChanged = Boolean(c.question && question.trim() !== c.question.text),
    previousQuestion = c.question;
  if (questionChanged) {
    const reading = await readLanguage(project, question.trim(), options);
    if (reading.graph.nodes.some((n) => n.concept === 'amr-empty'))
      throw new Error('Write a complete question to develop.');
    (c.questionHistory ??= []).push({ ...previousQuestion, at: new Date().toISOString() });
    c.question = reading;
  }
  for (const edit of responses) {
    const previous = active.find((r) => r.id === edit.id);
    if (!questionChanged && previous?.text === edit.text.trim()) continue;
    if (edit.text.trim()) {
      const next = await readResponse(project, c.question?.graph, edit.text, options);
      if (
        previous?.text === next.text &&
        contributionRevision(previous.graph) === contributionRevision(next.graph)
      ) {
        // Reframing an unchanged assertion preserves its occurrence and attached developments.
        previous.composition = next.composition;
        continue;
      }
      c.responses.push({ ...next, ...(previous ? { replaces: previous.id } : {}) });
    }
    if (previous) {
      previous.withdrawn = true;
      previous.questionText = previousQuestion?.text;
    }
  }
  // A declaration about the old question/answer is not a declaration about its revision.
  for (const wording of c.wordings) {
    if (wording.withdrawn) continue;
    const basisWithdrawn = c.responses.some((r) => r.id === wording.basisResponseId && r.withdrawn);
    if ((questionChanged && wording.kind !== 'perspective') || basisWithdrawn) {
      wording.withdrawn = true;
      wording.withdrawalReason = questionChanged ? 'question-revised' : 'answer-revised';
      wording.questionText = previousQuestion?.text;
    }
  }
  validateContributions(data);
  return { data, contribution: c };
}

export function withdrawContributionPart(data, contributionId, partId) {
  const next = structuredClone(data),
    c = next.contributions.find((c) => c.id === contributionId);
  const part = [...c.responses, ...c.wordings].find((r) => r.id === partId);
  if (!part) throw new Error('Contribution part unavailable.');
  part.withdrawn = true;
  return next;
}
