/** One working question over the authored role hierarchy. No history browser. */
import {
  questionIdentity,
  questionLineages,
  readInvestigation,
} from '../../project/inquiries/investigation.mjs';
import { readFile } from 'node:fs/promises';
import { projectTree } from '../../project/authoring/project.mjs';
import { sourceCatalog } from '../../project/authoring/sources.mjs';
import { contributionRevision } from '../../project/authoring/development.mjs';
import { readEngineRun, readEngineArtifact } from '../../project/storage/engine-runs.mjs';
import {
  captureProjectInquiry,
  prepareProjectInquiry,
  retainInquiryTraversal,
} from '../../project/inquiries/inquiry.mjs';
import { indexRecording, initialSelection } from '../recordings/view.mjs';
import { authoredContinuation, evidenceOpenings } from '../../recording/continuation.mjs';
import { interpretationRevision } from '../../recording/revisions.mjs';
import { relationMeaning } from '../concepts/meaning.mjs';
import { placementLabel } from '../concepts/placement-label.mjs';
import { assessedState } from '../concepts/project-outline.mjs';
import { retainedReadingAuditor, prepareRetainedReading } from '../../engine/preparation.mjs';
import { journeySection, readingWarnings, sourceStatements } from './journey-view.mjs';
import { readSavedRecording } from '../../project/storage/recordings.mjs';
import { inputFromProject } from '../../engine/input.mjs';
import { retainPartialContribution } from '../../engine/partial.mjs';
import { partialIdentity } from '../../amr/partial-coverage.mjs';
import { caseName } from '../shell/wording.mjs';
import { backgroundEngineStorage } from '../../project/inquiries/background.mjs';

