/** Durable client evidence for one actual scoped inquiry; no authored policies. */
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { prepareGraphs, normalizedRoleProfile } from '../models/graph-preparation.mjs';
import { compareGraphs, comparisonProfile } from '../models/semantic-comparison.mjs';
import { traceInquiry, semanticChainProfile } from './semantic-chain.mjs';
import { sourceCatalog } from '../project/authoring/sources.mjs';
import { openProject } from '../project/authoring/project.mjs';
import {
  acquireEngineRunLease,
  putEngineArtifact,
  saveEngineRun,
} from '../project/storage/engine-runs.mjs';
import { parseTexts } from '../models/acquisition.mjs';
import { acquiredTexts, retainAcquisitions } from '../project/storage/acquisitions.mjs';
import { checkAnswer } from './answer.mjs';
import { prepareInquiry } from './preparation.mjs';
import { readGrammarCache, writeGrammarCache } from '../project/storage/grammar.mjs';
import { exploreRoles } from './role-exploration.mjs';

export function engineInputChanges(project, input) {
  const catalog = sourceCatalog(project.data),
    entries = input.sources ?? input.entries ?? [];
  const identities = new Map(
    catalog.map((source) => [JSON.stringify([source.nodeId, source.sentenceId]), source]),
  );
  return entries
    .filter((entry) => !['case', 'question'].includes(entry.kind))
    .flatMap((entry) => {
      const current = identities.get(JSON.stringify([entry.placementId, entry.sentenceId]));
      return current?.revision === (entry.revision ?? entry.textRevision)
        ? []
        : [
            {
              text: entry.text,
              currentText: current?.text ?? null,
              reason: current ? 'Text changed after this AMR was captured' : 'Source was removed',
              placementId: entry.placementId,
            },
          ];
    });
}

export async function runEngine(project, options = {}) {
  if (options.acquireSemantic || options.questionAlignment)
    throw new Error(
      'Automatic semantic interpretation has been removed. The engine uses retained AMRs.',
    );
  const { input } = options;
  if (!input || input.projectId !== project.data.id || !input.question)
    throw new Error('An actual scoped question input is required');
  const runId = randomUUID(),
    release = await acquireEngineRunLease(project, runId);
  try {
    return await executeEngineRun(project, options, runId);
  } finally {
    await release();
  }
}

