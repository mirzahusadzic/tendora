/** Execute the deterministic engine on ordinary authored projects. */
import { basename, join, resolve } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { EngineUsageError, parseEngineArguments } from './engine-options.mjs';
import { createProject, openProject, saveProject } from '../project/authoring/project.mjs';
import { authorEngineKnowledge } from '../project/authoring/knowledge.mjs';
import { selectCase, authorCase } from '../project/inquiries/investigation.mjs';
import { resolveInquiryPlacement } from '../project/inquiries/scope.mjs';
import { inputFromProject } from '../engine/input.mjs';
import { runEngine } from '../engine/run.mjs';
import { deleteEngineRuns } from '../project/inquiries/delete-engine-runs.mjs';
import {
  compactProjectStorage,
  projectStorageUsage,
} from '../project/inquiries/project-storage.mjs';
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
try {
  const { action, values, help } = parseEngineArguments(process.argv.slice(2));
  if (help) console.log(help);
  else {
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
        : await openProject(location);
    const placement = (selector) => resolveInquiryPlacement(project, selector);
    const describe = (run) => {
      if (run.cache === 'recheck' && !run.answer)
        return (
          'Saved question: ' +
          run.questions[0].text +
          (run.case ? '\nCase: ' + run.case : '') +
          '\nOpen it in Development to check against current sources.\nRun: ' +
          run.id
        );
      const lines = [run.status + ': ' + (run.questions?.[0]?.text ?? run.id)];
      for (const answer of [...(run.answer?.answers ?? []), ...(run.answer?.candidates ?? [])]) {
        lines.push(
          (run.answer?.answers.includes(answer) ? 'Answer: ' : 'Candidate: ') + answer.text,
        );
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
        for (const detail of answer.dependsOn ?? answer.qualifications ?? [])
          lines.push('  ' + detail);
        if (values.explain) {
          lines.push('  Sources: ' + (answer.sourceIds ?? []).join(', '));
          lines.push(
            '  Bindings: ' + (answer.bindings ?? []).map((binding) => binding.id).join(', '),
          );
          if (answer.ruleIds?.length) lines.push('  Rules: ' + answer.ruleIds.join(', '));
          if (answer.bindingIds?.length)
            lines.push('  References: ' + answer.bindingIds.join(', '));
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
      for (const opening of run.openings ?? [])
        lines.push(
          'Open: ' +
            (opening.label ??
              (opening.role ? `${opening.from} ${opening.role} ${opening.to}` : opening.concept) ??
              opening.text ??
              opening.kind) +
            ': ' +
            opening.reason,
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
        for (const item of items.filter((item) => values.explain || item.kind === 'question')) {
          lines.push(`  ${item.kind}: ${item.text}`);
          for (const finding of item.findings ?? []) lines.push('  Check: ' + finding.reason);
          for (const candidate of item.candidates ?? [])
            lines.push(
              `  Lexical hint: ${JSON.stringify(candidate.evidence.text)} matches ${candidate.evidence.method === 'propbank-inflection' ? 'an inflection of ' : ''}PropBank alias ${JSON.stringify(candidate.evidence.lexeme)} for ${candidate.predicate} (${candidate.description}); this does not establish a replacement or its roles.`,
            );
        }
        if (!values.explain && items.some((item) => item.kind !== 'question'))
          lines.push('  Use --explain to inspect source and case vocabulary findings.');
      }
      if (values.explain && run.answer?.grammar) {
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
        if (values.explain || /time limit/u.test(issue.reason ?? ''))
          lines.push('Interpretation: ' + issue.reason);
      if (run.status === 'needs-amr' && values.offline)
        lines.push('Hint: Run without --offline to acquire the missing question AMR.');
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
    };
    let output;
    if (action === 'init')
      output = values.json
        ? { project: location, id: project.data.id }
        : 'Created empty project: ' + location;
    else if (action === 'storage' || action === 'compact') {
      const result =
        action === 'storage'
          ? await projectStorageUsage(project)
          : await compactProjectStorage(project, { force: true });
      output = values.json ? result : JSON.stringify(result, null, 2);
    } else if (action === 'knowledge') {
      const entry = JSON.parse(await readFile(resolve(values.file), 'utf8'));
      await saveProject(project, authorEngineKnowledge(project.data, entry));
      output = values.json
        ? { id: entry.id, name: entry.name }
        : 'Stored authored engine knowledge: ' + entry.name;
    } else if (action === 'runs') {
      const runs = await listEngineRuns(project);
      output = values.json ? runs : runs.map(describe).join('\n\n') || 'No engine runs';
    } else if (action === 'delete') {
      const result = await deleteEngineRuns(
        project,
        values.all ? { all: true } : { ids: [values.run] },
      );
      output = values.json
        ? result
        : result.reset
          ? 'Engine data reset; concepts and sentences retained'
          : 'Deleted engine run and its owned data: ' + values.run;
    } else if (action === 'show') {
      const run = await readEngineRun(project, values.run);
      output = values.json
        ? {
            ...run,
            ...(values.explain && run.resultRef
              ? { result: await readEngineArtifact(project, run.resultRef) }
              : {}),
          }
        : describe(run);
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
      output = values.json ? run : describe(run);
      await compactProjectStorage(project);
      if (values.json) {
        const stored = await readEngineRun(project, run.id);
        output = { ...run, cache: stored.cache };
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
    process.stderr.write('Use engine --help or engine <command> --help.\n');
  process.exitCode = controller.signal.aborted ? 130 : error instanceof EngineUsageError ? 2 : 1;
} finally {
  process.removeListener('SIGINT', interrupt);
}
