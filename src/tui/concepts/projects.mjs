import { readSavedRecording } from '../../project/storage/recordings.mjs';
/** Project commands, persistence, undo, and explicit inquiry/organization workflows. */
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createProject,
  openProject,
  saveProject,
  addConcept,
  editConcept,
  removeBranch,
  moveConcept,
  projectTree,
  listProjects,
} from '../../project/authoring/project.mjs';
import { listProjectRecordings } from '../../project/inquiries/recordings.mjs';
import { readInvestigation, listInvestigations } from '../../project/inquiries/investigation.mjs';
import { loadProject } from '../../project/storage/objects.mjs';
import { loadInterpretationDecisions } from '../../recording/interpretation.mjs';
import { interpretationRevision } from '../../recording/revisions.mjs';

import { indexRecording, initialSelection } from '../recordings/view.mjs';
import { localPath } from '../shell/paths.mjs';
import { homeItems, hasRecordingProject } from '../shell/state.mjs';
import { openRecordingView } from '../shell/navigation.mjs';
import { knowledgeSnapshot } from '../../project/authoring/knowledge.mjs';
import { saveEvaluation } from '../../recording/evaluation.mjs';

import {
  projectOutline,
  projectOutlineIndex,
  conceptOutline,
  developmentOutline,
} from './project-outline.mjs';
import { pageStep } from '../shell/layout.mjs';
import { listEngineRuns } from '../../project/storage/engine-runs.mjs';

