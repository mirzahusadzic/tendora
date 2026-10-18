/** One workbench session. Controllers mutate it; content builders only read it. */
import { dirname } from 'node:path';

export const homeItems = ['New project', 'Open project'];
export const readingViews = {
  s: { page: 'scope', description: 'source openings' },
  a: { page: 'source', description: 'AMR & source' },
  c: { page: 'context', description: 'context checks' },
  p: { page: 'proposal', description: 'proposed changes' },
  v: { page: 'provenance', description: 'provenance' },
  t: { page: 'interpretation', description: 'interpretation' },
  i: { page: 'setup', description: 'recorded inputs' },
};
export const details = Object.fromEntries(
  Object.entries(readingViews)
    .filter(([key]) => key !== 'i')
    .map(([key, item]) => [key, item.page]),
);
export const pageLabels = {
  setup: 'Recorded inputs',
  overview: 'Findings',
  source: 'AMR & source',
  scope: 'Source openings',
  proposal: 'Proposals',
  provenance: 'Provenance',
  interpretation: 'Local AMR interpretation',
  context: 'Carried context checks',
};

export const hasRecordingProject = (state) =>
  Boolean(
    state.mode === 'recording' &&
    !state.readOnlyRecording &&
    state.project &&
    state.ix?.recording.project?.id === state.project.data.id,
  );
export const readingDevelopment = (state) =>
  hasRecordingProject(state) &&
  !state.form &&
  !state.help &&
  state.projectReadingOrigin === 'development' &&
  Boolean(state.selectedDevelopmentEntry?.());

export function createState(
  initial,
  { projectsHome, detailArg = null, readOnlyRecording = false },
) {
  return {
    // Open workspace and recorded evidence.
    mode: initial.mode,
    readOnlyRecording,
    project: initial.project,
    placementId: initial.placementId,
    projectConceptId: null,
    ix: initial.ix,
    selection: initial.selection ? { ...initial.selection, visitId: null } : null,
    activeRecordingPath: initial.activeRecordingPath ?? null,
    interpretationDecisions: [],
    recordings: [],
    recordingIndex: 0,
    investigationReturn: false,
    projectEngineRuns: [],
    investigation: null,
    // Navigation, overlays, and measured viewport.
    page: detailArg ?? 'overview',
    pageTrail: [],
    focus: detailArg ? 'reading' : 'nodes',
    help: false,
    helpState: null,
    form: null,
    quitPrompt: null,
    offset: 0,
    maxOffset: 0,
    nodesOffset: 0,
    recordingsOffset: 0,
    developmentOffset: 0,
    projectPanel: 'development',
    projectReadingOrigin: 'nodes',
    openingIndex: 0,
    findingsList: false,
    expandReading: false,
    savedOffsets: new Map(),
    viewport: null,
    // Persisted layout preferences and transient pointer state.
    preferredSidebar: initial.preferredSidebar ?? null,
    recordingsVisible: initial.recordingsVisible ?? true,
    recordingsFraction: initial.recordingsFraction ?? 1 / 3,
    developmentFraction: initial.developmentFraction ?? 0.52,
    resizing: null,
    mousePosition: null,
    pointerShape: null,
    // Project/session history and home screen.
    homeIndex: 0,
    homeReturn: null,
    projectChoices: null,
    projectLocation: projectsHome,
    knownProjects: new Set(initial.project ? [dirname(initial.project.path)] : []),
    projectHistory: new Map(),
    reloadNeeded: new Set(),
    // Status and terminal lifecycle.
    closed: false,
    notice: '',
    failure: '',
    animatedHeader: null,
    serviceStatus: { egemma: 'idle', penman: 'idle', semcat: 'idle' },
  };
}
