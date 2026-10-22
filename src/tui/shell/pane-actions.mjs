/** Each shortcut names its owner, key, and action in the current workspace state. */
import { evidenceOpenings } from '../../recording/continuation.mjs';
import { interpretationRevision } from '../../recording/revisions.mjs';
import { followupFor } from '../../project/inquiries/investigation.mjs';
import { formActions, formActionReserve, formActionSection } from './form-actions.mjs';

import { readingViews, pageLabels, readingDevelopment, hasRecordingProject } from './state.mjs';
import { selectedMaterial, rankedFindings } from '../recordings/view.mjs';
import { situatedCommands } from './commands.mjs';

const displayKey = (key) =>
  key === 'ESCAPE'
    ? 'esc'
    : /^[A-Z]$/u.test(key)
      ? `shift+${key.toLowerCase()}`
      : key
          .replace(/(Ctrl|Shift|Alt)-/gu, '$1+')
          .replaceAll('_', '+')
          .toLowerCase();
const action = (pane, key, description) => {
  const shown = displayKey(key);
  const inputKey =
    key.length === 1
      ? key
      : ({
          Esc: 'ESCAPE',
          esc: 'ESCAPE',
          Enter: 'ENTER',
          'Tab/Shift-Tab': 'TAB',
          '←→': 'RIGHT',
          '↑↓': 'DOWN',
        }[key] ?? key.replace(/[+-]/gu, '_').toUpperCase());
  return { pane, key: shown, inputKey, description, label: `${shown} ${description}` };
};
const formAction = (label) => {
  const at = label.indexOf(' ');
  return {
    ...action('reading', label.slice(0, at), label.slice(at + 1)),
    section: formActionSection(label),
  };
};

/** Each transition needs material in its owning view. */
export function readingViewTransitions(state, view) {
  const material = selectedMaterial(state.ix, state.selection);
  const back = state.pageTrail?.at(-1) ?? 'overview';
  return Object.entries(readingViews).flatMap(([key, item]) => {
    if (key === 't') return [];
    if (state.page === item.page)
      return [
        {
          key,
          page: back,
          back: true,
          description:
            state.readOnlyRecording &&
            state.recordingParentTrail?.length &&
            !state.pageTrail?.length
              ? 'back to linked question'
              : `back to ${pageLabels[back].toLowerCase()}`,
        },
      ];
    if (
      (state.page === 'source' && key === 'v' && material.sources.length) ||
      (state.page === 'provenance' && key === 'i')
    )
      return [{ key, page: item.page, description: item.description }];
    if (state.page !== 'overview' || ['v', 'i'].includes(key)) return [];
    if (key === 'a' && !material.sources.length) return [];
    if (
      key === 's' &&
      !evidenceOpenings(state.ix, state.selection, state.interpretationDecisions).length
    )
      return [];
    if (key === 'c' && !material.checks.length) return [];
    if (key === 'p' && !material.visits.some((visit) => visit.proposalIds.length)) return [];
    return [{ key, page: item.page, description: item.description }];
  });
}

