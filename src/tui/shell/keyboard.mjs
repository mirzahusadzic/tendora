/** Keyboard routing for modal forms, panes, projects, and recorded findings. */
import { readingViewTransitions } from './pane-actions.mjs';
import { cycleOccurrence, viewModel } from '../recordings/view.mjs';
import { readingViews, hasRecordingProject, readingDevelopment } from './state.mjs';
import { activeCommand } from './commands.mjs';
import { projectTree } from '../../project/authoring/project.mjs';
import { pageStep } from './layout.mjs';
import { confirmationKey } from './confirmation.mjs';

export function createKeyboard({
  startContinuation,
  selectOpening,
  openParent,
  openResult,
  hasOpenings,
  state,
  close,
  finishResize,
  formKey,
  closeHelp,
  scrollKey,
  resetView,
  saveLayout,
  setNotice,
  loadProjectRecording,
  homeLabels,
  showProjects,
  activateHome,
  handleProjectKey,
  setPage,
  recordingNavigation,
  navigationSelection,
  change,
}) {
  async function handleKey(key, data) {
    if (data?.isPaste) {
      if (
        state.form?.fields?.length &&
        !state.form.busy &&
        !state.form.move &&
        !state.form.confirm &&
        !state.form.readOnly &&
        state.focus === 'reading'
      ) {
        await formKey(key, data);
        if (state.form?.workspace) await state.saveAsk();
      }
      return;
    }
    if (state.resizing && key !== 'CTRL_C') {
      if (key === 'ESCAPE') finishResize(false);
      return;
    }
    if (key !== 'CTRL_C') {
      const command = activeCommand(state, key);
      if (command) {
        try {
          await command.run();
        } catch (error) {
          if (!state.form) throw error;
          state.form.error = error.message;
          setNotice('Not applied');
        }
        return;
      }
    }
    if (state.form?.investigationBrowser && key !== 'CTRL_C') {
      if (['TAB', 'SHIFT_TAB'].includes(key)) {
        state.focus = state.focus === 'nodes' ? 'reading' : 'nodes';
        return;
      }
      if (state.focus === 'nodes' || ['ESCAPE', 'ENTER', 'KP_ENTER'].includes(key)) {
        const form = state.form,
          selected = form.index;
        await formKey(key, data);
        if (state.form === form && selected !== form.index) {
          state.offset = 0;
          await form.onSelect?.();
        }
      } else scrollKey(key);
      return;
    }
    if (state.form?.workspace && key !== 'CTRL_C') {
      if (state.form.busy && key !== 'ESCAPE') return;
      if (['TAB', 'SHIFT_TAB'].includes(key)) {
        state.focus = state.focus === 'nodes' ? 'reading' : 'nodes';
        return;
      }
      if (state.focus === 'nodes') {
        if (['ENTER', 'KP_ENTER', 'ESCAPE'].includes(key)) {
          state.focus = 'reading';
          return;
        }
        const ids = projectTree(state.project.data).map((item) => item.placement.id);
        const page = pageStep(state.viewport?.nodeHits);
        const at = ids.indexOf(state.placementId),
          delta = ['UP', 'k'].includes(key)
            ? -1
            : ['DOWN', 'j'].includes(key)
              ? 1
              : key === 'PAGE_UP'
                ? -page
                : key === 'PAGE_DOWN'
                  ? page
                  : 0;
        if (delta || ['HOME', 'END'].includes(key)) {
          state.placementId =
            key === 'HOME'
              ? ids[0]
              : key === 'END'
                ? ids.at(-1)
                : ids[Math.max(0, Math.min(ids.length - 1, at + delta))];
          await state.saveAsk();
        }
        return;
      }
      if (key === 'ESCAPE' && !state.form.busy) await state.saveAsk();
      await formKey(key, data);
      if (state.form?.workspace) await state.saveAsk();
      return;
    }
    if (state.form && key !== 'CTRL_C') {
      await formKey(key, data);
      return;
    }
    if (key === 'CTRL_C') {
      if (state.form?.workspace) await state.saveAsk();
      close();
      return;
    }
    if (state.quitPrompt) {
      const decision = confirmationKey(state.quitPrompt, key);
      if (decision === 'yes') {
        close();
        return;
      }
      if (decision === 'no') {
        ({ focus: state.focus, offset: state.offset } = state.quitPrompt);
        state.quitPrompt = null;
      }
      return;
    }
    if (key === 'q') {
      state.quitPrompt = { yes: false, focus: state.focus, offset: state.offset };
      state.focus = 'reading';
      state.offset = 0;
      setNotice('');
      return;
    }
    // Help is modal. No hidden selection or page changes behind it.
    if (state.help) {
      if (['ESCAPE', 'ENTER', 'KP_ENTER', 'BACKSPACE', '?', 'i'].includes(key)) closeHelp();
      else scrollKey(key);
      return;
    }
    if (await state.workflow?.handleKey(key)) return;
    if (state.mode === 'recording' && hasRecordingProject(state) && key === 'b') {
      state.recordingReturn = Object.fromEntries(
        [
          'mode',
          'focus',
          'offset',
          'nodesOffset',
          'developmentOffset',
          'projectEntryId',
          'projectReadingOrigin',
          'projectPanel',
          'placementId',
          'investigationReturn',
          'page',
          'pageTrail',
          'expandReading',
          'savedOffsets',
          'ix',
          'selection',
          'activeRecordingPath',
          'interpretationDecisions',
          'findingsList',
          'investigation',
          'recordingIndex',
        ].map((name) => [name, state[name]]),
      );
      const placementId = [
        state.selection.nodeId,
        state.ix.recording.project.placementId,
        state.project.data.placements[0]?.id,
      ].find((id) => state.project.data.placements.some((placement) => placement.id === id));
      state.mode = 'project';
      state.investigationReturn = false;
      resetView();
      await state.refreshProjectOutline?.();
      state.projectPanel = 'development';
      state.selectProjectEntry(placementId);
      return;
    }
    if (key === 'R' && state.project && (state.mode === 'project' || hasRecordingProject(state))) {
      if (state.projectDevelopmentOutline?.().length || hasRecordingProject(state)) {
        state.projectPanel = state.projectPanel === 'recordings' ? 'development' : 'recordings';
        state.recordingsVisible = state.projectPanel === 'recordings';
        if (['development', 'recordings'].includes(state.focus)) state.focus = state.projectPanel;
        return;
      }
      state.recordingsVisible = !state.recordingsVisible;
      if (!state.recordingsVisible && state.focus === 'recordings') state.focus = 'nodes';
      try {
        await saveLayout();
      } catch (error) {
        setNotice(`Layout not saved: ${error.message}`);
      }
      return;
    }
    if (['TAB', 'SHIFT_TAB'].includes(key) && state.mode !== 'home') {
      const panes =
        state.workflow?.active() || state.viewport?.developmentHeight
          ? ['nodes', 'reading', 'development']
          : state.project &&
              (state.mode === 'project' || hasRecordingProject(state)) &&
              state.viewport?.recordingsHeight
            ? ['nodes', 'reading', 'recordings']
            : ['nodes', 'reading'];
      state.focus =
        panes[(panes.indexOf(state.focus) + (key === 'TAB' ? 1 : panes.length - 1)) % panes.length];
      if (['nodes', 'development'].includes(state.focus)) state.projectReadingOrigin = state.focus;
      return;
    }
    if (key === '?' && state.mode !== 'home') {
      state.helpState = {
        focus: state.focus,
        offset: state.offset,
        selectable:
          ['nodes', 'development', 'recordings'].includes(state.focus) ||
          Boolean(state.viewport?.choiceHits?.length),
        actions: [
          ...new Map([
            ...(state.helpActionChoices ?? state.viewport?.actionHits ?? []).map(
              ({ key, description }) => [key, description],
            ),
            ...(state.workflow?.active()
              ? state.workflow
                  .actions()
                  .filter((item) => item.pane === state.focus || item.pane === 'global')
                  .map(({ key, description }) => [key, description])
              : []),
          ]).entries(),
        ],
      };
      state.help = true;
      state.focus = 'reading';
      state.offset = 0;
      return;
    }
    if (
      (state.focus === 'development' && hasRecordingProject(state)) ||
      (state.focus === 'reading' && readingDevelopment(state))
    ) {
      if (['ESCAPE', 'BACKSPACE'].includes(key)) return;
      if (key === 'f') {
        state.expandReading = !state.expandReading;
        return;
      }
      await handleProjectKey(key);
      return;
    }
    if (state.focus === 'recordings') {
      if (!state.recordingsVisible) return;
      const step = pageStep(state.viewport?.recordingHits, 'path');
      if (['UP', 'k', 'DOWN', 'j', 'PAGE_UP', 'PAGE_DOWN', 'HOME', 'END'].includes(key)) {
        const delta = ['UP', 'k'].includes(key)
          ? -1
          : ['DOWN', 'j'].includes(key)
            ? 1
            : key === 'PAGE_UP'
              ? -step
              : step;
        state.recordingIndex = Math.max(
          0,
          Math.min(
            state.recordings.length - 1,
            key === 'HOME'
              ? 0
              : key === 'END'
                ? state.recordings.length - 1
                : state.recordingIndex + delta,
          ),
        );
      } else if (['ENTER', 'KP_ENTER'].includes(key) && state.recordings[state.recordingIndex])
        await loadProjectRecording(state.recordings[state.recordingIndex].path);
      else if (['ESCAPE', 'BACKSPACE'].includes(key)) state.focus = 'nodes';
      return;
    }
    if (key === 'w' && state.focus === 'nodes' && state.mode !== 'home') {
      state.homeReturn = Object.fromEntries(
        [
          'mode',
          'project',
          'placementId',
          'ix',
          'selection',
          'activeRecordingPath',
          'interpretationDecisions',
          'recordings',
          'recordingIndex',
          'investigationReturn',
          'page',
          'focus',
          'offset',
          'nodesOffset',
          'recordingsOffset',
          'findingsList',
          'openingIndex',
          'expandReading',
          'pageTrail',
        ].map((name) => [name, state[name]]),
      );
      state.homeReturn.savedOffsets = new Map(state.savedOffsets);
      state.mode = 'home';
      state.investigationReturn = false;
      state.projectChoices = null;
      state.homeIndex = 0;
      resetView();
      return;
    }
    if (state.mode === 'home') {
      if (['TAB', 'SHIFT_TAB'].includes(key)) {
        state.focus = state.focus === 'nodes' ? 'reading' : 'nodes';
        return;
      }
      if (state.focus === 'reading' && !['ENTER', 'KP_ENTER', 'r'].includes(key)) {
        if (['ESCAPE', 'BACKSPACE'].includes(key)) state.focus = 'nodes';
        else scrollKey(key);
        return;
      }
      if (['ESCAPE', 'BACKSPACE'].includes(key) && !state.projectChoices && state.homeReturn) {
        const previous = state.homeReturn;
        state.homeReturn = null;
        Object.assign(state, previous);
        return;
      }
      const count = homeLabels().length;
      if (['ESCAPE', 'BACKSPACE'].includes(key) && state.projectChoices) {
        state.projectChoices = null;
        state.homeIndex = 1;
        resetView();
      } else if (key === 'r' && state.projectChoices) await showProjects();
      else if (['UP', 'k'].includes(key)) state.homeIndex = Math.max(0, state.homeIndex - 1);
      else if (['DOWN', 'j'].includes(key))
        state.homeIndex = Math.min(count - 1, state.homeIndex + 1);
      else if (['PAGE_UP', 'PAGE_DOWN'].includes(key))
        state.homeIndex = Math.max(
          0,
          Math.min(
            count - 1,
            state.homeIndex + (key === 'PAGE_UP' ? -1 : 1) * pageStep(state.viewport?.nodeHits),
          ),
        );
      else if (key === 'HOME') state.homeIndex = 0;
      else if (key === 'END') state.homeIndex = count - 1;
      else if (key === 'ENTER' || key === 'KP_ENTER') await activateHome();
      return;
    }
    if (state.mode === 'project' && !['?', 'TAB', 'SHIFT_TAB'].includes(key)) {
      await handleProjectKey(key);
      return;
    }
    if (key === 'r' && state.focus === 'nodes') {
      state.findingsList = !state.findingsList;
      state.nodesOffset = 0;
      state.focus = 'nodes';
      const ids = recordingNavigation().ids;
      if (state.findingsList && ids.length) change(() => navigationSelection(ids[0]), true);
      return;
    }
    if (key === 'TAB' || key === 'SHIFT_TAB') {
      state.focus = state.focus === 'nodes' ? 'reading' : 'nodes';
      return;
    }
    if (['ESCAPE', 'BACKSPACE'].includes(key)) {
      if (
        state.readOnlyRecording &&
        state.recordingParentTrail?.length &&
        !state.pageTrail?.length
      ) {
        Object.assign(state, state.recordingParentTrail.pop());
        setNotice('Linked question');
        return;
      }
      setPage(state.pageTrail?.at(-1) ?? 'overview');
      return;
    }
    if (state.mode === 'recording' && state.focus === 'reading') {
      if (key === 'B' && ['overview', 'scope'].includes(state.page)) {
        await openParent();
        return;
      }
      if (state.page === 'scope' && state.ix.recording.project && hasOpenings()) {
        if (key === 'C' && !state.readOnlyRecording) {
          await openResult();
          return;
        }
        if (['ENTER', 'KP_ENTER'].includes(key) && !state.readOnlyRecording) {
          await startContinuation();
          return;
        }
        if (['UP', 'DOWN', 'k', 'j'].includes(key)) {
          selectOpening(['UP', 'k'].includes(key) ? -1 : 1);
          return;
        }
      }
    }
    if (key === 'ENTER' || key === 'KP_ENTER') {
      if (state.focus === 'nodes') {
        setPage('overview');
        state.focus = 'reading';
      }
      return;
    }
    if (state.focus === 'nodes') {
      if (key === 'HOME' || key === 'END') {
        const ids = recordingNavigation().ids;
        if (ids.length)
          change(() => navigationSelection(key === 'HOME' ? ids[0] : ids.at(-1)), true);
      } else {
        const page = pageStep(state.viewport?.nodeHits);
        const delta = ['UP', 'k'].includes(key)
          ? -1
          : ['DOWN', 'j'].includes(key)
            ? 1
            : key === 'PAGE_UP'
              ? -page
              : key === 'PAGE_DOWN'
                ? page
                : 0;
        if (delta) {
          const ids = recordingNavigation().ids;
          const at = Math.max(
            0,
            Math.min(
              ids.length - 1,
              ids.indexOf(
                state.findingsList ? state.selection.occurrenceId : state.selection.nodeId,
              ) + delta,
            ),
          );
          if (ids.length) change(() => navigationSelection(ids[at]), true);
        }
      }
      return;
    }
    if (key === 'f') state.expandReading = !state.expandReading;
    else if (readingViews[key]) {
      const view = viewModel(state.ix, { ...state.selection, detail: state.page });
      const transition = readingViewTransitions(state, view).find((item) => item.key === key);
      if (transition) setPage(transition.page);
    } else if (state.page === 'setup') scrollKey(key);
    else if (
      ['LEFT', 'RIGHT'].includes(key) &&
      ['overview', 'source', 'scope', 'context', 'interpretation'].includes(state.page)
    )
      change(() => cycleOccurrence(state.ix, state.selection, key === 'LEFT' ? -1 : 1));
    else scrollKey(key);
  }

  return { handleKey };
}
