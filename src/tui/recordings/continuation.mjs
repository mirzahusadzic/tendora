import { readSavedRecording } from '../../project/storage/recordings.mjs';
/** Continue a selected recorded opening through one editable question form. */
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openProject } from '../../project/authoring/project.mjs';
import { listProjectRecordings } from '../../project/inquiries/recordings.mjs';
import { readContinuationParent } from '../../project/inquiries/continuation.mjs';
import { evidenceOpenings } from '../../recording/continuation.mjs';
import { interpretationRevision } from '../../recording/revisions.mjs';
import { loadInterpretationDecisions } from '../../recording/interpretation.mjs';
import { indexRecording, initialSelection, rankedFindings } from './view.mjs';

export function createContinuation({ state, resetView, setNotice }) {
  function openings() {
    return evidenceOpenings(state.ix, state.selection, state.interpretationDecisions);
  }
  function selectOpening(delta) {
    const count = openings().length;
    state.openingIndex = Math.max(0, Math.min(count - 1, (state.openingIndex ?? 0) + delta));
  }
  async function openResult() {
    const edge = openings()[state.openingIndex ?? 0];
    const result = state.recordings.find(
      (item) =>
        item.continuation?.parentPath === state.activeRecordingPath &&
        item.continuation.occurrenceId === state.selection.occurrenceId &&
        (item.continuation.openingId
          ? item.continuation.openingId === edge?.id
          : item.continuation.edgeId === edge?.edge?.id),
    );
    if (!result) {
      setNotice('Result unavailable');
      return;
    }
    const ix = indexRecording(await readSavedRecording(result.path));
    const decisions = await loadInterpretationDecisions(result.path, ix);
    if (ix.recording.continuation.parent.revision !== interpretationRevision(state.ix.recording))
      throw new Error('This result refers to a different parent revision.');
    state.ix = ix;
    state.activeRecordingPath = result.path;
    state.interpretationDecisions = decisions;
    state.answerKnowledge = null;
    state.selection = { ...initialSelection(ix), visitId: null };
    const first = rankedFindings(ix, decisions)[0];
    if (first) state.selection = { nodeId: first.nodeId, occurrenceId: first.id, visitId: null };
    resetView();
    state.focus = 'reading';
    state.findingsList = true;
    state.recordingIndex = state.recordings.indexOf(result);
  }
  async function openParent() {
    const context = state.ix.recording.continuation;
    if (!context) return;
    const ix = indexRecording(await readContinuationParent(context));
    const decisions = await loadInterpretationDecisions(context.parent.path, ix);
    if (state.readOnlyRecording) {
      const previous = Object.fromEntries(
        [
          'ix',
          'selection',
          'activeRecordingPath',
          'interpretationDecisions',
          'answerKnowledge',
          'recordingIndex',
          'page',
          'pageTrail',
          'focus',
          'findingsList',
          'openingIndex',
          'offset',
          'nodesOffset',
          'expandReading',
        ].map((name) => [name, state[name]]),
      );
      previous.savedOffsets = new Map(state.savedOffsets);
      (state.recordingParentTrail ??= []).push(previous);
    }
    if (
      !state.readOnlyRecording &&
      (!state.project || state.project.data.id !== context.parent.project.id)
    ) {
      try {
        const project = await openProject(dirname(context.parent.project.path));
        if (project.data.id === context.parent.project.id) {
          state.recordings = await listProjectRecordings(project);
          state.project = project;
          state.placementId = context.parent.project.placementId;
          state.investigationReturn = true;
        }
      } catch {
        /* Parent evidence remains readable when its working project is unavailable. */
      }
    }
    state.recordingIndex = Math.max(
      0,
      state.recordings.findIndex((item) => item.path === context.parent.path),
    );
    state.ix = ix;
    state.interpretationDecisions = decisions;
    state.answerKnowledge = null;
    state.activeRecordingPath = context.parent.path;
    state.selection = {
      nodeId: context.parent.nodeId,
      occurrenceId: context.parent.occurrenceId,
      visitId: null,
    };
    resetView();
    state.page = 'scope';
    state.focus = 'reading';
    state.findingsList = true;
    state.openingIndex = Math.max(
      0,
      openings().findIndex((item) =>
        context.version === 2
          ? item.id === context.opening.id
          : item.edge?.id === context.opening.edge.id,
      ),
    );
    setNotice('Parent opening');
  }
  const startContinuation = () => state.followup(openings()[state.openingIndex ?? 0] ?? null);
  return {
    startContinuation,
    selectOpening,
    openParent,
    openResult,
    hasOpenings: () => openings().length > 0,
  };
}
