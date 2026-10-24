/** Selected questions stay current; History retains the original inquiry evidence. */
import { dirname } from 'node:path';
import { readEngineRun, readEngineArtifact } from '../../project/storage/engine-runs.mjs';
import { engineInputChanges, runEngine } from '../../engine/run.mjs';
import { inputFromProject } from '../../engine/input.mjs';
import { openProject } from '../../project/authoring/project.mjs';
import { inquirySections, clientSections } from './view.mjs';
import { readingDevelopment } from '../shell/state.mjs';
import { deleteEngineRuns } from '../../project/inquiries/delete-engine-runs.mjs';
import { listProjectRecordings } from '../../project/inquiries/recordings.mjs';

export function createEngine({ state, config = {}, forms, projects, draw, setNotice }) {
  const saved = new Map(),
    pending = new Set();
  const key = (run) => `${state.project.path}:${run.id}`;
  const selectedRun = () => {
    if (
      state.closed ||
      state.form ||
      state.help ||
      state.quitPrompt ||
      !state.project ||
      !(state.mode === 'project' || readingDevelopment(state))
    )
      return null;
    const item = state.projectReadingEntry?.();
    return item?.runs?.find((run) => run.id === state.projectReadingRunId) ?? item?.latestRun;
  };
  const readingView = () => {
    const run = selectedRun();
    return run ? saved.get(key(run)) : null;
  };
  const visible = (view) => !state.closed && readingView() === view;
  const earlier = (run) =>
    Boolean(run.semantic) ||
    run.projectDigest !== state.project.digest ||
    run.status === 'stale' ||
    (run.purpose === 'question-refresh' && ['cancelled', 'interrupted'].includes(run.status));
  const historical = (run) => state.projectReadingRunId === run.id;
  const activity = () => {
    const check = readingView()?.currentCheck;
    return check && !check.finished && !check.controller.signal.aborted ? check : null;
  };
  const clientStatus = (run) => {
    for (const [client, service] of [
      ['AMR', 'egemma'],
      ['PENMAN', 'penman'],
      ['SEMCAT', 'semcat'],
    ])
      state.serviceStatus[service] =
        run?.calls.filter((call) => call.client === client).at(-1)?.status ?? 'idle';
  };
  function track(operation) {
    pending.add(operation);
    operation.finally(() => pending.delete(operation));
  }
  function refresh(view) {
    const review = view.engineReview;
    const key = view.sections?.[view.sectionIndex]?.key;
    const checking = earlier(review.run) && !historical(review.run);
    view.sections = checking
      ? [
          {
            key: 'Outcome',
            label: 'Result',
            heading: 'Question and result',
            rows: [
              ['Question', review.run.questions?.[0]?.text ?? '', 'input'],
              [
                'State',
                view.currentCheck?.error
                  ? 'The current check could not finish'
                  : 'Checking the current corpus',
              ],
              ...(view.currentCheck?.error
                ? [['Problem', view.currentCheck.error, 'warning']]
                : view.currentCheck?.progress
                  ? [['Progress', view.currentCheck.progress]]
                  : []),
            ],
          },
        ]
      : inquirySections(
          review.run,
          review.input,
          review.result,
          review.selected,
          review.input ? engineInputChanges(state.project, review.input) : [],
          {
            earlierRevision: earlier(review.run),
            historical: historical(review.run),
          },
        );
    review.history =
      state
        .projectDevelopmentOutline()
        .find((item) => item.runs?.some((run) => run.id === review.run.id))?.runs ?? [];
    if (review.history.length > 1 || (checking && review.history.length))
      view.sections.push({
        key: 'History',
        label: 'History',
        heading: 'Saved results for this question',
        table: {
          headers: ['Saved', 'State', 'Case'],
          widths: [19, 16, null],
          minWidth: 0,
          repeatColumns: 0,
          entries: review.history.map((run, index) => ({
            cells: [
              `${index === (review.selected.History ?? 0) ? '>' : ' '} ${run.startedAt.replace('T', ' ').slice(0, 16)}`,
              !run.semantic && run.projectDigest === state.project.digest
                ? run.status
                : `${run.status} (earlier assessment)`,
              run.case || 'No case',
            ],
            choiceIndex: index,
            cellTones: { 0: index === (review.selected.History ?? 0) ? 'selected' : 'plain' },
          })),
        },
      });
    const previous = view.sections.findIndex((s) => s.key === key);
    view.sectionIndex = previous >= 0 ? previous : 0;
    if (view.error)
      (view.sections[view.sectionIndex].rows ??= []).push(['Error', view.error, 'warning']);
    const call = review.run.calls[review.selected.Clients ?? 0],
      payload = call && review.payloads.get(call.id);
    const section = view.sections.find((s) => s.key === 'Clients');
    if (section && payload?.request) {
      const details = section.groups[0],
        provenance = details.rows.slice(4);
      details.rows = details.rows.slice(0, 4);
      section.groups.push(
        ...clientSections(call, payload.request, payload.response, {
          itemIndex: review.selected.ClientInput ?? 0,
        }),
        ...(provenance.length ? [{ heading: 'Client provenance', rows: provenance }] : []),
      );
    } else if (section && call)
      section.groups[0].rows.push(
        payload?.error
          ? ['Client evidence', payload.error, 'warning']
          : ['Client evidence', 'Loading saved request and response'],
      );
  }
  function loadClient(view) {
    if (view.sections[view.sectionIndex]?.key !== 'Clients') return;
    const review = view.engineReview,
      call = review.run.calls[review.selected.Clients ?? 0];
    if (!call) return;
    const existing = review.payloads.get(call.id);
    if (existing && existing.responseRef === call.responseRef) return;
    const project = state.project;
    const loading = { loading: true, responseRef: call.responseRef };
    review.payloads.set(call.id, loading);
    track(
      (async () => {
        try {
          const [request, response] = await Promise.all([
            readEngineArtifact(project, call.requestRef),
            call.responseRef ? readEngineArtifact(project, call.responseRef) : null,
          ]);
          if (review.payloads.get(call.id) === loading)
            review.payloads.set(call.id, { request, response, responseRef: call.responseRef });
        } catch (error) {
          if (review.payloads.get(call.id) === loading)
            review.payloads.set(call.id, { error: error.message, responseRef: call.responseRef });
        }
        if (visible(view)) {
          refresh(view);
          draw();
        }
      })(),
    );
  }
  function configure(view, run, input = null, result = null) {
    view.sectionIndex ??= 0;
    view.engineReview = { input, run, result, selected: {}, payloads: new Map() };
    view.onChoice = (index) => {
      const label = view.sections[view.sectionIndex].key;
      view.engineReview.selected[label] = index;
      if (label === 'Clients') view.engineReview.selected.ClientInput = 0;
      refresh(view);
      loadClient(view);
      state.offset = 0;
      view.choiceIndex = index;
    };
    view.selectSection = (index) => {
      view.sectionIndex = index;
      state.offset = 0;
      refresh(view);
      loadClient(view);
      const section = view.sections[view.sectionIndex];
      view.choiceIndex =
        section.table?.entries.find(
          (entry) => entry.choiceIndex === view.engineReview.selected[section.key],
        )?.choiceIndex ??
        section.table?.entries[0]?.choiceIndex ??
        null;
    };
    view.consumeChoiceReveal = () => {
      view.choiceIndex = null;
    };
    view.onKey = (key) => {
      const { input, run, selected } = view.engineReview,
        label = view.sections[view.sectionIndex].key;
      const values =
        label === 'Sources'
          ? input
            ? (input.entries ?? [...input.sources, ...input.cases, input.question])
            : []
          : label === 'Openings'
            ? run.openings
            : label === 'Clients'
              ? run.calls
              : label === 'History'
                ? view.engineReview.history
                : null;
      if (!values?.length || !['UP', 'DOWN', 'HOME', 'END'].includes(key)) return false;
      const choices =
        label === 'Openings'
          ? view.sections[view.sectionIndex].table.entries.map((entry) => entry.choiceIndex)
          : values.map((_, index) => index);
      const at = Math.max(0, choices.indexOf(selected[label] ?? choices[0]));
      view.onChoice(
        choices[
          key === 'HOME'
            ? 0
            : key === 'END'
              ? choices.length - 1
              : Math.max(0, Math.min(choices.length - 1, at + (key === 'UP' ? -1 : 1)))
        ],
      );
      return true;
    };
    refresh(view);
    loadClient(view);
    return view;
  }
  function select(run) {
    const identity = key(run);
    if (saved.has(identity)) {
      const view = saved.get(identity);
      const previous = view.engineReview.run;
      view.engineReview.run = run;
      if (previous.inputRef !== run.inputRef || previous.resultRef !== run.resultRef)
        loadSnapshot(view, state.project, run);
      if (earlier(run) && !historical(run)) checkCurrent(view);
      const check = activity();
      clientStatus(check ? check.run : run);
      refresh(view);
      loadClient(view);
      return view;
    }
    const project = state.project,
      view = configure({ title: 'Question result' }, run);
    saved.set(identity, view);
    loadSnapshot(view, project, run);
    if (earlier(run) && !historical(run)) checkCurrent(view);
    const check = activity();
    clientStatus(check ? check.run : run);
    return view;
  }
  function checkCurrent(view) {
    const project = state.project;
    if (view.currentCheck?.revision === project.digest) return;
    view.currentCheck?.controller.abort();
    const check = (view.currentCheck = {
      revision: project.digest,
      controller: new AbortController(),
      progress: 'Load the current corpus',
    });
    const { signal } = check.controller;
    const previous = view.engineReview.run;
    track(
      (async () => {
        try {
          const retained = await readEngineArtifact(project, previous.inputRef);
          signal.throwIfAborted();
          const input = await inputFromProject(project, {
            scopePlacementId: previous.scopePlacementId,
            question: previous.questions[0].text,
            caseSelection: retained.caseSelection,
          });
          signal.throwIfAborted();
          await runEngine(project, {
            input,
            signal,
            trace: previous.policy?.search !== 'HRG query derivations',
            actor: config.actor ?? 'participant',
            via: 'workbench',
            purpose: 'question-refresh',
            onUpdate(run) {
              if (signal.aborted || view.currentCheck !== check) return;
              check.run = run;
              check.progress = run.stages.at(-1)?.label ?? 'Check the current corpus';
              if (visible(view)) draw();
            },
          });
          signal.throwIfAborted();
          // A concurrent corpus edit invalidates this check as well. Reload the
          // current snapshot before selection starts its replacement check.
          const current = await openProject(dirname(project.path));
          signal.throwIfAborted();
          if (state.project.path !== project.path) return;
          if (state.project.digest === project.digest) state.project = current;
          await projects.refreshOutline();
        } catch (error) {
          if (!signal.aborted) check.error = error.message;
        } finally {
          check.finished = true;
        }
        if (!state.closed && !signal.aborted && state.project.path === project.path) draw();
      })(),
    );
  }
  function loadSnapshot(view, project, run) {
    const snapshot = (view.snapshot = `${run.inputRef}:${run.resultRef ?? ''}`);
    track(
      (async () => {
        try {
          const [input, result] = await Promise.all([
            readEngineArtifact(project, run.inputRef),
            run.resultRef ? readEngineArtifact(project, run.resultRef) : null,
          ]);
          if (view.snapshot !== snapshot) return;
          view.engineReview.input = input;
          view.engineReview.result = result;
          view.error = '';
        } catch (error) {
          if (view.snapshot !== snapshot) return;
          view.error = error.message;
        }
        if (visible(view)) {
          refresh(view);
          draw();
        }
      })(),
    );
  }
  async function open(runId) {
    const run = await readEngineRun(state.project, runId);
    state.projectReadingRunId = run.id;
    state.projectReadingTab = null;
    state.offset = 0;
    state.focus = 'reading';
    const view = select(run);
    view.selectSection(0);
  }
  const command = (key, description, run, pane = 'reading') => ({
    key,
    description,
    run,
    pane,
    ...(['d', 'a', 'e'].includes(key) ? { presentation: 'workspace' } : {}),
  });
  function confirmDelete(run, all = false) {
    const project = state.project;
    forms.startForm(all ? 'Reset engine data' : 'Delete engine run', [], async () => {
      const result = await deleteEngineRuns(project, all ? { all: true } : { ids: [run.id] });
      forms.cancelForm();
      state.form = null;
      for (const id of result.deleted) saved.delete(`${project.path}:${id}`);
      if (all) saved.clear();
      Object.assign(state, {
        mode: 'project',
        ix: null,
        activeRecordingPath: null,
        recordingReturn: null,
        historyReturn: null,
        askReturn: null,
        investigation: null,
        investigationReturn: false,
        answerKnowledge: null,
        interpretationDecisions: [],
        projectTreeReturn: null,
        projectPanel: 'development',
        recordingsOffset: 0,
        recordingIndex: 0,
        developmentOffset: 0,
        offset: 0,
      });
      state.recordings = await listProjectRecordings(project);
      await projects.refreshOutline();
      const items = state.projectDevelopmentOutline();
      const next = items.find((item) => item.id === state.projectEntryId) ?? items[0];
      state.selectProjectEntry(next?.id ?? state.placementId);
      if (!next) {
        state.focus = 'nodes';
        state.projectReadingOrigin = 'nodes';
      }
      for (const client of ['egemma', 'penman', 'semcat', 'language'])
        state.serviceStatus[client] = 'idle';
      setNotice(all ? 'Engine data reset' : 'Engine run deleted');
    });
    state.form.confirm = true;
    state.form.yesNo = { yes: false };
    state.form.inspectRows = all
      ? [
          ['Project', project.data.name],
          ['Delete', 'All engine runs, AMRs, recordings and inquiry history'],
          ['Keep', 'Concepts, sentences, corpus contributions and their readings'],
        ]
      : [
          ['Question', run.questions?.[0]?.text ?? run.id],
          ['Delete', 'This run, its recording and unshared cached data'],
          ['Keep', 'Question as a draft; other runs and their data'],
        ];
  }
  const deletionActions = (run, pane) => [
    ...(run.status !== 'running'
      ? [command('x', 'delete run', () => confirmDelete(run), pane)]
      : []),
    command('X', 'reset engine data', () => confirmDelete(run, true), pane),
  ];
  function actions() {
    if (state.help || state.quitPrompt) return [];
    const view = readingView();
    if (view && !state.projectReadingTab) {
      const tab = view.sections[view.sectionIndex].key;
      const turn = (delta) =>
        view.selectSection(
          (view.sectionIndex + delta + view.sections.length) % view.sections.length,
        );
      const review = view.engineReview,
        call = tab === 'Clients' && review.run.calls[review.selected.Clients ?? 0];
      const payload = call && review.payloads.get(call.id),
        count = payload?.request?.items.length ?? 0;
      const moveInput = (delta) => {
        review.selected.ClientInput = Math.max(
          0,
          Math.min(count - 1, (review.selected.ClientInput ?? 0) + delta),
        );
        refresh(view);
      };
      const question = review.input?.question?.text ?? review.run.questions?.[0]?.text ?? '';
      const questionEntry = state
        .projectDevelopmentOutline()
        .find((item) => item.runs?.some((run) => run.id === review.run.id));
      const authored = questionEntry?.kind === 'corpus-contribution';
      const savedAssessment = historical(review.run);
      const checking = earlier(review.run) && !savedAssessment;
      const clarifiable =
        review.run.status === 'open' &&
        !review.run.semantic &&
        review.run.projectDigest === state.project.digest &&
        review.run.answer?.clarifications?.length;
      const partial =
        !authored &&
        !clarifiable &&
        !review.run.semantic &&
        review.run.projectDigest === state.project.digest &&
        review.run.answer?.partial?.parts?.length;
      return [
        ...((savedAssessment || checking) && ['Outcome', 'Openings'].includes(tab)
          ? ['reading', 'development'].flatMap((pane) => [
              command(
                'd',
                savedAssessment ? 'current result' : 'checking corpus',
                () => {
                  if (savedAssessment) {
                    state.projectReadingRunId = null;
                    state.offset = 0;
                    const current = selectedRun();
                    if (current) select(current).selectSection(0);
                    draw();
                  } else setNotice('Checking the current corpus before developing this question');
                },
                pane,
              ),
              ...(checking && view.currentCheck?.error
                ? [
                    command(
                      'r',
                      'retry check',
                      () => {
                        view.currentCheck = null;
                        checkCurrent(view);
                        draw();
                      },
                      pane,
                    ),
                  ]
                : []),
            ])
          : []),
        ...(!savedAssessment &&
        !checking &&
        (!authored || clarifiable) &&
        ['Outcome', 'Openings'].includes(tab)
          ? ['reading', 'development'].flatMap((pane) =>
              [
                command(
                  'd',
                  partial
                    ? 'retain partial answer'
                    : clarifiable
                      ? 'clarify connection'
                      : 'develop question',
                  () =>
                    partial
                      ? state.retainPartial({
                          run: review.run,
                          input: review.input,
                          result: review.result,
                        })
                      : clarifiable
                        ? state.clarifyConnection({ run: review.run, input: review.input })
                        : state.developQuestion({
                            question,
                            contributionIds: review.run.openings
                              .filter((o) => o.kind === 'aporia')
                              .map((o) => o.contributionId),
                          }),
                  pane,
                ),
                command(
                  'a',
                  'ask corpus',
                  () =>
                    state.startAsk({
                      fresh: true,
                      question: ['supported', 'conditional'].includes(review.run.status)
                        ? ''
                        : question,
                      ...(!['supported', 'conditional'].includes(review.run.status)
                        ? { caseSelection: review.input?.caseSelection }
                        : {}),
                    }),
                  pane,
                ),
                command(
                  'e',
                  'edit question',
                  () =>
                    state.startAsk({
                      fresh: true,
                      question,
                      caseSelection: review.input?.caseSelection,
                    }),
                  pane,
                ),
              ].filter((action) => !authored || action.key === 'd'),
            )
          : []),
        ...(tab === 'Trace' ? deletionActions(review.run, 'reading') : []),
        ...(tab === 'History'
          ? [
              command('ENTER', 'open saved result', () =>
                open(review.history[review.selected.History ?? 0].id),
              ),
            ]
          : []),
        { ...command('LEFT', 'previous tab', () => turn(-1)), presentation: 'choice' },
        { ...command('RIGHT', 'next tab', () => turn(1)), presentation: 'choice' },
        ...(['Sources', 'Clients', 'Openings', 'History'].includes(tab)
          ? ['UP', 'DOWN', 'HOME', 'END'].map((key) => ({
              ...command(
                key,
                { UP: 'previous item', DOWN: 'next item', HOME: 'first item', END: 'last item' }[
                  key
                ],
                () => view.onKey(key),
              ),
              presentation: 'choice',
            }))
          : []),
        ...(count > 1
          ? [
              command('[', call.client === 'SEMCAT' ? 'previous pair' : 'previous graph', () =>
                moveInput(-1),
              ),
              command(']', call.client === 'SEMCAT' ? 'next pair' : 'next graph', () =>
                moveInput(1),
              ),
            ]
          : []),
      ];
    }
    if (
      !state.form &&
      state.mode === 'recording' &&
      state.ix.recording.reasoning &&
      state.project &&
      ['overview', 'provenance'].includes(state.page)
    )
      return [
        command('x', 'delete run', async () =>
          confirmDelete(await readEngineRun(state.project, state.ix.recording.reasoning.runId)),
        ),
        command('X', 'reset engine data', () => confirmDelete(null, true)),
      ];
    return [];
  }
  return {
    open,
    actions,
    select,
    readingView,
    activity,
    syncSelection() {
      const run = selectedRun();
      for (const [identity, view] of saved) {
        if (view.currentCheck && (!run || identity !== key(run))) {
          view.currentCheck.controller.abort();
          view.currentCheck = null;
        }
      }
      if (run) select(run);
    },
    idle: async () => {
      while (pending.size) await Promise.all([...pending]);
    },
    cancel: async () => {
      for (const view of saved.values()) view.currentCheck?.controller.abort();
      saved.clear();
    },
  };
}
