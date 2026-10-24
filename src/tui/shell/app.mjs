/** Wire controllers to the terminal; own event ordering, timers, and cleanup. */
import { mkdir, writeFile, rename } from 'node:fs/promises';
import terminalKit from 'terminal-kit';
import { listProjectRecordings } from '../../project/inquiries/recordings.mjs';
import { listInvestigations, readInvestigation } from '../../project/inquiries/investigation.mjs';
import { loadInterpretationDecisions } from '../../recording/interpretation.mjs';
import { createState, readingDevelopment } from './state.mjs';
import { createText } from './text.mjs';
import { createRecordingContent } from '../recordings/recording-content.mjs';
import { createContent } from './content.mjs';
import { createProjects } from '../concepts/projects.mjs';
import { createForms } from './forms.mjs';
import { createNavigation, openRecordingView } from './navigation.mjs';
import { createRenderer, writeTerminalFrame } from './render.mjs';
import { createKeyboard } from './keyboard.mjs';
import { createContinuation } from '../recordings/continuation.mjs';
import { createMouse } from './mouse.mjs';
import { createInvestigation } from '../inquiries/investigation.mjs';
import { createInterpretation } from '../interpretations/interpretation.mjs';

import { createEngine } from '../engine/controller.mjs';
import { createDevelopment } from '../engine/development.mjs';
import { createProjectReading } from '../concepts/corpus.mjs';
import { createQuestionWorkflow } from '../inquiries/question-workflow.mjs';
import { listEngineRuns } from '../../project/storage/engine-runs.mjs';
import { saveEvaluation } from '../../recording/evaluation.mjs';
import { readSavedRecording } from '../../project/storage/recordings.mjs';
import { knowledgeSnapshot } from '../../project/authoring/knowledge.mjs';
import { openProject } from '../../project/authoring/project.mjs';
import { dirname } from 'node:path';
import { installPaste } from './paste.mjs';