export function paneActions({ state, view, projectActionEnabled, canDeleteSentence = false }) {
  const result = {
    nodes: [],
    development: [],
    reading: [],
    recordings: [],
    global: [],
    reserves: {},
  };
  let formReserve = null;
  const add = (pane, key, description) => result[pane].push(action(pane, key, description));
  const modal = Boolean(
    (state.form && !state.form.workspace && !state.form.investigationBrowser) ||
    state.quitPrompt ||
    state.help,
  );
  const recordingsAvailable =
    state.project && (state.mode === 'project' || hasRecordingProject(state));
  const developmentReading = readingDevelopment(state);
  if (state.form || state.quitPrompt) {
    const options = { quitPrompt: Boolean(state.quitPrompt), canDeleteSentence };
    result.reading = formActions(state.form, options).map(formAction);
    const reserve = formActionReserve(state.form, options).map(formAction);
    result.reserves.reading = reserve.map((item) => item.label);
    if (
      state.form &&
      !state.form.readOnly &&
      !state.form.busy &&
      !state.form.move &&
      !state.form.confirm &&
      !state.form.sections &&
      !state.quitPrompt
    )
      formReserve = reserve;
  } else if (state.help) {
    add('reading', 'Esc', 'back');
  } else {
    if (state.mode === 'home') {
      add('nodes', '↑↓', 'select project');
      add('nodes', 'Enter', 'open');
      if (state.projectChoices) {
        add('nodes', 'r', 'refresh projects');
        add('nodes', 'Esc', 'back');
      } else if (state.homeReturn)
        add(
          'nodes',
          'Esc',
          state.homeReturn.mode === 'recording' ? 'back to recording' : 'back to project',
        );
      add('reading', 'Enter', 'open');
    } else if (state.workflow?.active()) {
      add('nodes', '↑↓', 'select role');
      add('development', '↑↓', 'select question');
      // The roles pane lists what acts on the selected role. Projects is
      // app-wide; parent and child moves are navigation like ↑↓ (in help).
      add('global', 'w', 'projects');
      if (state.workflow.role()?.parentId)
        result.nodes.push({ ...action('nodes', 'LEFT', 'parent role'), helpOnly: true });
      if (state.workflow.role()?.children.length)
        result.nodes.push({ ...action('nodes', 'RIGHT', 'first child'), helpOnly: true });
    } else if (state.mode === 'project') {
      const selected = state.projectReadingEntry?.();
      const readOnly = selected?.readOnly;
      const concept = state.selectedConceptEntry?.();
      const enterLabel = (item) =>
        item?.referenceTo
          ? 'follow reference'
          : item?.kind === 'workspace'
            ? 'develop corpus'
            : item?.kind === 'material-concept'
              ? item.partId === 'question'
                ? item.open
                  ? 'add answer'
                  : 'edit question'
                : 'edit source'
              : item?.kind === 'concept'
                ? 'edit concept'
                : 'review';
      const descriptions = {
        ENTER: ['Enter', enterLabel(concept)],
        a: ['a', 'ask'],
        c: ['c', 'add child'],
        s: ['s', 'add sibling'],
        m: ['m', 'move branch'],
        x: ['x', 'delete branch'],
        r: ['r', 'reload'],
      };
      for (const [key, [display, description]] of Object.entries(descriptions))
        if (projectActionEnabled(key, 'nodes')) add('nodes', display, description);
      if (concept?.children?.length)
        add(
          'nodes',
          state.projectExpanded.has(concept.id) ? 'LEFT' : 'RIGHT',
          state.projectExpanded.has(concept.id) ? 'collapse' : 'expand',
        );
      else if (concept?.parentId) add('nodes', 'LEFT', 'parent');
      if (state.projectReferenceTrail?.length) add('nodes', 'Esc', 'back');
      add('nodes', 'w', 'projects');
      if (
        !readOnly &&
        projectActionEnabled('ENTER', 'reading') &&
        !state.engineReadingView?.() &&
        !['Corpus', 'Meaning'].includes(state.projectReadingTab)
      )
        add(
          'reading',
          'Enter',
          selected?.kind === 'concept' ? 'edit sentences' : enterLabel(selected),
        );
      if (projectActionEnabled('r', 'reading')) add('reading', 'r', 'reload');
    } else {
      add(
        'nodes',
        'Enter',
        view.occurrence
          ? 'inspect finding'
          : view.node.sourceIds.length
            ? 'inspect source'
            : 'open concept',
      );
      if (rankedFindings(state.ix, state.interpretationDecisions).length)
        add('nodes', 'r', state.findingsList ? 'browse nodes' : 'ranked findings');
      add('nodes', 'w', 'projects');
      if (!developmentReading) {
        const openings =
          state.page === 'scope' && state.ix.recording.project
            ? evidenceOpenings(state.ix, state.selection, state.interpretationDecisions)
            : [];
        if (openings.length && !state.readOnlyRecording) {
          const existing = followupFor(
            state.investigation?.data,
            {
              path: state.activeRecordingPath,
              recordingRevision: interpretationRevision(state.ix.recording),
              nodeId: state.selection.nodeId,
              occurrenceId: state.selection.occurrenceId,
            },
            openings[state.openingIndex ?? 0]?.id,
          );
          add(
            'reading',
            'Enter',
            existing
              ? existing.runs.length
                ? 'edit question'
                : 'resume question'
              : 'ask from opening',
          );
          const linked = state.recordings.some(
            (item) =>
              item.continuation?.parentPath === state.activeRecordingPath &&
              item.continuation.occurrenceId === view.occurrence?.id &&
              (item.continuation.openingId === openings[state.openingIndex ?? 0]?.id ||
                item.continuation.edgeId === openings[state.openingIndex ?? 0]?.edge?.id),
          );
          if (linked) add('reading', 'C', 'latest linked result');
        }
        for (const item of readingViewTransitions(state, view))
          add('reading', item.back ? 'esc' : item.key, item.description);
        if (['overview', 'scope'].includes(state.page) && state.ix.recording.continuation)
          add('reading', 'B', 'parent opening');
        if (
          state.page === 'overview' &&
          state.readOnlyRecording &&
          state.recordingParentTrail?.length
        )
          add('reading', 'Esc', 'back to linked question');
        if (
          view?.occurrences.length > 1 &&
          ['overview', 'source', 'scope', 'context', 'interpretation'].includes(state.page)
        )
          add('reading', '←→', 'source occurrence');
      }
    }

    const development =
      !state.workflow?.active() &&
      state.project &&
      (state.mode === 'project' || hasRecordingProject(state)) &&
      state.selectedDevelopmentEntry?.();
    if (development) {
      if (development.children?.length)
        add(
          'development',
          state.projectExpanded.has(development.id) ? 'LEFT' : 'RIGHT',
          state.projectExpanded.has(development.id) ? 'collapse' : 'expand',
        );
      else if (development.parentId) add('development', 'LEFT', 'parent');
    }

    if (state.mode !== 'home')
      add('reading', 'f', state.expandReading ? 'split panes' : 'expand reading');
    if (recordingsAvailable && !state.workflow?.active()) {
      if (state.recordingsVisible && state.recordings.length) {
        add('recordings', 'Enter', 'open');
      }
    }
  }
  if (state.form?.investigationBrowser) {
    add('nodes', 'Enter', state.form.submitLabel);
    add('nodes', 'Esc', 'back');
  }
  for (const item of situatedCommands(state)) {
    if (item.presentation === 'choice') continue;
    if (item.presentation === 'workspace') {
      result[item.pane] = result[item.pane].filter((old) => old.inputKey !== item.key);
      if (item.pane !== state.focus && item.pane !== 'global') continue;
    }
    const next = action(
      item.presentation === 'workspace' ? 'global' : item.pane,
      item.key,
      item.description,
    );
    if (item.displayKey) {
      next.key = item.displayKey;
      next.label = `${item.displayKey} ${item.description}`;
    }
    next.helpOnly = item.helpOnly;
    next.section = item.section ?? formActionSection(next.label);
    result[next.pane] = result[next.pane].filter((old) => old.key !== next.key);
    result[next.pane].push(next);
    if (next.pane === 'reading' && formReserve) {
      formReserve = [...formReserve.filter((old) => old.key !== next.key), next];
    }
  }
  if (formReserve)
    result.formSections = ['context', 'field', 'form']
      .map((section) => ({
        title: { context: 'Context', field: 'Field', form: 'Form' }[section],
        actions: result.reading.filter((item) => item.section === section),
        reserve: formReserve.filter((item) => item.section === section).map((item) => item.label),
      }))
      .filter((section) => section.reserve.length);
  if (state.form?.workspace && !state.form.busy) {
    add('nodes', 'Enter', 'question');
    add('nodes', 'Esc', 'back');
    delete result.reserves.nodes;
  }
  for (const pane of ['nodes', 'development', 'reading', 'recordings']) {
    if (!state.form) {
      const order = state.workflow?.active()
        ? ['↑↓', 'enter', 'd', 'a', 'n', 'e', 'i', 'esc']
        : ['n', 'd', 'a', 'e', 'i'];
      result[pane].sort(
        (a, b) =>
          (order.indexOf(a.key) < 0 ? 20 : order.indexOf(a.key)) -
          (order.indexOf(b.key) < 0 ? 20 : order.indexOf(b.key)),
      );
    }
    result.reserves[pane] ??= result[pane].map((item) => item.label);
    if (state.focus !== pane || (modal && pane !== 'reading')) result[pane] = [];
  }
  if (state.resizing) {
    add('global', 'Release', 'save size');
    add('global', 'Esc', 'back');
  } else {
    if (state.form?.workspace || state.form?.investigationBrowser) {
      if (!state.form.busy) add('global', 'Tab/Shift-Tab', 'change pane');
    } else if (!modal) {
      if (state.mode === 'recording' && hasRecordingProject(state)) add('global', 'b', 'project');
      if (state.mode === 'project' && state.recordingReturn)
        add('global', 'Esc', 'back to recording');
      if (recordingsAvailable && !state.workflow?.active() && state.recordings.length)
        add(
          'global',
          'R',
          state.projectDevelopmentOutline?.().length || hasRecordingProject(state)
            ? state.projectPanel === 'recordings'
              ? 'development'
              : 'recordings'
            : state.recordingsVisible
              ? 'hide recordings'
              : 'show recordings',
        );
      add('global', 'Tab/Shift-Tab', 'change pane');
      if (state.mode !== 'home') add('global', '?', 'help');
      add('global', 'q', 'quit');
    }
    // A mouse hint, not a key: it yields first when the footer would wrap.
    result.global.push({ ...action('global', 'Shift+drag', 'copy'), optional: true });
  }
  return result;
}
