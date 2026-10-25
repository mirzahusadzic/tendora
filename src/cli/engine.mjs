#!/usr/bin/env node
/** Execute the deterministic engine on ordinary authored projects. */
import { basename, join, resolve } from 'node:path';
import { access, readFile } from 'node:fs/promises';
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
const named = (run) => {
  try {
    return run();
  } catch (error) {
    throw new EngineUsageError(error.message);
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

/** A saved or fresh check in words. `relations` names the question's
 * relationships when its reading is at hand. */
function describe(run, { explain = false, offline = false, relations } = {}) {
  if (run.cache === 'recheck' && !run.answer)
    return (
      'Saved question: ' +
      run.questions[0].text +
      (run.case ? '\nCase: ' + run.case : '') +
      '\nOpen it in Development to check against current sources.\nRun: ' +
      run.id
    );
  const lines = [run.status + ': ' + (run.questions?.[0]?.text ?? run.id)];
  if (run.status === 'needs-reading')
    lines.push(
      'Not every statement in scope has a reading; the answer below rests on those that do and may change.',
    );
  for (const answer of [...(run.answer?.answers ?? []), ...(run.answer?.candidates ?? [])]) {
    lines.push((run.answer?.answers.includes(answer) ? 'Answer: ' : 'Candidate: ') + answer.text);
    if (answer.readAs === 'requirement')
      lines.push('  A source says it must be done; that answers "should".');
    if (answer.readAs === 'reference')
      lines.push(
        `  Read "${answer.reference.pronoun}" as the ${answer.reference.antecedent} the question names.`,
      );
    if (answer.readAs === 'shared-wording')
      lines.push(
        `  The question and a source both say "${answer.sharedWording.join('", "')}"; read as in the source.`,
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
          '  Composition: ' +
            answer.composition.rule +
            '; ' +
            answer.composition.premises.length +
            ' assertions',
        );
      for (const source of run.answer.sources ?? [])
        if (answer.sourceIds?.includes(source.id)) lines.push('  Evidence: ' + source.text);
    }
  }
  // Why it stays open, in words; the raw relations stay in --json and --explain.
  if (
    ['open', 'limited'].includes(run.status) &&
    (run.openings?.length || run.answer?.openings?.length)
  ) {
    lines.push('Why it stays open:');
    for (const { needs, reason } of openingNeeds(run, relations))
      lines.push(`  ${needs.map((need) => need.replaceAll('\n', ' ')).join('; ')}: ${reason}`);
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
      `Proposal, one confirmation away: ${proposal.answerLabel}`,
      `  From: ${proposal.source?.text}`,
      '  Confirm it in the workbench: Development, d.',
    );
  for (const item of run.lexicalAudit?.repairs ?? []) {
    lines.push(`Repaired reading: ${item.text}`);
    for (const repair of item.repairs)
      lines.push(`  ${repair.from} -> ${repair.to}: ${repair.reason}`);
  }
  // Runs saved before item-level audits keep only a summary; show what they retain.
  if (run.lexicalAudit?.items?.length) {
    const items = run.lexicalAudit.items;
    lines.push(
      `AMR vocabulary: ${items.length} input${items.length === 1 ? '' : 's'} with unverified lexical readings.`,
    );
    for (const item of items.filter((item) => explain || item.kind === 'question')) {
      lines.push(`  ${item.kind}: ${item.text}`);
      for (const finding of item.findings ?? []) lines.push('  Check: ' + finding.reason);
      for (const candidate of item.candidates ?? [])
        lines.push(
          `  Lexical hint: ${JSON.stringify(candidate.evidence.text)} matches ${candidate.evidence.method === 'propbank-inflection' ? 'an inflection of ' : ''}PropBank alias ${JSON.stringify(candidate.evidence.lexeme)} for ${candidate.predicate} (${candidate.description}); this does not establish a replacement or its roles.`,
        );
    }
    if (!explain && items.some((item) => item.kind !== 'question'))
      lines.push('  Use --explain to inspect source and case vocabulary findings.');
  }
  if (explain && run.answer?.grammar) {
    const grammar = run.answer.grammar,
      corpus = grammar.corpora.at(-1);
    lines.push(
      `Grammar: ${corpus?.rules ?? 0} productions; ${grammar.compilations ? 'compiled changed material' : 'reused retained material'}`,
    );
  }
  if (run.answer?.related?.length) {
    lines.push('Closest statements (they share words with the question; none answers it):');
    for (const item of run.answer.related)
      lines.push(`  ${item.text}  (shares: ${item.shares.join(', ')})`);
  }
  if (run.coverage?.sources)
    lines.push(
      `AMRs: ${run.coverage.sources.prepared}/${run.coverage.sources.total} source occurrences; ${run.coverage.cases.prepared}/${run.coverage.cases.total} case occurrences; question ${run.coverage.question ? 'prepared' : 'missing'}`,
    );
  if (run.error) lines.push('Error: ' + run.error);
  for (const issue of run.semantic?.issues ?? [])
    if (explain || /time limit/u.test(issue.reason ?? ''))
      lines.push('Interpretation: ' + issue.reason);
  if (run.status === 'needs-amr' && offline)
    lines.push('Hint: Run without --offline to acquire the missing question AMR.');
  if (run.status === 'needs-reading' && offline)
    lines.push('Hint: Run without --offline to read the statements that have no reading.');
  lines.push(
    'Run: ' +
      run.id +
      '; ' +
      run.calls.length +
      ' client calls; ' +
      (run.elapsedMs / 1000).toFixed(2) +
      ' s',
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
  else {
    if (values.question === '-') values.question = await standardInput();
    const location = resolve(values.project);
    if (action === 'init') {
      try {
        await access(join(location, 'project.json'));
        throw new Error('A project already exists at ' + location);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const project =
      action === 'init'
        ? await createProject(location, values.name ?? basename(location), values.root ?? 'Root')
        : await openProject(location).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            throw new EngineUsageError(
              `No project at ${location}: project.json is missing. Create one with: ${program} init --project ${values.project}`,
            );
          });
    const placement = (selector) => named(() => resolveInquiryPlacement(project, selector));
    const savedRun = (id) =>
      readEngineRun(project, id).catch(() => {
        throw new EngineUsageError(
          `No saved check ${id} in this project. List saved checks with: ${program} runs --project ${values.project}`,
        );
      });
    let output;
    if (action === 'init')
      output = values.json
        ? { project: location, id: project.data.id }
        : 'Created empty project: ' + location;
    else if (action === 'storage') {
      const result = await projectStorageUsage(project);
      output = values.json ? result : usage(result);
    } else if (action === 'compact') {
      const result = await compactProjectStorage(project, { force: true });
      output = values.json
        ? result
        : `Before: ${usage(result.before)}\nAfter:  ${usage(result.after)}`;
    } else if (action === 'knowledge') {
      const entry = JSON.parse(await readFile(resolve(values.file), 'utf8'));
      await saveProject(project, authorEngineKnowledge(project.data, entry));
      output = values.json
        ? { id: entry.id, name: entry.name }
        : 'Stored authored engine knowledge: ' + entry.name;
    } else if (action === 'runs') {
      const runs = await listEngineRuns(project);
      output = values.json
        ? runs
        : runs.map((run) => describe(run, { explain: values.explain })).join('\n\n') ||
          'No engine runs';
    } else if (action === 'delete') {
      const doomed = values.all ? await listEngineRuns(project) : [await savedRun(values.run)];
      const what = values.all
        ? `all ${doomed.length} saved check${doomed.length === 1 ? '' : 's'}, saved cases and rebuildable acquisitions`
        : `the saved check of “${doomed[0].questions?.[0]?.text ?? doomed[0].id}”`;
      if (values['dry-run'])
        output = values.json
          ? { dryRun: true, all: Boolean(values.all), runs: doomed.map((run) => run.id) }
          : `Would delete ${what}. Authored concepts and sentences stay.\n` +
            doomed
              .map((run) => `  ${run.id}  ${run.questions?.[0]?.text ?? ''}`.trimEnd())
              .join('\n');
      else if (
        !values.yes &&
        process.stdin.isTTY &&
        process.stderr.isTTY &&
        !(await confirm(`Delete ${what}? Authored concepts and sentences stay. [y/N] `))
      ) {
        output = 'Nothing was deleted.';
        process.exitCode = 1;
      } else {
        const result = await deleteEngineRuns(
          project,
          values.all ? { all: true } : { ids: [values.run] },
        );
        output = values.json
          ? result
          : result.reset
            ? 'Engine data reset; concepts and sentences retained'
            : 'Deleted engine run and its owned data: ' + values.run;
      }
    } else if (action === 'recoil') {
      const locus = named(() =>
        recoilLocus(project, {
          statement: values.statement,
          role: values.role,
          question: values.question,
          scope: values.scope,
          caseText: values['case-text'],
        }),
      );
      const report = await recoilReport(project, locus).catch((error) => {
        if (/^No such /u.test(error.message)) throw new EngineUsageError(error.message);
        throw error;
      });
      output = values.json ? report : formatRecoil(report);
    } else if (action === 'tensions') {
      const report = await tensionReport(project, { grain: Number(values.grain ?? 1) });
      output = values.json ? report : formatTensions(report);
    } else if (action === 'probe') {
      if (values.statement) named(() => recoilLocus(project, { statement: values.statement }));
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
            ...run,
            // The check's own provenance; one saved before checks kept it is
            // read now and says so.
            provenance: run.provenance ?? {
              ...answerProvenance(
                { projectId: run.projectId, projectRevision: run.projectDigest },
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
      const run = await runEngine(project, {
        input,
        actor: values.actor ?? 'unrecorded',
        via: 'cli',
        acquireMissing: !values.offline,
        trace: Boolean(values.trace),
        signal: controller.signal,
        progress: (message) => {
          if (values.explain || process.stderr.isTTY) process.stderr.write(message + '\n');
        },
        onUpdate: (current) => {
          const stage = current.stages.at(-1);
          if ((values.explain || process.stderr.isTTY) && stage && stage.id !== last)
            process.stderr.write(stage.label + '\n');
          last = stage?.id;
        },
      });
      process.removeListener('SIGINT', interrupt);
      output = values.json
        ? run
        : describe(run, {
            explain: values.explain,
            offline: values.offline,
            relations: await questionRelations(project, run),
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
  process.stderr.write('Error: ' + error.message + '\n');
  if (error instanceof EngineUsageError)
    process.stderr.write(`Use ${program} --help or ${program} <command> --help.\n`);
  process.exitCode = controller.signal.aborted ? 130 : error instanceof EngineUsageError ? 2 : 1;
} finally {
  process.removeListener('SIGINT', interrupt);
}