export function createProjects({
  state,
  config,
  draw,
  setNotice,
  resetView,
  startForm,
  cancelForm,
  scrollKey,
  navigationSelection,
}) {
  const { projectsHome, defaultRecording } = config;
  const conceptBranches = (data) =>
    data?.placements.map((item) => item.parentId).filter(Boolean) ?? [];
  state.projectExpanded = new Set(conceptBranches(state.project?.data));
  const index = () =>
    projectOutlineIndex(state.project.data, state.projectEngineRuns, state.project.digest);
  const outline = (expanded = state.projectExpanded) =>
    projectOutline(state.project.data, expanded, state.projectEngineRuns, state.project.digest);
  const concepts = () =>
    state.workflow?.active()
      ? state.workflow.roles()
      : state.project
        ? conceptOutline(index(), state.projectExpanded)
        : [];
  const selectedConceptEntry = () => {
    if (state.workflow?.active()) return state.workflow.role();
    const ix = index();
    return (
      ix.conceptEntries.get(state.projectConceptId ?? state.placementId) ??
      ix.all.find((item) => item.placementId === state.placementId) ??
      ix.all[0]
    );
  };
  const development = () =>
    state.workflow?.active()
      ? state.workflow.developmentItems()
      : state.project
        ? developmentOutline(index())
        : [];
  const relatedDevelopment = (concept) => {
    const items = development();
    const own = items.find(
      (item) => item.kind === 'corpus-contribution' && item.entry.id === concept?.contributionId,
    );
    if (own) return own;
    const related = items.filter((item) =>
      concept?.kind === 'material-concept'
        ? index().linked.get(item.id)?.includes(concept.id)
        : item.placementId === concept?.placementId,
    );
    return related.find((item) => item.id === state.projectEntryId) ?? related[0];
  };
  const selectedDevelopment = () =>
    state.workflow?.active()
      ? state.workflow.selectedQuestion()
      : state.project
        ? (development().find((item) => item.id === state.projectEntryId) ??
          relatedDevelopment(selectedConceptEntry()) ??
          (state.focus === 'development' || state.projectReadingOrigin === 'development'
            ? development()[0]
            : null))
        : null;
  const selectedEntry = (pane = state.focus) =>
    ((pane === 'development' ||
      (pane === 'reading' && state.projectReadingOrigin === 'development')) &&
      selectedDevelopment()) ||
    selectedConceptEntry();
  function selectEntry(id, { focus } = {}) {
    if (state.workflow?.active()) {
      if (state.workflow.developmentItems().some((item) => item.id === id))
        return state.workflow.openDevelopment(id, focus ?? 'development');
      const item = index().entries.get(id);
      if (item) state.workflow.select(item.placementId, focus ?? 'nodes');
      return;
    }
    const item = index().entries.get(id);
    if (!item) return;
    for (
      let parent = index().entries.get(item.parentId);
      parent;
      parent = index().entries.get(parent.parentId)
    )
      state.projectExpanded.add(parent.id);
    const concept = ['concept', 'material-concept', 'workspace'].includes(item.kind);
    if (concept) {
      state.projectConceptId = item.id;
      state.projectEntryId = relatedDevelopment(item)?.id ?? null;
    } else {
      state.projectEntryId = item.id;
      const locations = index().linked.get(item.id) ?? [];
      if (locations.length) {
        if (!locations.includes(state.projectConceptId)) state.projectConceptId = locations[0];
        for (const id of locations) {
          let parent = index().entries.get(id);
          while (parent) {
            state.projectExpanded.add(parent.id);
            parent = index().entries.get(parent.parentId);
          }
        }
        state.nodesOffset = Math.max(
          0,
          concepts().findIndex((n) => n.id === state.projectConceptId) - 1,
        );
      }
    }
    state.placementId = item.placementId;
    state.projectReadingTab = null;
    state.projectReadingRunId = null;
    state.offset = 0;
    state.projectReadingOrigin = concept ? 'nodes' : 'development';
    if (!state.form) state.focus = focus ?? (concept ? 'nodes' : 'development');
  }
  state.projectOutline = outline;
  state.selectedProjectEntry = selectedEntry;
  state.selectProjectEntry = selectEntry;
  state.projectReadingEntry = () => selectedEntry(state.projectReadingOrigin);
  state.projectConceptOutline = concepts;
  state.projectDevelopmentOutline = development;
  state.selectedDevelopmentEntry = selectedDevelopment;
  state.selectedConceptEntry = selectedConceptEntry;
  state.projectConceptPath = () => {
    const selected = selectedConceptEntry();
    if (selected?.kind !== 'material-concept') return null;
    const path = [];
    for (let at = selected; at; at = index().entries.get(at.parentId))
      path.unshift(at.name ?? at.label);
    return path.join(' → ');
  };
  state.linkedProjectConcepts = () => {
    if (state.workflow?.active()) return new Set();
    const item = state.projectReadingOrigin === 'development' ? selectedDevelopment() : null;
    return new Set(index().linked.get(item?.id) ?? []);
  };
  if (state.project) {
    const item = selectedConceptEntry();
    state.projectConceptId = item?.id;
    if (item?.kind === 'material-concept') state.projectExpanded.add(item.id);
  }
  async function refreshOutline() {
    const project = state.project;
    const [entries, runs] = await Promise.all([
      listInvestigations(project),
      listEngineRuns(project),
    ]);
    if (state.project?.data.id !== project.data.id) return;
    state.investigationEntries = entries;
    state.projectEngineRuns = runs;
    await state.workflow?.refreshQuestions();
  }
  async function expandEntry() {
    await refreshOutline();
    const item = selectedEntry();
    if (item.children?.length) {
      if (state.projectExpanded.has(item.id))
        selectEntry(item.children[0].id, { focus: state.focus });
      else state.projectExpanded.add(item.id);
    }
  }
  const projectActions = {
    a: { focus: 'nodes', label: 'a ask' },
    c: { focus: 'nodes', label: '[Add: c child / s sibling]' },
    s: { focus: 'nodes', label: null },
    m: { focus: 'nodes', label: 'm move' },
    ENTER: { focus: null, label: 'Enter edit' },
    r: { focus: null, label: 'r reload' },
    x: { focus: 'nodes', label: 'x delete' },
  };
  async function loadProjectRecording(path) {
    const fromRecordings = state.focus === 'recordings';
    const next = indexRecording(await readSavedRecording(path));
    if (next.recording.project?.id !== state.project.data.id)
      throw new Error('Recording belongs to another project.');
    const nextDecisions = await loadInterpretationDecisions(path, next);
    if (next.recording.ask) {
      try {
        state.investigation = await readInvestigation(
          state.project,
          next.recording.ask.investigationId,
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state.investigation = null;
      }
    }
    const previousPage = state.mode === 'recording' ? state.page : 'overview';
    const previousOffset = state.mode === 'recording' ? state.offset : 0;
    state.ix = next;
    state.selection = { ...initialSelection(state.ix), visitId: null };
    state.project = await openProject(dirname(state.project.path));
    await refreshOutline();
    const evaluation = await saveEvaluation(
      path,
      knowledgeSnapshot(state.project.data),
      state.project.digest,
      readSavedRecording,
    );
    state.answerKnowledge = {
      recording: next.recording,
      knowledge: evaluation.knowledge,
      evaluation,
    };
    state.activeRecordingPath = path;
    state.historyReturn = null;
    state.interpretationDecisions = nextDecisions;
    openRecordingView(state);
    state.recordingIndex = Math.max(
      0,
      state.recordings.findIndex((entry) => entry.path === path),
    );
    state.mode = 'recording';
    state.investigationReturn = true;
    resetView();
    state.focus = 'reading';
    if (fromRecordings) state.projectPanel = 'recordings';
    state.projectReadingOrigin = 'nodes';
    state.page = previousPage;
    state.offset = previousOffset;
  }
  function saveError(error) {
    if (error.code === 'PROJECT_CHANGED') {
      state.reloadNeeded.add(state.project.path);
      if (state.form) state.form.projectChanged = true;
      return 'The project changed outside this editor. These edits were not saved.';
    }
    return error.message;
  }
  const canDelete = () =>
    state.project.data.placements.find((p) => p.id === state.placementId)?.parentId !== null ||
    state.project.data.placements.filter((p) => p.parentId === null).length > 1;
  const projectActionEnabled = (key, focus = state.focus) =>
    (selectedEntry(focus)?.kind !== 'workspace' || !['m', 'x'].includes(key)) &&
    (!(selectedEntry(focus)?.kind === 'material-concept') || !['c', 's', 'm', 'x'].includes(key)) &&
    (focus === 'nodes' || selectedEntry()?.kind === 'concept' || ['ENTER', 'r'].includes(key)) &&
    (key !== 'ENTER' ||
      (!selectedEntry(focus)?.readOnly &&
        !(focus === 'reading' && state.projectReadingTab === 'Meaning') &&
        !['corpus-contribution', 'engine-run', 'mapping'].includes(selectedEntry(focus)?.kind))) &&
    (!projectActions[key]?.focus || projectActions[key].focus === focus) &&
    (key !== 'r' || state.reloadNeeded.has(state.project.path)) &&
    (key !== 'x' || canDelete());
  // Keep only revision indexes in memory. Corpus objects already live in the
  // content-addressed store; history must not copy thousands of concepts.
  function recordProjectChange(base, saved) {
    if (base.digest === saved.digest) return saved;
    let history = state.projectHistory.get(base.path);
    if (!history || history.current !== base.digest) history = { undo: [], redo: [] };
    history.undo.push({
      before: base.storage ?? base.data,
      after: saved.storage ?? saved.data,
      placementId: state.placementId,
    });
    if (history.undo.length > 20) history.undo.shift();
    history.redo = [];
    history.current = saved.digest;
    state.projectHistory.set(base.path, history);
    return saved;
  }
  async function persistProject(base, data) {
    return recordProjectChange(base, await saveProject(base, data));
  }
  async function reloadProject() {
    const next = await openProject(dirname(state.project.path));
    if (next.data.id !== state.project.data.id)
      throw new Error('Project identity changed. Open it from Projects to switch.');
    state.homeReturn = null;
    state.project = next;
    state.projectHistory.delete(next.path);
    state.reloadNeeded.delete(next.path);
    if (!next.data.placements.some((p) => p.id === state.placementId))
      state.placementId = next.data.placements[0].id;
    await refreshOutline();
    state.failure = '';
    setNotice('Current project loaded');
  }
  async function restoreProject(direction) {
    const base = state.project,
      history = state.projectHistory.get(base.path),
      change = history?.[direction].at(-1);
    if (!change || history.current !== base.digest) return;
    const data = await loadProject(
      dirname(base.path),
      change[direction === 'undo' ? 'before' : 'after'],
    );
    // saveProject checks the disk revision under its write lock. A concurrent
    // edit must never be overwritten, or consume an undo/redo entry.
    state.project = await saveProject(base, data);
    history[direction].pop();
    history[direction === 'undo' ? 'redo' : 'undo'].push(change);
    history.current = state.project.digest;
    if (!state.project.data.placements.some((item) => item.id === state.placementId))
      state.placementId = state.project.data.placements.some(
        (item) => item.id === change.placementId,
      )
        ? change.placementId
        : state.project.data.placements[0].id;
    state.projectDetailMaterial = null;
    state.offset = 0;
    state.failure = '';
    await refreshOutline();
    if (state.ix?.recording.project?.id === state.project.data.id && state.activeRecordingPath) {
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
    }
    setNotice(direction === 'undo' ? 'Undone' : 'Redone');
  }
  function historyActions() {
    if (
      !state.project ||
      state.mode === 'home' ||
      (state.mode === 'recording' && !hasRecordingProject(state)) ||
      state.form ||
      state.help ||
      state.quitPrompt ||
      state.resizing
    )
      return [];
    if (state.reloadNeeded.has(state.project.path))
      return [{ key: 'CTRL_R', pane: 'global', description: 'reload project', run: reloadProject }];
    const history = state.projectHistory.get(state.project.path);
    if (history?.current !== state.project.digest) return [];
    return [
      ['CTRL_Z', 'undo'],
      ['CTRL_Y', 'redo'],
    ]
      .filter(([, direction]) => history[direction].length)
      .map(([key, direction]) => ({
        key,
        pane: 'global',
        description: direction,
        run: () => restoreProject(direction),
      }));
  }
  const homeLabels = () =>
    state.projectChoices
      ? [...state.projectChoices.map((item) => item.name), 'Another location…']
      : homeItems;
  async function showProjects(location = state.projectLocation) {
    if (location === projectsHome) await mkdir(projectsHome, { recursive: true });
    const choices = await listProjects(location, state.knownProjects);
    state.projectLocation = location;
    state.projectChoices = choices;
    state.homeIndex = 0;
    resetView();
  }
  async function enterProject(path) {
    const next = await openProject(path);
    state.homeReturn = null;
    state.recordingReturn = null;
    state.project = next;
    state.reloadNeeded.delete(next.path);
    state.knownProjects.add(dirname(next.path));
    state.placementId = next.data.placements[0].id;
    state.mode = 'project';
    resetView();
    state.recordings = await listProjectRecordings(state.project);
    state.recordingsOffset = 0;
    state.projectEntryId = null;
    state.projectConceptId = null;
    state.projectPanel = 'development';
    state.projectReadingOrigin = 'nodes';
    state.developmentOffset = 0;
    state.projectReferenceTrail = [];
    state.projectExpanded = new Set(conceptBranches(next.data));
    await refreshOutline();
    const first = selectedConceptEntry();
    state.projectConceptId = first?.id;
    if (first?.kind === 'material-concept') state.projectExpanded.add(first.id);
    state.investigationEntries = await listInvestigations(state.project);
    state.investigation = null;
  }
  function selectedConcept() {
    const item = selectedConceptEntry();
    if (item?.kind === 'material-concept')
      return {
        id: item.conceptId,
        name: item.name,
        description: item.materialState,
        passages: [item.sourceText],
      };
    const placement = state.project.data.placements.find((p) => p.id === state.placementId);
    return state.project.data.concepts.find((c) => c.id === placement.conceptId);
  }

  const askSelected = (options = {}) => state.startAsk(options);
  async function activateHome() {
    if (state.projectChoices) {
      const chosen = state.projectChoices[state.homeIndex];
      if (chosen) await enterProject(chosen.path);
      else
        startForm(
          'Project location',
          [['Directory', state.projectLocation]],
          async ([path]) => {
            const location = localPath(path);
            try {
              await enterProject(location);
            } catch (error) {
              if (['EACCES', 'EPERM'].includes(error.code))
                throw new Error(`Permission denied for directory: ${location}`);
              if (error.code !== 'ENOENT') throw error;
              try {
                await showProjects(location);
              } catch (error) {
                const message = {
                  ENOENT: 'Directory not found',
                  ENOTDIR: 'Not a directory',
                  EACCES: 'Permission denied for directory',
                  EPERM: 'Permission denied for directory',
                }[error.code];
                if (message) throw new Error(`${message}: ${location}`);
                throw error;
              }
            }
          },
          { submitLabel: 'open' },
        );
      return;
    }
    if (state.homeIndex === 0) {
      startForm(
        'New project',
        [['Project name'], ['Directory'], ['Top role (optional)', '', false, false]],
        async (values) => {
          const project = await createProject(localPath(values[1]), values[0], values[2]);
          await enterProject(dirname(project.path));
        },
      );
      state.form.newProject = true;
    } else if (state.homeIndex === 1) await showProjects();
    else
      startForm(
        'Open recording',
        [['Recording file', defaultRecording]],
        async ([path]) => {
          const next = indexRecording(await readSavedRecording(localPath(path)));
          const nextDecisions = await loadInterpretationDecisions(localPath(path), next);
          state.recordingReturn = null;
          state.projectReadingOrigin = 'nodes';
          state.activeRecordingPath = localPath(path);
          state.interpretationDecisions = nextDecisions;
          state.homeReturn = null;
          state.ix = next;
          state.selection = { ...initialSelection(state.ix), visitId: null };
          state.mode = 'recording';
          resetView();
          openRecordingView(state);
          if (!hasRecordingProject(state) && next.recording.project?.path) {
            try {
              const project = await openProject(dirname(next.recording.project.path));
              if (project.data.id === next.recording.project.id) state.project = project;
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
          }
          if (hasRecordingProject(state)) {
            state.recordings = await listProjectRecordings(state.project);
            await loadProjectRecording(state.activeRecordingPath);
          }
        },
        { submitLabel: 'open' },
      );
  }
  function editSelected(sentenceIndex = null) {
    if (state.workflow?.active()) {
      let concept = selectedConcept(),
        base = state.project;
      startForm(
        'Edit role',
        [
          ['Role name', concept.name],
          ['Description', concept.description ?? '', true, false],
        ],
        async ([name, description]) => {
          const changed = name !== concept.name || description !== (concept.description ?? '');
          if (changed)
            state.project = await persistProject(
              base,
              editConcept(base.data, concept.id, name, concept.passages, description),
            );
          cancelForm();
          setNotice(changed ? 'Role saved' : 'No changes');
          state.failure = '';
        },
        { submitLabel: 'save role' },
      );
      const form = state.form;
      form.onProjectReload = () => {
        base = state.project;
        const current = base.data.concepts.find((item) => item.id === concept.id);
        if (!current) {
          form.readOnly = true;
          form.title = 'Unsaved role draft';
          state.offset = 0;
          form.error = 'This role was removed. Its unsaved text remains below.';
          return;
        }
        for (const [index, key] of ['name', 'description'].entries()) {
          const field = form.fields[index];
          if (field.value === (concept[key] ?? '')) {
            field.value = current[key] ?? '';
            field.cursor = Math.min(field.cursor, Array.from(field.value).length);
          }
        }
        concept = current;
        form.contextRows = [
          ['Saved role name', current.name, 'input'],
          ['Saved description', current.description || 'None', 'input'],
        ];
      };
      return;
    }
    const concept = selectedConcept(),
      base = state.project,
      editPassages = state.focus === 'reading';
    startForm(
      `Edit - ${concept.name}`,
      [
        ['Role name', concept.name],
        ['Description', concept.description ?? '', true, false],
        ...concept.passages.map((text, i) => [`Sentence ${i + 1}`, text, true, false]),
        [`Sentence ${concept.passages.length + 1} (add sentence)`, '', true, false],
      ],
      async ([name, description, ...texts]) => {
        const passages = texts.filter((text) => text.trim());
        const descriptionChanged = description !== (concept.description ?? '');
        const changed =
          name !== concept.name ||
          descriptionChanged ||
          JSON.stringify(passages) !== JSON.stringify(concept.passages);
        if (changed)
          state.project = await persistProject(
            base,
            editConcept(
              base.data,
              concept.id,
              name,
              passages,
              descriptionChanged ? description : undefined,
            ),
          );
        cancelForm();
        setNotice(changed ? 'Saved…' : 'No changes');
        state.failure = '';
        if (changed) state.offset = 0;
      },
    );
    state.form.passageEditor = true;
    state.form.sentenceStart = 2;
    state.form.index =
      sentenceIndex !== null
        ? state.form.sentenceStart + sentenceIndex
        : editPassages
          ? state.form.sentenceStart
          : 0;
  }
  async function handleProjectKey(key) {
    if (['ENTER', 'KP_ENTER'].includes(key) && !projectActionEnabled('ENTER')) return;
    if (projectActions[key] && !projectActionEnabled(key)) return;
    if (
      ['ESCAPE', 'BACKSPACE'].includes(key) &&
      (state.focus === 'development' ||
        (state.focus === 'reading' && state.projectReadingOrigin === 'development'))
    )
      return;
    if (['nodes', 'development'].includes(state.focus) && key === 'RIGHT') {
      await expandEntry();
      return;
    }
    if (['nodes', 'development'].includes(state.focus) && key === 'LEFT') {
      const item = selectedEntry();
      if (state.projectExpanded.has(item.id)) state.projectExpanded.delete(item.id);
      else if (item.parentId) selectEntry(item.parentId);
      return;
    }
    if (['ESCAPE', 'BACKSPACE'].includes(key)) {
      if (state.projectReferenceTrail?.length) selectEntry(state.projectReferenceTrail.pop());
      else if (state.recordingReturn) {
        const previous = state.recordingReturn;
        state.recordingReturn = null;
        const decisions =
          state.activeRecordingPath === previous.activeRecordingPath
            ? state.interpretationDecisions
            : previous.interpretationDecisions;
        Object.assign(state, previous);
        state.interpretationDecisions = decisions;
        state.answerKnowledge = {
          recording: state.ix.recording,
          knowledge: knowledgeSnapshot(state.project.data),
        };
        return;
      }
      state.focus = 'nodes';
      return;
    }
    if (key === 'a') await askSelected();
    else if (key === 'c' || key === 's') {
      const parentId =
        key === 'c'
          ? state.placementId
          : state.project.data.placements.find((p) => p.id === state.placementId).parentId;
      const title =
        key === 'c'
          ? `Add child under ${selectedConcept().name}`
          : parentId === null
            ? state.workflow?.active()
              ? 'Add root role'
              : 'Add root concept'
            : `Add sibling beside ${selectedConcept().name}`;
      startForm(title, [['Role name']], async ([name]) => {
        const next = addConcept(state.project.data, parentId, name);
        state.project = await persistProject(state.project, next.data);
        selectEntry(next.placementId);
        resetView();
        setNotice('Saved…');
        state.failure = '';
      });
    } else if (key === 'ENTER' || key === 'KP_ENTER') {
      const item = selectedEntry();
      if (item.readOnly) return;
      if (item.kind === 'group') await expandEntry();
      else if (item.kind === 'sentence') editSelected(item.index);
      else if (item.kind === 'reference') {
        const focus = state.focus;
        selectEntry(item.targetId, { focus });
        editSelected(item.index);
        state.form.onCancel = () => selectEntry(item.id, { focus });
      } else if (item.kind === 'concept') editSelected();
      else if (item.kind === 'material-concept') {
        if (item.referenceTo) selectEntry(item.referenceTo);
        else await state.editConceptMaterial?.(item);
      } else await state.openProjectMaterial?.(item);
    } else if (key === 'm') {
      const base = state.project,
        selected = base.data.placements.find((p) => p.id === state.placementId);
      const paths = new Map(),
        excluded = new Set([state.placementId]);
      const choices = [{ id: null, label: 'Project root' }];
      for (const { placement, concept } of projectTree(base.data)) {
        const path = [...(paths.get(placement.parentId) ?? []), concept.name];
        paths.set(placement.id, path);
        if (excluded.has(placement.parentId)) excluded.add(placement.id);
        if (!excluded.has(placement.id))
          choices.push({ id: placement.id, label: path.join(' → ') });
      }
      startForm(`Move ${selectedConcept().name} - choose parent`, [], async () => {
        const parentId = state.form.move[state.form.index].id;
        if (parentId === selected.parentId) {
          cancelForm();
          setNotice('No changes');
          return;
        }
        state.project = await persistProject(
          base,
          moveConcept(base.data, state.placementId, parentId),
        );
        selectEntry(state.placementId);
        cancelForm();
        state.offset = 0;
        setNotice('Moved…');
        state.failure = '';
      });
      state.form.move = choices;
      state.form.index = choices.findIndex((choice) => choice.id === selected.parentId);
    } else if (key === 'x') {
      const base = state.project,
        removal = removeBranch(base.data, state.placementId);
      startForm(state.workflow?.active() ? 'Delete role' : 'Delete', [], async () => {
        state.project = await persistProject(base, removal.data);
        state.placementId = removal.nextPlacementId;
        cancelForm();
        state.offset = 0;
        setNotice('Deleted…');
        state.failure = '';
      });
      state.form.confirm = true;
      state.form.yesNo = { yes: false };
      state.form.inspectRows = [
        [state.workflow?.active() ? 'Role' : 'Concept', selectedConcept().name],
        ...(removal.count > 1
          ? [[state.workflow?.active() ? 'Child roles removed' : 'Descendants', removal.count - 1]]
          : []),
      ];
    } else if (key === 'r') {
      await reloadProject();
      state.offset = 0;
    } else if (['nodes', 'development'].includes(state.focus)) {
      const ids = (state.focus === 'development' ? development() : concepts()).map(
          (item) => item.id,
        ),
        at = ids.indexOf(selectedEntry()?.id);
      const page = pageStep(
        state.focus === 'development' ? state.viewport?.developmentHits : state.viewport?.nodeHits,
      );
      const delta = ['UP', 'k'].includes(key)
        ? -1
        : ['DOWN', 'j'].includes(key)
          ? 1
          : key === 'PAGE_UP'
            ? -page
            : key === 'PAGE_DOWN'
              ? page
              : 0;
      if (delta || key === 'HOME' || key === 'END') {
        selectEntry(
          key === 'HOME'
            ? ids[0]
            : key === 'END'
              ? ids.at(-1)
              : ids[Math.max(0, Math.min(ids.length - 1, at + delta))],
        );
        state.offset = 0;
        setNotice('');
        state.failure = '';
      }
    } else if (key === 'f') state.expandReading = !state.expandReading;
    else scrollKey(key);
    return;
  }

  return {
    refreshOutline,
    projectActions,
    projectActionEnabled,
    loadProjectRecording,
    saveError,
    persistProject,
    reloadProject,
    recordProjectChange,
    historyActions,
    homeLabels,
    showProjects,
    enterProject,
    selectedConcept,
    askSelected,
    activateHome,
    editSelected,
    handleProjectKey,
  };
}
