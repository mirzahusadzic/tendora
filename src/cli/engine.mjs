#!/usr/bin/env node
/** Execute the deterministic engine on ordinary authored projects. */
import { basename, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EngineUsageError, parseEngineArguments, program } from './engine-options.mjs';
import { createProject, openProject, saveProject } from '../project/authoring/project.mjs';
import { authorEngineKnowledge } from '../project/authoring/knowledge.mjs';
import {
  answerProvenance,
  readProvenance,
  recordedAuthors,
} from '../project/authoring/provenance.mjs';
import { selectCase, authorCase } from '../project/inquiries/investigation.mjs';
import { resolveInquiryPlacement } from '../project/inquiries/scope.mjs';
import { inputFromProject } from '../engine/input.mjs';
import { runEngine } from '../engine/run.mjs';
import { openingNeeds, relationPhrases } from '../engine/explanation.mjs';
import { readingNote } from '../recording/answer-output.mjs';
import { deleteEngineRuns } from '../project/inquiries/delete-engine-runs.mjs';
import {
  compactProjectStorage,
  projectStorageUsage,
} from '../project/inquiries/project-storage.mjs';
import {
  formatProbes,
  formatRecoil,
  formatTensions,
  probeReport,
  recoilLocus,
  recoilReport,
  tensionReport,
} from '../project/inquiries/inspection.mjs';
import { fidelityReport, formatFidelity } from '../project/inquiries/fidelity.mjs';
import { describeBackends, useTrimBackend } from '../engine/trim-backend.mjs';
import {
  listEngineRuns,
  readEngineRun,
  readEngineArtifact,
} from '../project/storage/engine-runs.mjs';

const controller = new AbortController();
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  process.stderr.write('Error writing output: ' + error.message + '\n');
  process.exitCode = 1;
});
const interrupt = () => {
  if (controller.signal.aborted) process.exit(130);
  process.stderr.write('Cancelling check...\n');
  controller.abort();
};

/** A yes on the terminal; anything else is no. */
async function confirm(prompt) {
  const { createInterface } = await import('node:readline/promises');
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(?:es)?$/iu.test((await reader.question(prompt)).trim());
  } finally {
    reader.close();
  }
}

/** A question given as -, read from standard input. */
async function standardInput() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) throw new EngineUsageError('--question - read nothing from standard input.');
  return text.trim();
}

/** What a person named that does not exist is an invalid argument. */
// A name that matches nothing: its own hint, and, in a copy of the demo that
// is not the bundled one, how to renew it.
const named = (run, demo = null) => {
  try {
    return run();
  } catch (error) {
    throw new EngineUsageError(error.message, {
      hint: [error.hint, demo].filter(Boolean).join('\n') || null,
      syntax: false,
    });
  }
};

const bytes = (n) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : n >= 1024
      ? `${Math.round(n / 1024)} KB`
      : `${n} B`;
const usage = (result) =>
  [
    `${bytes(result.bytes)} in use (${bytes(result.allocated)} on disk)`,
    ...Object.entries(result.areas).map(
      ([area, item]) =>
        `  ${area.padEnd(18)} ${bytes(item.bytes).padStart(9)}  ${item.files} file${item.files === 1 ? '' : 's'}`,
    ),
  ].join('\n');

const changedSince = (run, digest) =>
  Boolean(digest && run.projectDigest && run.projectDigest !== digest);
/** A saved check as JSON, marked when the statements changed since it. */
const saved = (run, digest) => ({
  ...run,
  ...(changedSince(run, digest) ? { statementsChanged: true } : {}),
});