export function createQuestionWorkflow({
  state,
  config,
  projects,
  investigation,
  development,
  draw,
}) {
  let disposed = false;
  let current = null,
    pending = null,
    maintenance = Promise.resolve(),
    inspection = null,
    auditor = null;
  let roleCache, cachedData, loading, sourcesByRole;
  let questions = [],
    questionProject = null,
    questionData = null;
  const selections = new Map();
  let trail = [],
    gap = null,
    revealChoice = false,
    rawReading = false;
  let inspectionWork = null;
  const choiceRows = (group) => [
    ...(group.rowChoices ?? []),
    ...(group.table?.entries ?? []).filter((entry) => Number.isInteger(entry.choiceIndex)),
    ...(group.groups ?? []).flatMap(choiceRows),
  ];
  const caseInputs = new Map();
  const questionKey = questionIdentity;
  const currentKey = () =>
    current &&
    questionKey(
      question(),
      current.run.scopePlacementId,
      current.input?.caseSelection ?? current.run.case,
    );
  async function refreshQuestions() {
    const project = state.project;
    if (!project) return;
    const items = new Map();
    const investigations = [...(state.investigationEntries ?? [])];
    if (state.investigation?.data.projectId === project.data.id) {
      const at = investigations.findIndex((i) => i.data.id === state.investigation.data.id);
      if (at >= 0) investigations.splice(at, 1);
      investigations.unshift(state.investigation);
    }
    for (const entry of investigations)
      for (const ask of entry.data.asks) {
        if (!ask.question.trim()) continue;
        const id = questionKey(ask.question, ask.scopePlacementId, ask.caseSelection);
        if (!items.has(id))
          items.set(id, {
            id,
            question: ask.question,
            scopePlacementId: ask.scopePlacementId,
            caseSelection: ask.caseSelection,
            investigationId: entry.data.id,
            askId: ask.id,
            lineage: ask.lineage ?? null,
          });
      }
    for (const run of state.projectEngineRuns ?? []) {
      const text = run.questions?.[0]?.text;
      if (!text || (run.purpose && !['inquiry', 'question-refresh'].includes(run.purpose)))
        continue;
      let selectedCase = null;
      if (run.case) {
        if (run.caseSelection !== undefined) selectedCase = run.caseSelection;
        else if (!caseInputs.has(run.inputRef)) {
          const input = await readEngineArtifact(project, run.inputRef);
          caseInputs.set(run.inputRef, input.caseSelection);
        }
        selectedCase ??= caseInputs.get(run.inputRef) ?? run.case;
      }
      const id = questionKey(text, run.scopePlacementId, selectedCase);
      const item = items.get(id) ?? {
        id,
        question: text,
        scopePlacementId: run.scopePlacementId,
        caseSelection: selectedCase,
      };
      if (!item.run) items.set(id, { ...item, run });
    }
    if (state.project?.data.id !== project.data.id) return;
    questionProject = project.data.id;
    questions = grouped([...items.values()]).map((item) => ({
      ...item,
      label: item.question + (item.caseSelection ? ` / Case: ${caseName(item.caseSelection)}` : ''),
      scope: project.data.placements.some((p) => p.id === item.scopePlacementId)
        ? placementLabel(project.data, item.scopePlacementId)
        : 'Removed role',
      scopeMissing: !project.data.placements.some((p) => p.id === item.scopePlacementId),
      kind: 'working-question',
      depth: 0,
      placementId: item.scopePlacementId,
    }));
    const drafting =
      state.form?.workspace &&
      state.investigation?.data.asks.find((ask) => ask.id === state.form.askId);
    const selected = drafting
      ? questionKey(drafting.question, drafting.scopePlacementId, drafting.caseSelection)
      : currentKey();
    if (questions.some((item) => item.id === selected)) state.projectEntryId = selected;
  }
  // Development groups questions by where they came from, author's own first.
  const lineageHeadings = {
    author: 'Asked here',
    drafted: 'Drafted',
    outside: 'From outside',
    derived: 'Derived',
  };
  function grouped(items) {
    const key = (item) =>
      JSON.stringify([
        questionLineages.indexOf(item.lineage?.kind ?? 'author'),
        item.lineage?.by ?? '',
      ]);
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(key(item))) groups.set(key(item), []);
      groups.get(key(item)).push(item);
    }
    const ordered = [...groups.entries()].sort(([a], [b]) => {
      const [x, p] = JSON.parse(a),
        [y, q] = JSON.parse(b);
      return x - y || p.localeCompare(q);
    });
    // One kind needs no heading.
    if (ordered.length < 2) return items;
    return ordered.flatMap(([, members]) => {
      const { kind = 'author', by } = members[0].lineage ?? {};
      const section = `${lineageHeadings[kind]}${by ? ` · ${by}` : ''} (${members.length})`;
      return members.map((item) => ({ ...item, section }));
    });
  }
  const developmentItems = () => {
    if (questionProject !== state.project?.data.id) return [];
    if (questionData !== state.project.data) {
      questionData = state.project.data;
      const scopes = new Set(questionData.placements.map((p) => p.id));
      questions = questions.map((item) => ({
        ...item,
        scope: scopes.has(item.scopePlacementId)
          ? placementLabel(questionData, item.scopePlacementId)
          : 'Removed role',
        scopeMissing: !scopes.has(item.scopePlacementId),
      }));
    }
    return questions;
  };
  const selectedQuestion = () =>
    developmentItems().find((item) => item.id === state.projectEntryId);
  async function openDevelopment(id, focus = 'development', { recheck = false } = {}) {
    settleNow(false);
    const item = developmentItems().find((item) => item.id === id);
    if (!item) return;
    state.projectEntryId = id;
    if (item.run && !item.scopeMissing) {
      const byId = new Map(roles().map((r) => [r.id, r]));
      let inside = false;
      for (let at = role(); at; at = byId.get(at.parentId))
        if (at.id === item.scopePlacementId) inside = true;
      if (current?.run.id === item.run.id && current.held && recheck) refresh(false);
      else if (current?.run.id !== item.run.id || !ready())
        await show(item.run.id, {
          placementId: inside ? role().id : item.scopePlacementId,
          recheck,
          focus,
        });
      state.focus = focus;
      state.projectReadingOrigin = 'development';
    } else {
      current = null;
      cancel();
      select(item.scopePlacementId, focus);
      state.projectReadingOrigin = 'development';
    }
    draw();
  }
  // Moving through Development shows each question's saved summary at once; its
  // saved check loads once the selection settles. Nothing is checked again.
  let settle = null;
  function glance(id) {
    clearTimeout(settle?.timer);
    // A saved check still loading for an earlier selection is dropped
    // (review 2026-10-25, #13).
    showing = null;
    state.projectEntryId = id;
    state.projectReadingOrigin = 'development';
    settle = { id, timer: setTimeout(() => settleNow(), config.settleMs ?? 350) };
    draw();
  }
  function settleNow(open = true) {
    if (!settle) return Promise.resolve();
    const { id, timer } = settle;
    clearTimeout(timer);
    settle = null;
    if (!open) return Promise.resolve();
    return openDevelopment(id).catch((error) => {
      if (!disposed) {
        state.failure = error.message;
        draw();
      }
    });
  }
  async function resumeQuestion() {
    await settleNow();
    const item = selectedQuestion();
    if (!item) return ask();
    if (item.scopeMissing) return ask();
    if (item.run) return openDevelopment(item.id, 'reading', { recheck: true });
    state.investigation = await readInvestigation(state.project, item.investigationId);
    state.investigation.data.activeAskId = item.askId;
    return investigation.startAsk();
  }
  const active = () => !disposed && Boolean(state.project && state.mode === 'project');
  const roles = () => {
    if (cachedData === state.project.data) return roleCache;
    cachedData = state.project.data;
    sourcesByRole = new Map();
    for (const source of sourceCatalog(cachedData)) {
      if (source.development?.asserted === false) continue;
      if (!sourcesByRole.has(source.nodeId)) sourcesByRole.set(source.nodeId, []);
      sourcesByRole.get(source.nodeId).push(source);
    }
    roleCache = projectTree(cachedData).map(({ placement, concept, depth }) => ({
      id: placement.id,
      placementId: placement.id,
      parentId: placement.parentId,
      conceptId: concept.id,
      kind: 'concept',
      label: concept.name,
      depth,
      description: concept.description,
      children: [],
    }));
    const byId = new Map(roleCache.map((role) => [role.id, role]));
    for (const role of roleCache) byId.get(role.parentId)?.children.push(role);
    return roleCache;
  };
  const role = () => roles().find((item) => item.id === state.placementId) ?? roles()[0];
  const localSources = () => {
    roles();
    return sourcesByRole.get(state.placementId) ?? [];
  };
  const atCurrentProject = () => current?.run.projectId === state.project?.data.id;
  const ready = () =>
    atCurrentProject() &&
    current.run.projectDigest === state.project.digest &&
    !pending &&
    !current.error &&
    Boolean(current.result && current.recording);
  const select = (id, focus = 'nodes', retainTrail = false) => {
    if (!roles().some((item) => item.id === id)) return;
    inspection = null;
    gap = null;
    rawReading = false;
    if (!retainTrail) trail = [];
    state.placementId = id;
    state.projectConceptId = id;
    state.projectReadingOrigin = 'nodes';
    state.focus = focus;
    state.offset = 0;
  };
  const command = (key, description, run, pane = 'reading') => ({ key, description, run, pane });
  const question = () => current?.input?.question?.text ?? current?.run.questions?.[0]?.text;
  const auditFor = (source) =>
    source.graph && auditor ? auditor(source.text, source.graph) : null;
  function remember() {
    trail.push({
      placementId: state.placementId,
      inspection,
      gap,
      rawReading,
      offset: state.offset,
      origin: state.projectReadingOrigin,
    });
  }
  function back() {
    const prior = trail.pop();
    if (!prior) return;
    state.placementId = prior.placementId;
    state.projectConceptId = prior.placementId;
    state.projectReadingOrigin = prior.origin;
    inspection = prior.inspection;
    gap = prior.gap;
    rawReading = prior.rawReading;
    state.offset = prior.offset;
    state.focus = 'reading';
    revealChoice = true;
  }
  function inspect(source, context = gap) {
    remember();
    inspection = source;
    gap = context;
    rawReading = false;
    state.offset = 0;
    state.focus = 'reading';
    if (!source.graph) {
      const project = state.project;
      const work = { controller: new AbortController(), progress: 'Loading retained reading' };
      inspectionWork?.controller.abort();
      inspectionWork = work;
      work.execution = (async () => {
        const record = await prepareRetainedReading(project, source.text, {
          signal: work.controller.signal,
        });
        if (record && inspection === source && state.project.digest === project.digest)
          inspection = { ...source, ...record };
      })()
        .catch((error) => {
          if (!work.controller.signal.aborted && inspection === source)
            inspection = { ...source, readingError: error.message };
        })
        .finally(() => {
          if (inspectionWork === work) inspectionWork = null;
          if (!disposed) draw();
        });
    }
  }
  function view(section, title = role().label) {
    const entries = choiceRows(section);
    const choiceKey = JSON.stringify([
      state.project.digest,
      current?.run.id,
      state.placementId,
      title,
      inspection?.id,
      inspection?.sentenceId,
      inspection?.text,
      gap?.cells,
    ]);
    const selected =
      entries.find((entry) => entry.choiceIndex === selections.get(choiceKey)) ?? entries[0];
    if (selected) selections.set(choiceKey, selected.choiceIndex);
    if (selections.size > 200) selections.delete(selections.keys().next().value);
    for (const entry of entries) entry.selected = entry === selected;
    const result = {
      title,
      // The view is rebuilt when drawn. Choices remain valid only in this same
      // project revision, question, role and inspected text.
      choiceKey,
      activeChoice: selected?.choiceIndex,
      choiceIndex: revealChoice ? selected?.choiceIndex : null,
      consumeChoiceReveal() {
        revealChoice = false;
      },
      sections: [{ ...section, label: title, key: 'Question' }],
      sectionIndex: 0,
      selectChoice(index) {
        if (!entries.some((entry) => entry.choiceIndex === index)) return;
        selections.set(choiceKey, index);
        revealChoice = true;
      },
      onChoice(index) {
        const item = entries.find((item) => item.choiceIndex === index);
        if (!item) return;
        selections.set(choiceKey, index);
        if (item?.source) {
          inspect(item.source);
        } else if (item?.placementId) {
          remember();
          select(item.placementId, 'reading', true);
        } else if (item?.openings && selectedGapAnchor()) {
          // The selected gap already shows what it touches; Enter acts on it.
          return addStatementAtGap();
        }
      },
    };
    return result;
  }
  const heldNotes = {
    changed: 'The statements changed since this check.',
    released: 'The full check was released from storage.',
    unfinished: 'The last check did not finish.',
  };
  /** A saved question as last checked, shown without checking it again. */
  function savedQuestion(item, held = null) {
    const run = held?.run ?? item.run;
    const answer = run?.answer ?? run?.lastAnswer;
    return view(
      {
        rows: [
          ['Question', item.question, 'input'],
          ['Asked at', item.scope],
          ...(item.caseSelection ? [['Case', caseName(item.caseSelection)]] : []),
          run
            ? ['Last check', assessedState[run.status] ?? run.status]
            : ['Draft', 'Saved; not checked yet.'],
          ...(answer?.answers ?? []).map((binding, index) => [
            index ? '' : 'Answer',
            binding.text + (binding.conditional ? ' (when its conditions hold)' : ''),
          ]),
          ...(held
            ? [
                ['Not shown', heldNotes[held.held], 'warning'],
                ['', 'Enter checks it again.', 'muted'],
              ]
            : run
              ? [['', 'Loading the saved check.', 'muted']]
              : []),
        ],
      },
      'Develop question',
    );
  }
  function readingView() {
    if (!active()) return null;
    const selected = selectedQuestion();
    if (selected?.scopeMissing && state.projectReadingOrigin === 'development')
      return view(
        {
          rows: [
            ['Question', selected.question, 'input'],
            ['Scope', 'The role where this question started was removed.', 'warning'],
          ],
        },
        'Develop question',
      );
    if (inspection)
      return view(
        {
          heading: 'Check the language reading',
          rows: [
            ['Text', inspection.text, 'input'],
            [
              'Kind',
              inspection.kind === 'question'
                ? 'Question'
                : inspection.kind === 'case'
                  ? 'Case statement'
                  : 'Source statement',
            ],
            ...(gap ? [['Connection', gap.cells[0], 'warning']] : []),
            ...(!inspection.graph
              ? [
                  [
                    'Reading',
                    inspectionWork
                      ? 'Loading retained reading'
                      : (inspection.readingError ?? 'No retained reading for this exact text'),
                    'warning',
                  ],
                ]
              : []),
          ],
          groups: [
            ...readingWarnings(auditFor(inspection)),
            ...(inspection.graph
              ? [
                  {
                    ...(rawReading
                      ? relationMeaning(inspection.graph, { text: inspection.text })
                      : {
                          table: {
                            headers: ['Subject', 'Relationship', 'Participant'],
                            widths: [null, null, null],
                            minWidth: 50,
                            repeatColumns: 0,
                            entries: relationMeaning(inspection.graph, {
                              text: inspection.text,
                            }).relations.map((entry) => ({ cells: entry.cells.slice(0, 3) })),
                          },
                        }),
                    heading: 'How this text was read',
                  },
                ]
              : []),
          ],
        },
        'Language reading',
      );
    const glanced =
      (settle || showing) && state.projectReadingOrigin === 'development' && selectedQuestion();
    if (glanced) return savedQuestion(glanced);
    if (atCurrentProject() && current.held && !pending && !current.error)
      return savedQuestion(
        developmentItems().find((item) => item.run?.id === current.run.id) ?? {
          question: question(),
          scope: placementLabel(state.project.data, current.run.scopePlacementId),
        },
        current,
      );
    if (atCurrentProject() && (pending || current.error || !ready()))
      return view(
        {
          heading: 'Follow the question',
          rows: [
            ['Question', question(), 'input'],
            [
              current.error ? 'Could not check' : 'Checking',
              current.error ?? pending?.progress ?? 'Following the question through its roles',
              current.error ? 'warning' : 'input',
            ],
          ],
        },
        'Question',
      );
    if (ready())
      return view(
        journeySection({ ...current, project: state.project }, state.placementId),
        'Develop question',
      );
    const draft = selectedQuestion();
    if (state.projectReadingOrigin === 'development' && draft && !draft.run)
      return view(
        {
          rows: [
            ['Question', draft.question, 'input'],
            ['Asked at', draft.scope],
            ['Draft', 'Saved; not checked yet.'],
          ],
        },
        'Develop question',
      );
    const sources = localSources();
    return view({
      rows: [
        ...(role().description ? [['', role().description]] : []),
        [
          'Scope',
          'The question follows this role and its children. Each source keeps its own attribution.',
        ],
      ],
      groups: [
        {
          heading: 'Source statements',
          ...(sources.length
            ? { table: sourceStatements(sources, { audit: auditFor }) }
            : { rows: [['', 'No source statements at this role.', 'muted']] }),
        },
        ...(role().children.length
          ? [
              {
                heading: 'Children',
                table: {
                  headers: ['Role', 'Sources here'],
                  widths: [null, 16],
                  minWidth: 0,
                  repeatColumns: 0,
                  entries: role().children.map((child, index) => ({
                    cells: [child.label, String(sourcesByRole.get(child.id)?.length ?? 0)],
                    choiceIndex: index,
                    placementId: child.id,
                  })),
                },
              },
            ]
          : []),
      ],
    });
  }
  // A saved check that cannot be shown in full is held, not re-run: checking
  // again is the author's choice.
  const heldReason = (run, project) =>
    run.projectDigest !== project.digest
      ? 'changed'
      : !run.resultRef
        ? 'released'
        : run.semantic || unfinished.includes(run.status)
          ? 'unfinished'
          : null;
  const unfinished = [
    'cancelled',
    'interrupted',
    'failed',
    'stale',
    'needs-amr',
    'invalid-amr',
    'needs-reading',
  ];
  // The latest show wins; an earlier one still loading is dropped.
  let showing = null;
  async function show(runId, { placementId, recheck = false, focus = 'reading' } = {}) {
    const project = state.project,
      token = {};
    showing = token;
    cancel();
    inspection = null;
    try {
      const run = await readEngineRun(project, runId).catch((error) => {
        const prior = state.projectEngineRuns?.find((r) => r.id === runId);
        if (error.code !== 'ENOENT' || !prior) throw error;
        return { ...prior, inputRef: null, resultRef: null };
      });
      const held = heldReason(run, project);
      const rebuildInput = () =>
        inputFromProject(project, {
          scopePlacementId: run.scopePlacementId,
          question: run.questions[0].text,
          caseSelection:
            run.caseSelection !== undefined
              ? run.caseSelection
              : run.case
                ? selectedQuestion()?.caseSelection
                : null,
        });
      let input, result;
      try {
        [input, result] = await Promise.all([
          run.inputRef ? readEngineArtifact(project, run.inputRef) : rebuildInput(),
          // A held check is not shown in full; its large result is not read.
          run.resultRef && !held ? readEngineArtifact(project, run.resultRef) : null,
        ]);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // A bounded cache can be replaced while a selected question is loading.
        input = await rebuildInput();
        result = null;
      }
      if (showing !== token || state.project?.data.id !== project.data.id) return;
      // The question becomes current only once it can be shown, so the reading
      // pane never presents a saved check that is still loading as running.
      const next = { project, run, input, result, recording: null, held: null };
      const present = () => {
        current = next;
        state.mode = 'project';
        state.form = null;
        select(placementId ?? run.scopePlacementId, focus);
      };
      const hold = (reason) => {
        present();
        if (recheck) return refresh(false);
        current.held = reason;
        draw();
      };
      if (held || !result) return hold(held ?? 'released');
      let retained = false;
      if (run.recording) {
        try {
          next.recording = await readSavedRecording(run.recording.path);
        } catch (error) {
          if (!['ENOENT', 'RECORDING_CACHE_MISS'].includes(error.code)) throw error;
          if (showing === token) hold('released');
          return;
        }
      } else if (result?.inputs?.at(-1)?.graph) {
        const { asset } = prepareProjectInquiry(
          project,
          run.scopePlacementId,
          input.question.text,
          {
            caseSelection: input.caseSelection,
          },
        );
        next.recording = (await retainInquiryTraversal(project, run, result, asset)).recording;
        retained = true;
      }
      if (showing !== token) return;
      present();
      if (current.recording) {
        current.recordingPath = run.recording?.path ?? null;
        state.ix = indexRecording(current.recording);
        state.selection = initialSelection(state.ix);
      }
      await projects.refreshOutline();
      draw();
      // Showing a saved check writes nothing unless its recording was retained now.
      if (retained) maintain(project);
    } finally {
      if (showing === token) showing = null;
    }
  }
  function maintain(project) {
    // Cleanup must not occupy the keyboard queue or hide a completed answer.
    maintenance = maintenance
      .then(() => backgroundEngineStorage(project))
      .catch((error) => {
        if (!disposed && state.project?.data.id === project.data.id) {
          state.failure = 'Storage cleanup failed: ' + error.message;
          draw();
        }
      });
  }
  function cancel() {
    pending?.controller.abort();
    pending = null;
  }
  function refresh(acquireMissing = false) {
    if (!atCurrentProject() || pending) return;
    const prior = current,
      project = state.project;
    const work = {
      controller: new AbortController(),
      progress: 'Following the question through its roles',
      run: null,
    };
    pending = work;
    current.error = null;
    current.held = null;
    const capture = config.captureInquiry ?? captureProjectInquiry;
    work.execution = capture(
      project,
      prior.run.scopePlacementId,
      prior.input.question.text,
      (message) => {
        if (pending === work) {
          work.progress = message;
          draw();
        }
      },
      work.controller.signal,
      {
        actor: config.actor ?? 'participant',
        via: 'workbench',
        acquireMissing,
        caseSelection: prior.input.caseSelection,
        onEngineUpdate(run) {
          work.run = run;
          for (const [client, service] of [
            ['AMR', 'egemma'],
            ['PENMAN', 'penman'],
            ['SEMCAT', 'semcat'],
          ])
            state.serviceStatus[service] =
              run.calls.findLast((call) => call.client === client)?.status ?? 'idle';
        },
      },
    )
      .then(async ({ recording }) => {
        if (pending !== work || work.controller.signal.aborted) return;
        const run = await readEngineRun(project, recording.reasoning.runId);
        const [input, result] = await Promise.all([
          readEngineArtifact(project, run.inputRef),
          readEngineArtifact(project, run.resultRef),
        ]);
        if (pending !== work || work.controller.signal.aborted) return;
        current = { project, run, input, result, recording };
        current.recordingPath = run.recording?.path ?? null;
        state.ix = indexRecording(recording);
        state.selection = initialSelection(state.ix);
        await projects.refreshOutline();
        maintain(project);
      })
      .catch((error) => {
        if (!work.controller.signal.aborted && current === prior) {
          current.error = error.message;
          current.attemptedRevision = project.digest;
        }
      })
      .finally(() => {
        if (pending === work) pending = null;
        if (!disposed) draw();
      });
    draw();
  }
  function sync() {
    if (!active()) {
      if (pending && state.mode === 'home') cancel();
      return;
    }
    if (current && !atCurrentProject()) {
      cancel();
      current = null;
      inspection = null;
    }
    if (current && !state.form && !settle) {
      state.projectEntryId = currentKey();
      if (!state.project.data.placements.some((p) => p.id === current.run.scopePlacementId)) {
        cancel();
        current = null;
        state.projectReadingOrigin = 'development';
      }
    }
    if (
      atCurrentProject() &&
      !state.form &&
      !pending &&
      !current.held &&
      current.run.projectDigest !== state.project.digest &&
      current.attemptedRevision !== state.project.digest
    )
      refresh(false);
  }
  async function ask(options = {}) {
    cancel();
    inspection = null;
    if (selectedQuestion()?.scopeMissing)
      options = {
        question: selectedQuestion().question,
        scopePlacementId: role().id,
        ...options,
      };
    // Ask starts a new question; saved drafts resume from Development.
    await investigation.startAsk({ fresh: true, ...options });
  }
  async function openQuestion() {
    await projects.refreshOutline();
    const selected = selectedQuestion() ?? developmentItems()[0];
    state.focus = 'development';
    state.projectReadingOrigin = 'development';
    if (selected) await openDevelopment(selected.id);
  }
  function selectedRow() {
    const displayed = readingView();
    return displayed?.sections
      .flatMap(choiceRows)
      .find((entry) => entry.choiceIndex === displayed.activeChoice);
  }
  function selectedGapOpening() {
    return gap?.openings?.[0] ?? selectedRow()?.openings?.[0] ?? null;
  }
  function selectedGapAnchor() {
    const opening = selectedGapOpening();
    if (!opening) return null;
    const scope = current?.run?.scopePlacementId ?? state.placementId;
    const contribution =
      state.project.data.contributions?.find((entry) => entry.id === opening.contributionId) ??
      state.project.data.contributions?.find(
        (entry) =>
          entry.question?.text === question() &&
          entry.scopePlacementId === scope &&
          entry.partial &&
          partialIdentity(entry.partial.caseSelection ?? null) ===
            partialIdentity(current?.input?.caseSelection ?? null),
      ) ??
      (ready()
        ? {
            question: current.result.inputs.find((entry) => entry.kind === 'question'),
            partial: current.run.answer?.partial,
          }
        : null);
    if (!contribution?.question) return null;
    const stored = (contribution.partial?.aporias ?? contribution.partial?.openings)?.find(
      (entry) =>
        (opening.id && entry.id === opening.id) ||
        (opening.identity && entry.identity === opening.identity) ||
        JSON.stringify(entry.anchor) === JSON.stringify(opening.anchor),
    );
    const anchor = stored?.anchor ?? opening.anchor;
    if (!anchor) return null;
    const label =
      opening.label ??
      ([opening.from, opening.role, opening.to].filter(Boolean).join(' ') || 'Selected connection');
    return {
      kind: anchor.kind ?? 'node',
      contributionId: contribution.id,
      partId: stored?.partId ?? 'question',
      nodeId: anchor.nodeId ?? anchor.to ?? anchor.from,
      ...(anchor.edgeId
        ? { edgeId: anchor.edgeId, from: anchor.from, to: anchor.to, role: anchor.role }
        : {}),
      revision: contributionRevision(contribution.question.graph),
      question: contribution.question.text,
      label,
    };
  }
  function developSelectedGap() {
    const anchor = selectedGapAnchor();
    if (anchor) development.open({ anchor });
  }
  async function addStatementAtGap() {
    let anchor = selectedGapAnchor();
    if (!anchor) return;
    // An explicit elaboration can start with an entirely open contribution.
    // Retain its acquired question and gaps, never assert the question itself.
    if (!anchor.contributionId) {
      const { data, contribution } = retainPartialContribution(
        state.project,
        current.input,
        current.result,
        { retainOpenings: true },
      );
      state.project = await projects.persistProject(state.project, data);
      anchor = { ...anchor, contributionId: contribution.id };
    }
    development.materialEditor(null, anchor);
  }
  /** The recorded opening a selected gap continues from, if this recording has one. */
  function continuationOpening(selected) {
    if (!current?.recording || !selected) return null;
    const openings = evidenceOpenings(state.ix, state.selection, state.interpretationDecisions);
    const anchor = selected?.anchor;
    const relationOf = (item) =>
      item?.edge ?? item?.anchor ?? (item?.from && item?.role && item?.to ? item : null);
    const wanted = relationOf(selected);
    const sameRelation = (item) => {
      const edge = relationOf(item);
      return Boolean(
        edge &&
        wanted &&
        item?.role !== 'concept' &&
        edge.role === wanted.role &&
        edge.from === wanted.from &&
        edge.to === wanted.to,
      );
    };
    const provenance = (item) =>
      item.sourceId === (selected?.sourceId ?? null) &&
      [item.id, item.edge?.id, item.anchor?.edgeId].some((id) =>
        [selected?.id, selected?.edge?.id, anchor?.edgeId, selected?.edgeId].includes(id),
      );
    return (
      openings.find(provenance) ??
      openings.find(
        (item) =>
          sameRelation(item) && (!selected?.sourceId || item.sourceId === selected.sourceId),
      ) ??
      null
    );
  }
  async function startContinuation(selected) {
    const opening = continuationOpening(selected);
    if (!opening) return false;
    const path = current.recordingPath ?? current.run.recording?.path;
    if (!path) return;
    const continuation = authoredContinuation(
      state.ix,
      state.selection,
      path,
      opening,
      state.interpretationDecisions,
      {
        action: 'continue-opening',
        rationale: `Continue from the open connection: ${opening.label ?? opening.id}.`,
      },
    );
    const originOpening = selected
      ? {
          id: selected.id,
          kind: selected.kind ?? 'query',
          label: selected.label ?? selected.id,
          ...(selected.anchor
            ? { anchor: structuredClone(selected.anchor) }
            : opening.anchor
              ? { anchor: structuredClone(opening.anchor) }
              : {}),
          ...(selected.edge
            ? { edge: structuredClone(selected.edge) }
            : opening.edge
              ? { edge: structuredClone(opening.edge) }
              : {}),
          sourceId: selected.sourceId ?? opening.sourceId ?? null,
        }
      : continuation.opening;
    const origin = {
      path,
      recordingRevision: interpretationRevision(current.recording),
      nodeId: state.selection.nodeId,
      occurrenceId: state.selection.occurrenceId,
      sourceId: opening.sourceId ?? null,
      askId: current.recording.ask?.askId ?? null,
      opening,
    };
    continuation.originOpening = originOpening;
    continuation.retainedOpening = structuredClone(continuation.opening);
    await investigation.startAsk({
      followup: true,
      continuation,
      origin,
      question: current.input.question.text,
      scopePlacementId: current.run.scopePlacementId,
      caseSelection: current.input.caseSelection ?? null,
    });
    return true;
  }
  async function continueCurrentQuestion() {
    await startContinuation(selectedGapOpening());
  }
  function inspectReading() {
    const selected = selectedRow();
    const source =
      selected?.source ??
      (ready() ? current.result.inputs.find((entry) => entry.kind === 'question') : null);
    if (source) inspect(source, selected?.openings ? selected : gap);
  }
  async function editReading() {
    const source = inspection;
    if (
      source.kind === 'question' ||
      (source.kind === 'case' && current.input.caseSelection?.kind === 'authored')
    ) {
      await investigation.startAsk({
        fresh: true,
        question: question(),
        scopePlacementId: current.run.scopePlacementId,
        caseSelection: current.input.caseSelection,
      });
      if (source.kind === 'case') investigation.editCase();
    } else {
      state.placementId = source.placementId ?? source.nodeId;
      state.projectConceptId = state.placementId;
      development.statementsEditor({ source });
    }
  }
  async function sourceSaved(id) {
    const source = state.project.data.contributions.find((entry) => entry.id === id);
    state.form = null;
    state.mode = 'project';
    select(source.scopePlacementId, 'reading');
    sync();
  }
  function editSources() {
    development.statementsEditor();
  }
  function connections() {
    const choices = state.project.data.contributions.flatMap((c) =>
      c.wordings
        .filter((w) => !w.withdrawn && w.kind === 'clarification')
        .map((w) => ({
          label: w.text,
          contributionId: c.id,
          partId: w.id,
        })),
    );
    investigation.picker('Confirmed connections', choices, (choice) =>
      development.withdrawDeclaration(choice.contributionId, choice.partId),
    );
  }
  function actions() {
    if (!active() || state.help || state.quitPrompt || state.form || state.resizing) return [];
    if (inspection)
      return [
        command('e', 'revise wording', editReading),
        command('ESCAPE', 'back', back),
        { ...command('i', 'back', back), helpOnly: true },
        ...(inspection.graph
          ? [
              command('g', rawReading ? 'relationship table' : 'original reading', () => {
                rawReading = !rawReading;
                state.offset = 0;
              }),
            ]
          : []),
      ];
    const selected = selectedRow();
    const selectionActions = selected
      ? [
          { ...command('UP', 'select row', () => handleKey('UP')), displayKey: '↑↓' },
          { ...command('DOWN', 'next row', () => handleKey('DOWN')), helpOnly: true },
          ...(selected.openings && !selectedGapAnchor()
            ? []
            : [
                command(
                  'ENTER',
                  selected.source
                    ? 'read selected text'
                    : selected.openings
                      ? 'add statement here'
                      : 'follow selected role',
                  () => readingView().onChoice(readingView().activeChoice),
                ),
              ]),
        ]
      : [];
    const common = [
      command('a', 'ask here', () => ask()),
      command('n', 'add statements', () => development.statementsEditor({ add: true })),
      ...(localSources().length ? [command('e', 'edit statements', editSources)] : []),
    ];
    const result = common.flatMap((item) => [item, { ...item, pane: 'nodes' }]);
    // Development is a pane of its own, reachable from anywhere.
    result.push(command('o', 'development', openQuestion, 'global'));
    result.push(command('a', 'ask here', () => ask(), 'development'));
    result.push(
      command(
        'n',
        'add statements',
        () => development.statementsEditor({ add: true }),
        'development',
      ),
    );
    if (developmentItems().length) {
      // Selecting a checked question shows its answer; Enter checks a held one
      // again and finishes a draft.
      const item = selectedQuestion();
      const checked = Boolean(item?.run && !item.scopeMissing);
      const held = checked && current?.held && current.run.id === item.run.id;
      result.push({
        ...command(
          'ENTER',
          held ? 'check again' : checked ? 'work on question' : 'finish question',
          resumeQuestion,
          'development',
        ),
        ...(checked && !held ? { helpOnly: true } : {}),
      });
    }
    const selectedPurpose = selectedQuestion();
    if (selectedPurpose?.investigationId && selectedPurpose?.askId && !selectedPurpose.scopeMissing)
      result.push(command('i', 'purpose', () => investigation.reframe(), 'development'));
    result.push(command('c', 'add child', () => projects.handleProjectKey('c'), 'nodes'));
    result.push(command('ENTER', 'edit role', () => projects.editSelected(), 'nodes'));
    for (const [key, description] of [
      ['s', 'add sibling'],
      ['m', 'move role'],
      ['x', 'remove role'],
    ])
      if (projects.projectActionEnabled(key, 'nodes'))
        result.push({
          ...command(key, description, () => projects.handleProjectKey(key), 'nodes'),
          helpOnly: true,
        });
    result.push(...selectionActions);
    if (selected?.openings && selectedGapAnchor())
      result.push(
        // Enter adds the statement; n stays bound to the same action.
        { ...command('n', 'add statement here', addStatementAtGap), helpOnly: true },
        ...(selectedGapAnchor().contributionId
          ? [command('d', 'elaborate connection', developSelectedGap)]
          : []),
      );
    // Offer continuation only where a recorded opening can carry it.
    if (selected?.openings && continuationOpening(selectedGapOpening()))
      result.push(command('c', 'continue question', continueCurrentQuestion));
    if (!current && !selected)
      result.push(
        state.projectReadingOrigin === 'development' && selectedQuestion()
          ? command('ENTER', 'finish question', resumeQuestion)
          : command('ENTER', 'edit role', () => projects.editSelected()),
      );
    if (ready()) {
      const candidates = (current.run.answer?.clarifications ?? []).filter(
        (candidate) =>
          state.placementId === current.run.scopePlacementId ||
          candidate.source.nodeId === state.placementId,
      );
      // A selected gap's own d (elaborate connection) keeps its meaning.
      if (candidates.length && !result.some((item) => item.key === 'd' && item.pane === 'reading'))
        result.push(
          command('d', 'clarify connection', () =>
            development.clarifyConnection({
              ...current,
              run: {
                ...current.run,
                answer: { ...current.run.answer, clarifications: candidates },
              },
            }),
          ),
        );
      result.push(command('r', 'check again', () => refresh(true)));
      result.push(
        command('ESCAPE', trail.length ? 'back to role' : 'close question', () => {
          if (trail.length) return back();
          cancel();
          current = null;
          state.projectReadingOrigin = 'nodes';
          state.offset = 0;
        }),
      );
    } else if (pending)
      result.push(
        command('ESCAPE', 'cancel check', () => {
          cancel();
          current = null;
          state.projectReadingOrigin = 'nodes';
          state.offset = 0;
        }),
      );
    else if (current?.held) {
      result.push(command('ENTER', 'check again', () => refresh(false)));
      result.push(
        command('ESCAPE', 'close question', () => {
          current = null;
          trail = [];
          state.projectReadingOrigin = 'nodes';
          state.offset = 0;
        }),
      );
    } else if (current?.error) {
      result.push(command('r', 'retry check', () => refresh(true)));
      result.push(
        command('ESCAPE', 'close question', () => {
          current = null;
          trail = [];
          gap = null;
          state.projectReadingOrigin = 'nodes';
          state.offset = 0;
        }),
      );
    }
    if (ready() || selected?.source)
      result.push(
        // Enter already reads a selected text; list the key once.
        selected?.source
          ? { ...command('i', 'read selected text', inspectReading), helpOnly: true }
          : command('i', 'question reading', inspectReading),
      );
    if (!current && trail.length) result.push(command('ESCAPE', 'back to role', back));
    if (
      (state.project.data.contributions ?? []).some((c) =>
        c.wordings.some((w) => !w.withdrawn && w.kind === 'clarification'),
      )
    )
      result.push(command('u', 'confirmed connections', connections));
    // A shortcut promised in the working view also works while its role or
    // question is selected in the sidebar. Focus must not change its meaning.
    for (const item of result.filter(
      (item) => item.pane === 'reading' && ['d', 'r', 'i', 'u', 'ESCAPE'].includes(item.key),
    ))
      for (const pane of ['nodes', 'development']) {
        // A pane's own key keeps its meaning there.
        if (result.some((own) => own.pane === pane && own.key === item.key)) continue;
        // Development shows the selected question's answer, so its check is listed there.
        const listed = item.key === 'd' || (pane === 'development' && item.key === 'r');
        result.push({ ...item, pane, helpOnly: !listed });
      }
    return result;
  }
  async function handleKey(key) {
    if (!active() || state.form) return false;
    if (key === 'R') return true;
    const moves = ['UP', 'DOWN', 'k', 'j', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN'];
    // Any key other than moving through Development acts on the settled selection.
    if (state.focus !== 'development' || !moves.includes(key)) await settleNow();
    if (
      state.focus === 'reading' &&
      !inspection &&
      ['UP', 'DOWN', 'k', 'j', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN'].includes(key)
    ) {
      const displayed = readingView();
      const entries = displayed.sections.flatMap(choiceRows);
      if (entries.length) {
        const at = Math.max(
          0,
          entries.findIndex((entry) => entry.choiceIndex === displayed.activeChoice),
        );
        const visible = entries.flatMap((entry, index) =>
          state.viewport?.choiceHits?.some((hit) => hit.index === entry.choiceIndex) ? [index] : [],
        );
        const next =
          key === 'HOME'
            ? 0
            : key === 'END'
              ? entries.length - 1
              : key === 'PAGE_DOWN'
                ? Math.min(entries.length - 1, Math.max(at + 1, visible.at(-1) ?? at + 1))
                : key === 'PAGE_UP'
                  ? Math.max(0, Math.min(at - 1, visible[0] ?? at - 1))
                  : Math.max(
                      0,
                      Math.min(entries.length - 1, at + (['UP', 'k'].includes(key) ? -1 : 1)),
                    );
        displayed.selectChoice(entries[next].choiceIndex);
        return true;
      }
    }
    if (
      state.focus === 'development' &&
      ['UP', 'DOWN', 'k', 'j', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN'].includes(key)
    ) {
      const entries = developmentItems();
      if (!entries.length) return true;
      const index = Math.max(
        0,
        entries.findIndex((item) => item.id === state.projectEntryId),
      );
      const delta = ['UP', 'k'].includes(key)
        ? -1
        : ['DOWN', 'j'].includes(key)
          ? 1
          : key === 'PAGE_UP'
            ? -Math.max(
                1,
                new Set((state.viewport?.developmentHits ?? []).map((hit) => hit.id)).size - 1,
              )
            : Math.max(
                1,
                new Set((state.viewport?.developmentHits ?? []).map((hit) => hit.id)).size - 1,
              );
      const next =
        key === 'HOME'
          ? 0
          : key === 'END'
            ? entries.length - 1
            : Math.max(0, Math.min(entries.length - 1, index + delta));
      glance(entries[next].id);
      return true;
    }
    const action = actions().find((item) => item.pane === state.focus && item.key === key);
    if (action) {
      await action.run();
      return true;
    }
    if (state.focus === 'nodes' && ['LEFT', 'RIGHT'].includes(key)) {
      const target = key === 'LEFT' ? role().parentId : role().children[0]?.id;
      if (target) select(target);
      return true;
    }
    if (
      state.focus === 'nodes' &&
      ['UP', 'DOWN', 'k', 'j', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN'].includes(key)
    ) {
      const entries = roles(),
        index = entries.findIndex((item) => item.id === state.placementId);
      const delta = ['UP', 'k'].includes(key)
        ? -1
        : ['DOWN', 'j'].includes(key)
          ? 1
          : key === 'PAGE_UP'
            ? -Math.max(1, (state.viewport?.nodeHits?.length ?? 2) - 1)
            : Math.max(1, (state.viewport?.nodeHits?.length ?? 2) - 1);
      select(
        entries[
          key === 'HOME'
            ? 0
            : key === 'END'
              ? entries.length - 1
              : Math.max(0, Math.min(entries.length - 1, index + delta))
        ].id,
      );
      return true;
    }
    return ![
      'TAB',
      'SHIFT_TAB',
      'w',
      '?',
      'f',
      'ESCAPE',
      'BACKSPACE',
      'PAGE_UP',
      'PAGE_DOWN',
      'HOME',
      'END',
      'UP',
      'DOWN',
      'j',
      'k',
    ].includes(key);
  }
  loading = Promise.resolve()
    .then(async () => {
      if (state.project) await projects.refreshOutline();
      if (!disposed) draw();
    })
    .catch((error) => {
      if (!disposed) state.failure = error.message;
    });
  retainedReadingAuditor()
    .then((value) => {
      auditor = value;
      if (
        !state.closed &&
        active() &&
        (inspection?.graph || localSources().some((source) => source.graph))
      )
        draw();
    })
    .catch((error) => {
      if (!disposed) {
        state.failure = error.message;
        draw();
      }
    });
  return {
    active,
    refreshQuestions,
    developmentItems,
    selectedQuestion,
    openDevelopment,
    roles,
    role,
    select,
    readingView,
    actions,
    handleKey,
    ask,
    show,
    sync,
    cancel,
    dispose: () => {
      disposed = true;
      settleNow(false);
      cancel();
      inspectionWork?.controller.abort();
    },
    sourceSaved,
    activity: () => pending ?? inspectionWork,
    idle: async () => {
      await settleNow();
      await loading;
      await pending?.execution;
      await inspectionWork?.execution;
      await maintenance;
    },
    current: () => (ready() ? current : null),
  };
}