/** Construction has no terminal effects, allowing the real controllers to run in tests. */
export function createWorkbench({ state, config, term, onExit = (code) => process.exit(code) }) {
  const text = createText({ noColor: config.noColor });
  const queue = { pending: Promise.resolve(), wheel: 0 };
  let noticeTimer,
    activityTimer,
    removePaste,
    started = false;
  const draw = () => {
    state.workflow?.sync();
    engine.syncSelection();
    renderer.draw();
  };
  const resize = () => {
    renderer.invalidate();
    draw();
  };
  const setNotice = (message) => {
    clearTimeout(noticeTimer);
    state.notice = message;
    if (message)
      noticeTimer = setTimeout(() => {
        state.notice = '';
        draw();
      }, 2500);
  };
  async function saveLayout() {
    await mkdir(config.projectsHome, { recursive: true });
    const temporary = `${config.preferencesPath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        sidebarWidth: state.preferredSidebar,
        recordingsVisible: state.recordingsVisible,
        recordingsFraction: state.recordingsFraction,
        developmentFraction: state.developmentFraction,
        projects: state.projectLayouts,
      }) + '\n',
    );
    await rename(temporary, config.preferencesPath);
  }
  const navigation = createNavigation({
    state,
    setNotice,
    findingsRows: (...args) => content.findingsRows(...args),
  });
  const projects = createProjects({
    state,
    config,
    draw,
    setNotice,
    resetView: navigation.resetView,
    scrollKey: navigation.scrollKey,
    navigationSelection: navigation.navigationSelection,
    startForm: (...args) => forms.startForm(...args),
    cancelForm: () => forms.cancelForm(),
  });
  const forms = createForms({
    state,
    text,
    projectsHome: config.projectsHome,
    setNotice,
    saveError: projects.saveError,
    reloadProject: projects.reloadProject,
    persistProject: projects.persistProject,
    scrollKey: navigation.scrollKey,
  });
  const investigation = createInvestigation({
    state,
    config,
    forms,
    projects,
    navigation,
    draw,
    setNotice,
  });
  state.startAsk = investigation.startAsk;
  state.saveAsk = investigation.saveDraft;
  state.followup = investigation.followup;
  const interpretations = createInterpretation({
    state,
    config,
    forms,
    projects,
    investigation,
    setNotice,
  });
  state.openInterpretation = interpretations.open;
  const engine = createEngine({ state, config, forms, projects, investigation, draw, setNotice });
  state.engineReadingView = engine.readingView;
  state.engineActivity = () => state.workflow?.activity() ?? engine.activity();
  state.cancelEngine = engine.cancel;
  state.refreshProjectOutline = projects.refreshOutline;
  const development = createDevelopment({
    state,
    config,
    forms,
    projects,
    investigation,
    draw,
    setNotice,
  });
  const projectReading = createProjectReading({ state });
  const workflow = createQuestionWorkflow({
    state,
    config,
    projects,
    investigation,
    development,
    draw,
  });
  state.workflow = workflow;
  state.projectReadingView = () =>
    workflow.active() ? workflow.readingView() : projectReading.readingView();
  state.addCorpusMaterial = development.materialEditor;
  state.developQuestion = development.developQuestion;
  state.clarifyConnection = development.clarifyConnection;
  state.retainPartial = development.retainPartial;
  state.withdrawDeclaration = development.withdrawDeclaration;
  state.editConceptMaterial = development.editMaterial;
  state.deleteProjectQuestion = development.confirmDeleteQuestion;
  state.openProjectMaterial = (item) =>
    item.kind === 'workspace'
      ? development.open()
      : item.kind === 'corpus-contribution'
        ? development.selectContribution(item.entry.id)
        : item.kind === 'engine-run' && engine.select(item.entry);
  state.showEngineResult = async (runId) => {
    await workflow.show(runId);
  };
  state.actionProvider = () => {
    // Project selection never exposes commands from the retained project behind it.
    if (state.mode === 'home') return forms.actions();
    if (state.mode === 'recording' && state.readOnlyRecording) return [];
    if (workflow.active() && !state.form)
      return [...workflow.actions(), ...projects.historyActions()];
    if (workflow.active() && state.form?.workspace)
      return [...investigation.actions(), ...forms.actions()];
    const engineActions = engine.actions();
    const existing = [
      ...development.actions(),
      ...projects.historyActions(),
      ...(readingDevelopment(state)
        ? [...investigation.actions().filter((action) => action.pane === 'nodes')]
        : [...investigation.actions(), ...interpretations.actions(), ...forms.actions()]),
    ];
    const actions = [
      ...projectReading.actions(),
      ...engineActions,
      ...existing.filter(
        (action) =>
          !engineActions.some(
            (engineAction) => engineAction.pane === action.pane && engineAction.key === action.key,
          ),
      ),
    ];
    // The displayed shortcut and its handler must have the same owner.
    return actions.filter(
      (action, index) =>
        actions.findIndex((other) => other.pane === action.pane && other.key === action.key) ===
        index,
    );
  };
  const recordingContent = createRecordingContent({ state, text });
  const content = createContent({
    state,
    text,
    recordingContent,
    selectedConcept: projects.selectedConcept,
  });
  const continuation = createContinuation({ state, resetView: navigation.resetView, setNotice });
  const keyboard = createKeyboard({
    state,
    close,
    setNotice,
    saveLayout,
    ...continuation,
    finishResize: (...args) => mouse.finishResize(...args),
    formKey: forms.formKey,
    closeHelp: navigation.closeHelp,
    scrollKey: navigation.scrollKey,
    resetView: navigation.resetView,
    loadProjectRecording: projects.loadProjectRecording,
    homeLabels: projects.homeLabels,
    showProjects: projects.showProjects,
    activateHome: projects.activateHome,
    handleProjectKey: projects.handleProjectKey,
    setPage: navigation.setPage,
    recordingNavigation: navigation.recordingNavigation,
    navigationSelection: navigation.navigationSelection,
    change: navigation.change,
  });
  const mouse = createMouse({
    state,
    term,
    queue,
    draw,
    setNotice,
    saveLayout,
    scrollKey: navigation.scrollKey,
    handleKey: keyboard.handleKey,
    loadProjectRecording: projects.loadProjectRecording,
    change: navigation.change,
    navigationSelection: navigation.navigationSelection,
  });
  const renderer = createRenderer({
    state,
    term,
    text,
    noColor: config.noColor,
    contentRows: content.contentRows,
    findingsRows: content.findingsRows,
    bindingMarks: recordingContent.bindingMarks,
    recordingNavigation: navigation.recordingNavigation,
    homeLabels: projects.homeLabels,
    selectedConcept: projects.selectedConcept,
    projectActionEnabled: projects.projectActionEnabled,
    canDeleteSentence: forms.canDeleteSentence,
    updatePointer: mouse.updatePointer,
  });

  function onKey(key, matches, data) {
    queue.pending = queue.pending.then(async () => {
      if (state.closed) return;
      try {
        await keyboard.handleKey(key, data);
      } catch (error) {
        setNotice('Not applied…');
        state.failure = projects.saveError(error);
        state.offset = 0;
        state.focus = 'reading';
      }
      try {
        draw();
      } catch (error) {
        close(1, error);
      }
    });
  }
  const onInterrupt = () => close(130),
    onTerminate = () => close(143);
  const onException = (error) => close(1, error);
  function dispose() {
    workflow.dispose();
    state.closed = true;
    engine.cancel();
    state.form?.controller?.abort();
    state.form = null;
    clearTimeout(noticeTimer);
    clearInterval(activityTimer);
    if (!started) return;
    started = false;
    term.removeListener('mouse', mouse.handleMouse);
    term.removeListener('key', onKey);
    term.removeListener('resize', resize);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    process.removeListener('uncaughtException', onException);
    mouse.updatePointer('default');
    term.grabInput(false);
    removePaste?.();
    term.raw('\x1b[?2004l\x1b[?2026l\x1b[?1007r\x1b[0 q');
    term.styleReset();
    term.fullscreen(false);
    term.hideCursor(false);
  }
  function close(code = 0, error = null) {
    if (state.closed) return;
    state.closed = true;
    dispose();
    if (error) process.stderr.write(`${error.stack ?? error}\n`);
    onExit(code);
  }
  function start() {
    if (started || state.closed) return;
    if (state.mode === 'recording')
      openRecordingView(state, { preserveSelection: config.preserveRecordingSelection });
    started = true;
    term.on('mouse', mouse.handleMouse);
    term.on('key', onKey);
    term.on('resize', resize);
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    process.on('uncaughtException', onException);
    try {
      term.fullscreen(true);
      term.hideCursor();
      removePaste = installPaste(term, (text) =>
        onKey(text, [], { isPaste: true, isCharacter: true }),
      );
      term.grabInput({ mouse: 'motion' });
      renderer.invalidate();
      term.raw('\x1b[?2004h\x1b[?1007s\x1b[?1007h');
      activityTimer = setInterval(() => {
        if (
          !state.closed &&
          (state.form?.busy || state.engineActivity?.()) &&
          !state.quitPrompt &&
          state.animatedHeader
        ) {
          writeTerminalFrame(
            term,
            '\x1b7\x1b[1;1H' +
              text.progressHeader(
                state.animatedHeader.text,
                state.animatedHeader.width,
                undefined,
                state.animatedHeader.spans,
              ) +
              '\x1b8',
          );
        }
      }, 33);
      draw();
    } catch (error) {
      close(1, error);
    }
  }
  return {
    state,
    start,
    dispose,
    close,
    draw,
    handleKey: keyboard.handleKey,
    handleMouse: mouse.handleMouse,
    idle: async () => {
      await queue.pending;
      await engine.idle();
      await workflow.idle();
    },
  };
}

export async function runWorkbench(initial, config) {
  const state = createState(initial, config);
  if (!state.readOnlyRecording && !state.project && state.ix?.recording.project?.path) {
    try {
      const project = await openProject(dirname(state.ix.recording.project.path));
      if (project.data.id === state.ix.recording.project.id) state.project = project;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  state.recordings = state.project ? await listProjectRecordings(state.project) : [];
  state.projectEngineRuns = state.project ? await listEngineRuns(state.project) : [];
  state.investigationEntries = state.project ? await listInvestigations(state.project) : [];
  if (state.project && state.ix?.recording.ask) {
    try {
      state.investigation = await readInvestigation(
        state.project,
        state.ix.recording.ask.investigationId,
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  state.interpretationDecisions = state.activeRecordingPath
    ? await loadInterpretationDecisions(state.activeRecordingPath, state.ix)
    : [];
  if (
    !state.readOnlyRecording &&
    state.activeRecordingPath &&
    state.project &&
    state.ix.recording.project?.id === state.project.data.id
  ) {
    const evaluation = await saveEvaluation(
      state.activeRecordingPath,
      knowledgeSnapshot(state.project.data),
      state.project.digest,
      readSavedRecording,
    );
    state.answerKnowledge = {
      recording: state.ix.recording,
      knowledge: evaluation.knowledge,
      evaluation,
    };
    state.investigationReturn = true;
    state.placementId ??= state.ix.recording.project.placementId;
  }
  const app = createWorkbench({ state, config, term: terminalKit.terminal });
  app.start();
  return app;
}
