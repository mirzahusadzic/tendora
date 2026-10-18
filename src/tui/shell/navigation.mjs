/** Selection, focus restoration, and reading positions. */
import {
  initialSelection,
  rankedFindings,
  navigable,
  selectNode,
  viewModel,
} from '../recordings/view.mjs';

/** Choose the initial list once per opening; subsequent redraws retain the user's choice. */
export function openRecordingView(state, { preserveSelection = false } = {}) {
  const findings = rankedFindings(state.ix, state.interpretationDecisions);
  const selected =
    preserveSelection && state.selection
      ? (findings.find((item) => item.id === state.selection.occurrenceId) ??
        findings.find((item) => item.nodeId === state.selection.nodeId))
      : findings[0];
  state.findingsList = Boolean(selected);
  state.nodesOffset = 0;
  if (selected)
    state.selection = {
      ...state.selection,
      nodeId: selected.nodeId,
      occurrenceId: selected.id,
      visitId: null,
    };
  else state.selection ??= { ...initialSelection(state.ix), visitId: null };
}

export function createNavigation({ state, setNotice, findingsRows }) {
  const recordingNavigation = () =>
    state.findingsList
      ? { ids: rankedFindings(state.ix, state.interpretationDecisions).map((item) => item.id) }
      : navigable(state.ix, state.selection.nodeId);
  const navigationSelection = (id) =>
    state.findingsList
      ? {
          ...state.selection,
          nodeId: state.ix.occurrences.get(id).nodeId,
          occurrenceId: id,
          visitId: null,
        }
      : selectNode(state.ix, state.selection, id);
  function resetView() {
    state.openingIndex = 0;
    state.page = 'overview';
    state.pageTrail = [];
    state.help = false;
    state.form = null;
    setNotice('');
    state.failure = '';
    state.focus = 'nodes';
    // Reading width is a layout choice, independent of the material being opened.
    state.offset = 0;
    state.nodesOffset = 0;
    state.savedOffsets.clear();
  }
  function change(fn, nodeChanged = false) {
    if (nodeChanged) {
      if (state.projectReadingOrigin === 'development') state.offset = 0;
      state.projectReadingOrigin = 'nodes';
    }
    const next = fn();
    if (
      next.nodeId === state.selection.nodeId &&
      next.visitId === state.selection.visitId &&
      next.occurrenceId === state.selection.occurrenceId
    )
      return;
    let section;
    if (
      !nodeChanged &&
      state.page === 'overview' &&
      state.offset > 0 &&
      state.viewport.readingWidth
    ) {
      const rows = findingsRows(
        viewModel(state.ix, { ...state.selection, detail: state.page }),
        state.viewport.readingWidth,
      );
      for (let i = 0; i <= state.offset && i < rows.length; i++) {
        if (rows[i].tone === 'section') section = rows[i].text;
      }
    }
    state.openingIndex = 0;
    state.selection = next;
    state.offset = 0;
    state.savedOffsets.clear();
    if (section) {
      const rows = findingsRows(
        viewModel(state.ix, { ...state.selection, detail: state.page }),
        state.viewport.readingWidth,
      );
      state.offset = Math.max(
        0,
        rows.findIndex((item) => item.tone === 'section' && item.text === section),
      );
    }
    // The starting material introduces the run; a node selection opens its examination.
    if (nodeChanged && state.page === 'setup') setPage('overview');
  }
  function setPage(next) {
    if (next === state.page) return;
    state.savedOffsets.set(state.page, state.offset);
    state.pageTrail ??= [];
    if (next === 'overview') state.pageTrail = [];
    else if (state.pageTrail.includes(next))
      state.pageTrail = state.pageTrail.slice(0, state.pageTrail.lastIndexOf(next));
    else state.pageTrail.push(state.page);
    state.page = next;
    state.offset = state.savedOffsets.get(state.page) ?? 0;
  }
  function closeHelp() {
    state.help = false;
    ({ focus: state.focus, offset: state.offset } = state.helpState);
    state.helpState = null;
  }
  function scrollKey(key) {
    const pageSize = Math.max(1, (state.viewport?.visibleRows ?? 8) - 1);
    if (key === 'HOME') state.offset = 0;
    else if (key === 'END') state.offset = state.maxOffset;
    else if (['UP', 'k'].includes(key)) state.offset--;
    else if (['DOWN', 'j'].includes(key)) state.offset++;
    else if (['PAGE_UP', '['].includes(key)) state.offset -= pageSize;
    else if (['PAGE_DOWN', ']'].includes(key)) state.offset += pageSize;
    state.offset = Math.max(0, Math.min(state.maxOffset, state.offset));
  }

  return {
    recordingNavigation,
    navigationSelection,
    resetView,
    change,
    setPage,
    closeHelp,
    scrollKey,
  };
}