async function executeEngineRun(
  project,
  {
    input,
    signal,
    actor = 'participant',
    onUpdate = () => {},
    clients = {},
    bounds,
    acquireMissing = false,
    answer = true,
    trace = true,
    progress = () => {},
    purpose = 'inquiry',
  } = {},
  runId,
) {
  const started = performance.now();
  const operations = {
    prepare: prepareGraphs,
    compare: compareGraphs,
    parse: parseTexts,
    ...clients,
  };
  const run = {
    version: 1,
    id: runId,
    pid: process.pid,
    projectId: project.data.id,
    projectDigest: input.projectRevision,
    scopePlacementId: input.scopePlacementId,
    profile: semanticChainProfile,
    startedAt: new Date().toISOString(),
    actor,
    purpose,
    status: 'running',
    ask: input.question.ask,
    inputRef: await putEngineArtifact(project, input),
    placements: [...new Set([...input.sources, ...input.cases].map((entry) => entry.placementId))],
    questions: [{ id: input.question.id, text: input.question.text }],
    case: input.cases.map((entry) => entry.text).join('\n'),
    caseSelection: input.caseSelection ?? null,
    stages: [],
    calls: [],
    openings: [],
    candidates: [],
    clients: {
      penman: { profile: normalizedRoleProfile },
      semcat: { profile: comparisonProfile },
    },
    policy: {
      reasoning: 'deterministic',
      embeddings: false,
      acquisition: acquireMissing ? 'reuse exact AMRs; parse missing texts' : 'retained AMRs',
      search: trace
        ? 'HRG query derivations and correspondence diagnostics'
        : 'HRG query derivations',
    },
  };
  const update = async () => {
    run.elapsedMs = Math.round(performance.now() - started);
    await saveEngineRun(project, run);
    onUpdate(structuredClone(run));
  };
  const phase = async (id, label) => {
    signal?.throwIfAborted();
    const previous = run.stages.at(-1);
    if (previous?.status === 'running') {
      previous.status = 'complete';
      previous.durationMs = Math.round(performance.now() - started) - previous.startedMs;
    }
    run.stages.push({
      id,
      label,
      status: 'running',
      startedMs: Math.round(performance.now() - started),
    });
    await update();
  };
  const invoke = async (client, items, options) => {
    signal?.throwIfAborted();
    const { signal: _signal, ...parameters } = options;
    const call = {
      id: `call-${run.calls.length + 1}`,
      client,
      stage: run.stages.at(-1)?.id,
      count: items.length,
      status: 'running',
      startedMs: Math.round(performance.now() - started),
      requestRef: await putEngineArtifact(project, { items, parameters }),
    };
    run.calls.push(call);
    await update();
    try {
      const result =
        client === 'AMR'
          ? await operations.parse(
              items.map((item) => item.text),
              progress,
              signal,
            )
          : await operations[client === 'PENMAN' ? 'prepare' : 'compare'](items, options);
      if (!Array.isArray(result.results) || result.results.length !== items.length)
        throw new Error(`${client} response cohort mismatch`);
      call.responseRef = await putEngineArtifact(project, result);
      const complete = (item) =>
        client === 'AMR'
          ? item.decode_status === 'ok' && typeof item.penman === 'string' && item.penman.trim()
          : client === 'PENMAN'
            ? item.ok
            : item.complete;
      call.status = result.results.every(complete) ? 'complete' : 'limited';
      call.versions = result.versions ?? { penman: result.penmanVersion };
      if (result.source) call.source = result.source;
      call.summary = `${result.results.filter(complete).length}/${items.length} ${client === 'AMR' ? 'texts decoded' : client === 'PENMAN' ? 'graphs prepared' : 'comparisons completed'}`;
      return result;
    } catch (error) {
      call.status = signal?.aborted ? 'cancelled' : 'failed';
      call.error = error.message;
      call.errorRef = await putEngineArtifact(project, {
        message: error.message,
        stack: error.stack,
      });
      throw error;
    } finally {
      call.durationMs = Math.round(performance.now() - started) - call.startedMs;
      await update();
    }
  };
  await update();
  let result;
  try {
    await phase('inputs', 'Check scoped source revisions and retained acquisitions');
    const current = await openProject(dirname(project.path)),
      changes = engineInputChanges(current, input);
    if (changes.length || current.digest !== input.projectRevision) {
      run.status = 'stale';
      run.error = 'The authored project changed after this inquiry snapshot.';
      run.openings = changes.map((change, i) => ({
        id: `stale-${i}`,
        kind: 'source',
        ...change,
      }));
    } else {
      if (acquireMissing) {
        const entries = [...input.sources, ...input.cases, input.question];
        const missing = [
          ...new Set(
            entries
              .filter((entry) => entry.acquisition?.status === 'missing')
              .map((entry) => entry.text),
          ),
        ];
        if (missing.length) {
          await phase(
            'acquisition',
            'Acquire missing AMRs from exact source, case and question text',
          );
          const parsed = await invoke(
            'AMR',
            missing.map((text) => ({ text })),
            { signal, endpoint: '/amr/parse-batch' },
          );
          signal?.throwIfAborted();
          const captures = parsed.results.flatMap((item, index) =>
            item.decode_status === 'ok' && typeof item.penman === 'string' && item.penman.trim()
              ? [
                  {
                    text: missing[index],
                    penman: item.penman,
                    acquisition: item,
                    origin: {
                      kind: 'runtime-acquisition',
                      projectId: project.data.id,
                      engineRunId: run.id,
                      endpoint: '/amr/parse-batch',
                      at: new Date().toISOString(),
                    },
                  },
                ]
              : [],
          );
          if (captures.length) await retainAcquisitions(project, captures);
          const cached = await acquiredTexts(
            project,
            entries.map((entry) => entry.text),
          );
          const built = entries.map((entry, index) => ({
            ...entry,
            acquisition:
              cached?.[index]?.status === 'retained'
                ? cached[index]
                : {
                    ...entry.acquisition,
                    reason:
                      parsed.results[missing.indexOf(entry.text)]?.decode_error ??
                      entry.acquisition?.reason ??
                      'AMR decoding did not produce a graph.',
                  },
          }));
          input = {
            ...input,
            sources: built.slice(0, input.sources.length),
            cases: built.slice(input.sources.length, -1),
            question: built.at(-1),
            openings: built
              .filter((entry) => entry.acquisition.status === 'missing')
              .map((entry) => ({
                id: `acquisition:${entry.id}`,
                kind: 'acquisition',
                inputId: entry.id,
                text: entry.text,
                placementId: entry.placementId ?? input.scopePlacementId,
                reason: entry.acquisition.reason,
              })),
          };
          run.sourceInputRef = run.inputRef;
          run.inputRef = await putEngineArtifact(project, input);
          await update();
        }
      }
      const clients = {
        prepare: (items, options) => invoke('PENMAN', items, options),
        compare: (items, options) => invoke('SEMCAT', items, options),
      };
      const preparedInput = await prepareInquiry(input, {
        signal,
        phase,
        prepare: clients.prepare,
      });
      result = {
        profile: semanticChainProfile,
        status: 'open',
        inputs: preparedInput.records,
        openings: preparedInput.openings,
        candidates: [],
        definitions: [],
        applications: [],
        chains: [],
      };
      let traceStatus = 'skipped';
      if (trace && preparedInput.records.at(-1)?.graph) {
        try {
          result = await traceInquiry(input, { signal, phase, bounds, clients, preparedInput });
          traceStatus = result.status;
        } catch (error) {
          signal?.throwIfAborted();
          traceStatus = error.code === 'FRAGMENT_LIMIT' ? 'limited' : 'failed';
          result.openings.push({
            kind: 'correspondence',
            state: traceStatus,
            reason: error.message,
          });
          result.traceErrorRef = await putEngineArtifact(project, {
            message: error.message,
            stack: error.stack,
          });
          const stage = run.stages.at(-1);
          stage.status = traceStatus;
          stage.durationMs = Math.round(performance.now() - started) - stage.startedMs;
        }
      }
      result.traceStatus = traceStatus;
      result.lexicalAudit = preparedInput.lexicalAudit;
      run.lexicalAudit = preparedInput.lexicalAudit;
      run.traceStatus = traceStatus;
      run.coverage = {
        ...(result.retrieval ?? {}),
        sources: {
          total: input.sources.length,
          prepared: result.inputs.filter((item) => item.kind === 'source' && item.graph).length,
        },
        cases: {
          total: input.cases.length,
          prepared: result.inputs.filter((item) => item.kind === 'case' && item.graph).length,
        },
        question: Boolean(result.inputs.at(-1)?.graph),
        correspondence: { status: traceStatus, ...(result.retrieval ?? {}) },
      };
      run.coverage.complete =
        run.coverage.sources.total === run.coverage.sources.prepared &&
        run.coverage.cases.total === run.coverage.cases.prepared &&
        run.coverage.question;
      if (!run.coverage.question) {
        result.status =
          input.question.acquisition?.status === 'missing' ? 'needs-amr' : 'invalid-amr';
        run.error =
          result.status === 'needs-amr'
            ? 'The question has no usable AMR. Answer checking did not run.'
            : 'The question AMR could not be normalized. Answer checking did not run.';
      }
      run.status = result.status;
      run.openings = result.openings;
      run.candidates = result.candidates;
      if (answer && result.inputs.at(-1)?.graph) {
        await phase(
          'answer',
          'Compose corpus fragments and check the question with source evidence',
        );
        const context = [input.scopePlacementId, input.caseSelection?.placementId ?? null];
        const grammarCache = await readGrammarCache(project, context);
        const explored = input.exploration
          ? await exploreRoles(project, input, result, {
              grammarCache: grammarCache ?? {},
              signal,
              phase,
            })
          : null;
        const answer =
          explored?.answer ??
          checkAnswer(project, input, result, { grammarCache: grammarCache ?? {} });
        if (explored) {
          result.exploration = explored.exploration;
          run.exploration = {
            profile: explored.exploration.profile,
            ordering: explored.exploration.ordering,
            roles: explored.exploration.visits.length,
            checks: explored.exploration.checks.length,
            complete: explored.exploration.complete,
            elapsedMs: explored.exploration.elapsedMs,
          };
        }
        if (answer.complete) {
          const cached = grammarCache?.profile === answer.grammar.profile && grammarCache.grammars;
          await writeGrammarCache(
            project,
            context,
            { profile: answer.grammar.profile, grammars: answer.grammar.corpora },
            {
              unchanged:
                Boolean(cached) &&
                cached.length === answer.grammar.corpora.length &&
                cached.every(
                  (grammar, i) => grammar.signature === answer.grammar.corpora[i].signature,
                ),
            },
          );
        }
        result.answer = answer;
        const summarize = ({ facts: _facts, ...binding }) => binding;
        const sourceIds = new Set(
          [...answer.answers, ...answer.candidates].flatMap((binding) => binding.sourceIds),
        );
        run.answer = {
          engine: answer.engine,
          status: answer.status,
          complete: answer.complete,
          answers: answer.answers.map(summarize),
          candidates: answer.candidates.map(summarize),
          sources: answer.sources.filter((source) => sourceIds.has(source.id)),
          basis: answer.basis.map(({ id, name, attribution }) => ({ id, name, attribution })),
          openings: answer.openings,
          skipped: answer.skipped,
          clarifications: answer.clarifications,
          partial: answer.partial,
          ...(answer.related ? { related: answer.related } : {}),
          grammar: {
            profile: answer.grammar.profile,
            ...answer.grammar.stats,
            corpora: answer.grammar.corpora.map((g) => g.stats),
          },
        };
        run.coverage.reasoning = answer.coverage;
        run.status = answer.status;
        run.openings = [
          ...preparedInput.openings,
          ...answer.openings,
          ...result.openings.filter((opening) => opening.kind === 'correspondence'),
        ];
      }
      if ((await openProject(dirname(project.path))).digest !== current.digest) {
        run.status = 'stale';
        run.error =
          'The project changed during execution. Results belong to the retained input snapshot.';
      }
    }
  } catch (error) {
    run.status = signal?.aborted
      ? 'cancelled'
      : ['FRAGMENT_LIMIT', 'GRAMMAR_LIMIT'].includes(error.code) ||
          run.calls.some((call) => call.status === 'limited')
        ? 'limited'
        : 'failed';
    run.error = error.message;
    run.errorRef = await putEngineArtifact(project, {
      message: error.message,
      stack: error.stack,
    });
  } finally {
    const stage = run.stages.at(-1);
    if (stage?.status === 'running') {
      stage.status = run.error ? run.status : 'complete';
      stage.durationMs = Math.round(performance.now() - started) - stage.startedMs;
    }
    if (result) run.resultRef = await putEngineArtifact(project, result);
    run.finishedAt = new Date().toISOString();
    await update();
  }
  return run;
}