const clearStatus = () => {
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
};
// The bundled demo, to name a copy of it that is no longer the same.
const bundledDemo = new URL('../../.proj/payments-on-call/project.json', import.meta.url);
function demoCopyNote(project) {
  let bundled;
  try {
    bundled = readFileSync(bundledDemo, 'utf8');
  } catch {
    return null;
  }
  return JSON.parse(bundled).id === project.data.id &&
    createHash('sha256').update(bundled).digest('hex') !== project.digest
    ? 'This copy of the demo differs from the bundled one (edited, or made from an older one); npm run demo -- --reset renews it.'
    : null;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const header = (run) =>
  `${run.status}: ${run.questions?.[0]?.text ?? run.id}${run.case ? ` (case: ${run.case.replaceAll('\n', ' ')})` : ''}`;
/** What has no retained reading, in words, or null when everything has one. */
function unread(coverage) {
  if (!coverage?.sources) return null;
  const missing = [
    ...(coverage.question ? [] : ['the question']),
    ...(coverage.cases.prepared < coverage.cases.total
      ? [
          coverage.cases.total === 1
            ? 'the case'
            : plural(coverage.cases.total - coverage.cases.prepared, 'case statement'),
        ]
      : []),
    ...(coverage.sources.prepared < coverage.sources.total
      ? [plural(coverage.sources.total - coverage.sources.prepared, 'statement')]
      : []),
  ];
  return missing.length ? missing.join(', ').replace(/, ([^,]*)$/u, ' and $1') : null;
}

/** A saved or fresh check in words: the status, the answers and what they rest
 * on, why it stays open and what is one confirmation away, then where it was
 * saved. `--explain` adds sources, rules, readings and vocabulary findings.
 * `relations` names the question's relationships for --explain; `digest`, the
 * project's revision, says whether the statements changed since; `demo` notes
 * a copy of the demo that is not the bundled one. */
function describe(
  run,
  { explain = false, offline = false, relations, digest, demo, fresh = false } = {},
) {
  const short = run.id.slice(0, 8);
  if (run.cache === 'recheck' && !run.answer)
    return [
      `saved: ${header(run).replace(/^[^:]+: /u, '')}`,
      'Released by compaction: ask it again to check it.',
      `Saved as ${short}.`,
    ].join('\n');
  const lines = [header(run)];
  if (changedSince(run, digest))
    lines.push('The statements changed since this check; ask again to check them as they are now.');
  if (run.status === 'needs-reading')
    lines.push('Not every statement in scope has a reading; the answer may change once they do.');
  const fromCase = new Set(
    (run.answer?.sources ?? []).filter((s) => s.kind === 'case').map((s) => s.id),
  );
  for (const answer of [...(run.answer?.answers ?? []), ...(run.answer?.candidates ?? [])]) {
    lines.push((run.answer?.answers.includes(answer) ? 'Answer: ' : 'Candidate: ') + answer.text);
    const cited = answer.sourceIds ?? [],
      statements = cited.filter((id) => !fromCase.has(id)).length;
    if (statements < cited.length)
      lines.push(
        statements
          ? `  rests on the case and ${plural(statements, 'statement')}`
          : '  from the case alone; no statement says it',
      );
    if (answer.readAs === 'requirement')
      lines.push('  a statement says it must be done; that answers "should"');
    if (answer.readAs === 'reference')
      lines.push(
        `  "${answer.reference.pronoun}" read as the ${answer.reference.antecedent} the question names`,
      );
    if (answer.readAs === 'shared-wording')
      lines.push(
        `  the question and a statement both say "${answer.sharedWording.join('", "')}"; read as in the statement`,
      );
    if (readingNote(answer, ['"', '"'])) lines.push('  ' + readingNote(answer, ['"', '"']));
    for (const detail of answer.dependsOn ?? answer.qualifications ?? []) lines.push('  ' + detail);
    if (explain) {
      lines.push('  Sources: ' + (answer.sourceIds ?? []).join(', '));
      lines.push('  Bindings: ' + (answer.bindings ?? []).map((binding) => binding.id).join(', '));
      if (answer.ruleIds?.length) lines.push('  Rules: ' + answer.ruleIds.join(', '));
      if (answer.bindingIds?.length) lines.push('  References: ' + answer.bindingIds.join(', '));
      if (answer.composition)
        lines.push(
          `  Composition: ${answer.composition.rule}; ${answer.composition.premises.length} assertions`,
        );
      for (const source of run.answer.sources ?? [])
        if (answer.sourceIds?.includes(source.id)) lines.push('  Evidence: ' + source.text);
    }
  }
  // Why it stays open: each reason once; which relationship, with --explain.
  if (
    ['open', 'limited'].includes(run.status) &&
    (run.openings?.length || run.answer?.openings?.length)
  ) {
    const needs = openingNeeds(run, relations);
    const reasons = [...new Set(needs.map(({ reason }) => reason))];
    if (explain) {
      lines.push('Why it stays open:');
      for (const { needs: what, reason } of needs)
        lines.push(`  ${what.map((need) => need.replaceAll('\n', ' ')).join('; ')}: ${reason}`);
    } else if (reasons.length === 1) lines.push(`Why it stays open: ${reasons[0]}`);
    else if (reasons.length) lines.push('Why it stays open:', ...reasons.map((r) => `  ${r}`));
  }
  if (explain)
    for (const opening of run.openings ?? [])
      lines.push(
        'Opening: ' +
          (opening.label ??
            (opening.role ? `${opening.from} ${opening.role} ${opening.to}` : opening.concept) ??
            opening.text ??
            opening.kind) +
          ': ' +
          opening.reason,
      );
  // A proposal answers only once a person confirms it.
  for (const proposal of run.answer?.clarifications ?? [])
    lines.push(
      `Proposal: ${proposal.answerLabel}, one confirmation away (in the workbench: Development, d)`,
      `  from: ${proposal.source?.text}`,
    );
  for (const item of run.lexicalAudit?.repairs ?? [])
    for (const repair of item.repairs)
      lines.push(
        `Repaired reading: ${item.text}: ${repair.from} used as ${repair.to} (${repair.reason})`,
      );
  // Vocabulary findings: the question's always (they can explain an opening),
  // the statements' with --explain.
  for (const item of (run.lexicalAudit?.items ?? []).filter(
    (item) => explain || item.kind === 'question',
  )) {
    lines.push(`Unverified word in the ${item.kind}: ${item.text}`);
    for (const finding of item.findings ?? []) lines.push('  ' + finding.reason);
    if (explain)
      for (const candidate of item.candidates ?? [])
        lines.push(
          `  Lexical hint: ${JSON.stringify(candidate.evidence.text)} matches ${candidate.evidence.method === 'propbank-inflection' ? 'an inflection of ' : ''}PropBank alias ${JSON.stringify(candidate.evidence.lexeme)} for ${candidate.predicate} (${candidate.description}); this does not establish a replacement or its roles.`,
        );
  }
  if (explain && run.answer?.grammar) {
    const grammar = run.answer.grammar,
      corpus = grammar.corpora.at(-1);
    lines.push(
      `Grammar: ${corpus?.rules ?? 0} productions; ${grammar.compilations ? 'compiled changed material' : 'reused retained material'}`,
    );
  }
  if (run.answer?.related?.length) {
    lines.push('Closest statements (none answers it):');
    for (const item of explain ? run.answer.related : run.answer.related.slice(0, 3))
      lines.push(`  ${item.text}${explain ? `  (shares: ${item.shares.join(', ')})` : ''}`);
  }
  const missing = unread(run.coverage);
  if (explain && run.coverage?.sources)
    lines.push(
      `Readings: ${run.coverage.sources.prepared}/${run.coverage.sources.total} statements, ${run.coverage.cases.prepared}/${run.coverage.cases.total} case statements, question ${run.coverage.question ? 'read' : 'missing'}`,
    );
  else if (missing) lines.push(`No retained reading for ${missing}.`);
  // An engine error says more than the status only when the check failed.
  if (run.error && (explain || !['needs-amr', 'needs-reading'].includes(run.status)))
    lines.push('Error: ' + run.error);
  for (const issue of run.semantic?.issues ?? [])
    if (explain || /time limit/u.test(issue.reason ?? ''))
      lines.push('Interpretation: ' + issue.reason);
  if (missing && demo) lines.push(demo);
  else if (missing && offline)
    lines.push(
      `Run without --offline to read ${/ and |statements/u.test(missing) ? 'them' : 'it'} through eGemma.`,
    );
  lines.push(
    explain
      ? `Run: ${run.id}; ${plural(run.calls.length, 'client call')}; ${(run.elapsedMs / 1000).toFixed(2)} s`
      : fresh
        ? `Saved as ${short} in ${(run.elapsedMs / 1000).toFixed(2)} s.`
        : `Check ${short}, made ${run.startedAt.slice(0, 16).replace('T', ' ')} UTC.`,
  );
  return lines.join('\n');
}

/** The question's relationships in words, from the check's retained reading. */
async function questionRelations(project, run) {
  if (!run.resultRef) return undefined;
  const result = await readEngineArtifact(project, run.resultRef).catch(() => null);
  const question = result?.inputs?.find((item) => item.kind === 'question');
  return question?.graph ? relationPhrases(question.graph, question.text) : undefined;
}

try {
  const { action, values, help, version } = parseEngineArguments(process.argv.slice(2));
  if (version) {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
    console.log(`${program} ${manifest.version}`);
  } else if (help) console.log(help);
  else if (action === 'backends') {
    const backends = describeBackends(),
      using = process.env.TENDORA_BACKEND || 'js';
    console.log(
      values.json
        ? JSON.stringify({ using, backends }, null, 2)
        : [
            ...backends.map(
              ({ name, available, detail }) =>
                `${name.padEnd(6)} ${available ? 'available    ' : 'not available'}  ${detail}`,
            ),
            `In use: ${using}${process.env.TENDORA_BACKEND ? ' (TENDORA_BACKEND)' : ' (the default)'}`,
          ].join('\n'),
    );
  } else {
    if (values.question === '-') values.question = await standardInput();
    // The trim backend of a check: --backend, else TENDORA_BACKEND, else js;
    // worker threads and processes inherit it through the environment.
    if (['ask', 'probe', 'fidelity'].includes(action)) {
      if (values.backend) process.env.TENDORA_BACKEND = values.backend;
      try {
        useTrimBackend();
      } catch (error) {
        throw new EngineUsageError(error.message, {
          syntax: false,
          hint: `See what this machine offers with: ${program} backends`,
        });
      }
    }
    const location = resolve(values.project);
    const project =
      action === 'init'
        ? await createProject(location, values.name ?? basename(location), values.root ?? 'Root')
        : await openProject(location).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            throw new EngineUsageError(
              `No project at ${location}: project.json is missing. Create one with: ${program} init --project ${values.project}`,
              { syntax: false },
            );
          });
    const placement = (selector) => named(() => resolveInquiryPlacement(project, selector), demo);
    // A saved check by its id, or by a prefix only it has (the 8 characters
    // the output shows).
    const savedRun = async (id) => {
      const exact = await readEngineRun(project, id).catch(() => null);
      if (exact) return exact;
      const matches = (await listEngineRuns(project)).filter((run) => run.id.startsWith(id));
      if (matches.length === 1) return matches[0];
      throw new EngineUsageError(
        matches.length
          ? `${matches.length} saved checks start with ${id}; give more of the id.`
          : `No saved check ${id} in this project.`,
        {
          syntax: false,
          hint: `List saved checks with: ${program} runs --project ${values.project}`,
        },
      );
    };
    const demo = demoCopyNote(project);
    let output;
    if (action === 'init')
      output = values.json
        ? { project: location, id: project.data.id }
        : `Created an empty project in ${values.project}. Write its statements in the workbench: npm run workbench -- --project ${values.project}`;
    else if (action === 'storage') {
      const result = await projectStorageUsage(project);
      output = values.json ? result : usage(result);
    } else if (action === 'compact') {
      const result = await compactProjectStorage(project, { force: true });
      output = values.json
        ? result
        : `Compacted: ${bytes(result.before.allocated)} on disk before, ${bytes(result.after.allocated)} after.`;
    } else if (action === 'knowledge') {
      const entry = JSON.parse(await readFile(resolve(values.file), 'utf8'));
      await saveProject(project, authorEngineKnowledge(project.data, entry));
      output = values.json
        ? { id: entry.id, name: entry.name }
        : 'Stored authored engine knowledge: ' + entry.name;
    } else if (action === 'runs') {
      const runs = await listEngineRuns(project);
      // One line a check; --explain describes each in full.
      const width = Math.max(0, ...runs.map((run) => run.status.length));
      output = values.json
        ? runs.map((run) => saved(run, project.digest))
        : !runs.length
          ? 'No saved checks.'
          : values.explain
            ? runs
                .map((run) => describe(run, { explain: true, digest: project.digest }))
                .join('\n\n')
            : [
                ...runs.map(
                  (run) =>
                    `${run.id.slice(0, 8)}  ${(run.cache === 'recheck' && !run.answer ? 'saved' : run.status).padEnd(width)}  ${header(run).replace(/^[^:]+: /u, '')}${changedSince(run, project.digest) ? '  (statements changed since)' : ''}`,
                ),
                '',
                `${plural(runs.length, 'saved check')}; ${program} show --project ${values.project} --run <id> shows one.`,
              ].join('\n');
    } else if (action === 'delete') {
      const doomed = values.all ? await listEngineRuns(project) : [await savedRun(values.run)];
      const what = values.all
        ? `all ${doomed.length} saved check${doomed.length === 1 ? '' : 's'}, saved cases and rebuildable acquisitions`
        : `the saved check of “${doomed[0].questions?.[0]?.text ?? doomed[0].id}”`;
      if (values['dry-run'])
        output = values.json
          ? { dryRun: true, all: Boolean(values.all), runs: doomed.map((run) => run.id) }
          : `Would delete ${what}; the statements stay.\n` +
            doomed
              .map((run) => `  ${run.id.slice(0, 8)}  ${header(run).replace(/^[^:]+: /u, '')}`)
              .join('\n');
      else if (
        !values.yes &&
        process.stdin.isTTY &&
        process.stderr.isTTY &&
        !(await confirm(`Delete ${what}? The statements stay. [y/N] `))
      ) {
        output = 'Nothing was deleted.';
        process.exitCode = 1;
      } else {
        const result = await deleteEngineRuns(
          project,
          values.all ? { all: true } : { ids: [doomed[0].id] },
        );
        output = values.json
          ? result
          : result.reset
            ? `Deleted ${what}; the statements stay.`
            : `Deleted the saved check ${doomed[0].id.slice(0, 8)}; the statements stay.`;
      }
    } else if (action === 'recoil') {
      const locus = named(
        () =>
          recoilLocus(project, {
            statement: values.statement,
            role: values.role,
            question: values.question,
            scope: values.scope,
            caseText: values['case-text'],
          }),
        demo,
      );
      const report = await recoilReport(project, locus).catch((error) => {
        if (/^No such /u.test(error.message))
          throw new EngineUsageError(error.message, { syntax: false });
        throw error;
      });
      output = values.json ? report : formatRecoil(report);
    } else if (action === 'tensions') {
      const report = await tensionReport(project, { grain: Number(values.grain ?? 1) });
      output = values.json ? report : formatTensions(report);
    } else if (action === 'fidelity') {
      const report = await fidelityReport(project, { withhold: Boolean(values.withhold) });
      output = values.json ? report : formatFidelity(report);
    } else if (action === 'probe') {
      if (values.statement)
        named(() => recoilLocus(project, { statement: values.statement }), demo);
      if (values.role) placement(values.role);
      const report = await probeReport(project, {
        statement: values.statement,
        role: values.role,
      });
      output = values.json ? report : formatProbes(report);
    } else if (action === 'show') {
      const run = await savedRun(values.run);
      // A released check keeps no input, only its last answer and the
      // statements that answer rests on.
      const input = run.inputRef
        ? await readEngineArtifact(project, run.inputRef).catch(() => null)
        : null;
      const answers = run.answer?.answers ?? run.lastAnswer?.answers;
      output = values.json
        ? {
            ...saved(run, project.digest),
            // The check's own provenance; one saved before checks kept it is
            // read now and says so.
            provenance: run.provenance ?? {
              ...answerProvenance(
                {
                  projectId: run.projectId,
                  projectRevision: run.projectDigest,
                  checkedBy: { actor: run.actor, via: run.via },
                },
                await readProvenance(project),
                answers,
                [
                  ...(input?.sources ?? []),
                  ...(input?.cases ?? []),
                  ...(run.lastAnswer?.sources ?? []),
                ],
                recordedAuthors(project.data),
              ),
              computedAtExport: true,
              // Released before it kept them: its statements are not known.
              ...(answers?.some((answer) => !answer.sourceIds)
                ? { statementsUnrecorded: true }
                : {}),
            },
            ...(values.explain && run.resultRef
              ? { result: await readEngineArtifact(project, run.resultRef) }
              : {}),
          }
        : describe(run, {
            explain: values.explain,
            relations: await questionRelations(project, run),
            digest: project.digest,
            demo,
          });
    } else {
      const input = await inputFromProject(project, {
        scopePlacementId: placement(values.scope),
        question: values.question,
        caseSelection:
          values['case-text'] !== undefined
            ? authorCase(project, values['case-text'])
            : values.case
              ? selectCase(project, placement(values.case))
              : null,
      });
      process.on('SIGINT', interrupt);
      let last;
      // Progress: with --explain every stage on its own line; on a terminal,
      // one line each stage replaces, cleared when the check ends; else none.
      const status = (text) => {
        if (values.explain) process.stderr.write(text + '\n');
        else if (process.stderr.isTTY)
          process.stderr.write(`\r\x1b[2K${text.slice(0, (process.stderr.columns || 80) - 1)}`);
      };
      const run = await runEngine(project, {
        input,
        actor: values.actor ?? 'unrecorded',
        via: 'cli',
        acquireMissing: !values.offline,
        trace: Boolean(values.trace),
        signal: controller.signal,
        progress: status,
        onUpdate: (current) => {
          const stage = current.stages.at(-1);
          if (stage && stage.id !== last) status(stage.label);
          last = stage?.id;
        },
      });
      clearStatus();
      process.removeListener('SIGINT', interrupt);
      output = values.json
        ? run
        : describe(run, {
            explain: values.explain,
            offline: values.offline,
            relations: await questionRelations(project, run),
            demo,
            fresh: true,
          });
      await compactProjectStorage(project);
      if (values.json) {
        const stored = await readEngineRun(project, run.id);
        output = {
          ...run,
          cache: stored.cache,
          // The corpus the answer was checked against, and who wrote what it
          // rests on; a check that gave no answer names no statements.
          provenance: run.provenance ?? {
            projectId: run.projectId,
            projectRevision: run.projectDigest,
            statements: [],
          },
        };
        if (stored.cache === 'recheck') {
          for (const key of ['inputRef', 'sourceInputRef', 'resultRef', 'errorRef'])
            delete output[key];
          output.calls = run.calls.map(({ requestRef, responseRef, errorRef, ...call }) => call);
        }
      }
      if (run.status === 'cancelled') process.exitCode = 130;
      else if (
        ['failed', 'cancelled', 'stale', 'needs-amr', 'needs-reading', 'invalid-amr'].includes(
          run.status,
        )
      )
        process.exitCode = 1;
    }
    console.log(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
  }
} catch (error) {
  clearStatus();
  process.stderr.write('Error: ' + error.message + '\n');
  if (error.hint) process.stderr.write(error.hint + '\n');
  if (error instanceof EngineUsageError && error.syntax)
    process.stderr.write(`Use ${program} --help or ${program} <command> --help.\n`);
  process.exitCode = controller.signal.aborted ? 130 : error instanceof EngineUsageError ? 2 : 1;
} finally {
  process.removeListener('SIGINT', interrupt);
}
