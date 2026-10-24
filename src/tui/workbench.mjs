import { readSavedRecording } from '../project/storage/recordings.mjs';
/** Workbench CLI: arguments, saved preferences, and initial workspace loading. */
import { readFile } from 'node:fs/promises';
import { resolve, join, basename, dirname } from 'node:path';
import { openProject, projectTree } from '../project/authoring/project.mjs';
import { loadInterpretationDecisions } from '../recording/interpretation.mjs';
import { indexRecording, initialSelection, selectNode, snapshot } from './recordings/view.mjs';
import { localPath } from './shell/paths.mjs';
import { runWorkbench } from './shell/app.mjs';
import { backgroundProjectInquiry } from '../project/inquiries/background.mjs';
import { roleStatements } from '../engine/statements.mjs';
import { workbenchArguments, workbenchHelp } from './shell/arguments.mjs';

// A downstream reader may finish before a snapshot or help text is written.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const snapshotLines = (value, depth, label = '') =>
  String(value)
    .split(/\r?\n/u)
    .map((line, i) => `${'  '.repeat(depth)}${i ? ' '.repeat(label.length) : label}${line}\n`)
    .join('');

async function main() {
  const options = workbenchArguments(process.argv.slice(2));
  const interactive = !options.snapshot && process.stdin.isTTY && process.stdout.isTTY;
  if (options.help || (!interactive && !options.project && !options.recording)) {
    process.stdout.write(workbenchHelp);
    return;
  }
  const recordingArg = options.recording;
  const projectArg = options.project;
  const actor = options.actor ?? 'participant';
  const defaultRecording = resolve('');
  const projectsHome = resolve('.proj');
  const preferencesPath = join(projectsHome, '.workbench.json');
  let preferredSidebar = null;
  let recordingsVisible = true;
  let recordingsFraction = 1 / 3;
  let developmentFraction = 0.52;
  const projectLayouts = {};
  try {
    const saved = JSON.parse(await readFile(preferencesPath, 'utf8'));
    if (Number.isInteger(saved.sidebarWidth) && saved.sidebarWidth >= 24)
      preferredSidebar = saved.sidebarWidth;
    recordingsVisible = saved.recordingsVisible !== false;
    if (
      Number.isFinite(saved.recordingsFraction) &&
      saved.recordingsFraction > 0 &&
      saved.recordingsFraction < 1
    )
      recordingsFraction = saved.recordingsFraction;
    if (
      Number.isFinite(saved.developmentFraction) &&
      saved.developmentFraction > 0 &&
      saved.developmentFraction < 1
    )
      developmentFraction = saved.developmentFraction;
    for (const [id, layout] of Object.entries(saved.projects ?? {}))
      if (
        Number.isFinite(layout?.developmentFraction) &&
        layout.developmentFraction > 0 &&
        layout.developmentFraction < 1
      )
        projectLayouts[id] = { developmentFraction: layout.developmentFraction };
  } catch {
    /* A missing or invalid preference leaves the default layout usable. */
  }
  const nodeArg = options.node,
    visitArg = options.visit;
  const occurrenceArg = options.occurrence,
    detailArg = options.detail;
  const noColor = options.noColor;
  let mode = projectArg ? 'project' : recordingArg ? 'recording' : 'home';
  const projectPath = projectArg ? localPath(projectArg) : null;
  let project = projectPath
    ? await openProject(
        basename(projectPath) === 'project.json' ? dirname(projectPath) : projectPath,
      )
    : null;
  let placementId = project?.data.placements[0].id;
  let ix =
    mode === 'recording'
      ? indexRecording(
          await readSavedRecording(recordingArg ? localPath(recordingArg) : defaultRecording),
        )
      : null;
  let selection = ix ? initialSelection(ix) : null;
  if (nodeArg) selection = selectNode(ix, selection, nodeArg);
  if (visitArg) {
    const visit = ix.visits.get(visitArg);
    if (!visit) throw new Error(`unknown visit ${visitArg}`);
    if (nodeArg && visit.nodeId !== nodeArg)
      throw new Error('selected visit belongs to another node');
    selection = {
      ...selectNode(ix, selection, visit.nodeId),
      visitId: visitArg,
      occurrenceId: visit.occurrenceIds[0] ?? null,
    };
  }
  if (occurrenceArg) {
    const occurrence = ix.occurrences.get(occurrenceArg);
    if (!occurrence || occurrence.nodeId !== selection.nodeId)
      throw new Error('selected occurrence is absent or belongs to another node');
    selection.occurrenceId = occurrenceArg;
  }
  const detailNames = ['scope', 'source', 'proposal', 'provenance'];
  if (detailArg && !detailNames.includes(detailArg))
    throw new Error(`unknown detail ${detailArg}; choose ${detailNames.join(', ')}`);
  if (selection) selection.detail = detailArg ?? 'source';
  if (!interactive) {
    process.stdout.write(
      project
        ? `${project.data.name}\n` +
            projectTree(project.data)
              .map(({ concept, placement, depth }) => {
                const item = { label: concept.name, depth, placementId: placement.id };
                return (
                  snapshotLines(item.label, item.depth) +
                  (concept?.description
                    ? snapshotLines(concept.description, item.depth + 1, 'Description: ')
                    : '') +
                  roleStatements(project.data, item.placementId)
                    .flatMap((block) =>
                      block.texts.map((text, i) =>
                        snapshotLines(
                          text,
                          item.depth + 1,
                          block.kind === 'answer' ? (i ? 'Answer: ' : 'Question: ') : '',
                        ),
                      ),
                    )
                    .join('')
                );
              })
              .join('')
        : snapshot(
            ix,
            selection,
            await loadInterpretationDecisions(
              recordingArg ? localPath(recordingArg) : defaultRecording,
              ix,
            ),
          ),
    );
  } else {
    await runWorkbench(
      {
        mode,
        project,
        placementId,
        ix,
        selection,
        preferredSidebar,
        recordingsVisible,
        recordingsFraction,
        developmentFraction,
        projectLayouts,
        activeRecordingPath:
          mode === 'recording' ? (recordingArg ? localPath(recordingArg) : defaultRecording) : null,
      },
      {
        projectsHome,
        preferencesPath,
        defaultRecording,
        detailArg,
        noColor,
        readOnlyRecording: mode === 'recording',
        actor,
        captureInquiry: backgroundProjectInquiry,
        preserveRecordingSelection: Boolean(nodeArg || visitArg || occurrenceArg),
      },
    );
  }
}
try {
  await main();
} catch (error) {
  process.stderr.write(`workbench: ${error.message}\nUse --help for usage.\n`);
  process.exitCode = 1;
}
