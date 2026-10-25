import { readSavedRecording } from '../../project/storage/recordings.mjs';
/** Investigation actions own authored state; Ask selects the inquiry scope. */
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openProject, projectTree } from '../../project/authoring/project.mjs';
import { captureProjectInquiry } from '../../project/inquiries/inquiry.mjs';
import { listProjectRecordings } from '../../project/inquiries/recordings.mjs';
import {
  newInvestigation,
  addAsk,
  currentAsk,
  selectCase,
  authorCase,
  readInvestigation,
  listInvestigations,
  saveInvestigation,
  reviseIntention,
  assessInvestigation,
  textDigest,
  followupFor,
} from '../../project/inquiries/investigation.mjs';
import {
  buildInquiryFrame,
  currentFrameContext,
  draftContinuationFrame,
  finalizeAskFrame,
  purposeOnlyCarry,
  refreshAskFrame,
} from '../../project/inquiries/frame.mjs';

import { interpretationRevision } from '../../recording/revisions.mjs';
import {
  loadInterpretationDecisions,
  activeInterpretations,
  acceptedCaseReference,
} from '../../recording/interpretation.mjs';
import {
  indexRecording,
  initialSelection,
  rankedFindings,
  selectedMaterial,
} from '../recordings/view.mjs';
import { caseName, relationReading } from '../shell/wording.mjs';
import {
  authoredContinuation,
  evidenceOpenings,
  continuationContext,
  continuationOpenings,
} from '../../recording/continuation.mjs';
import { readContinuationDraft } from '../../project/inquiries/continuation.mjs';
import { inquiryGroups, currentRun, inquiryAttempts } from './inquiry-groups.mjs';
import { placementLabel } from '../concepts/placement-label.mjs';
import { evaluateAnswer } from '../../recording/answers.mjs';
import { knowledgeSnapshot } from '../../project/authoring/knowledge.mjs';
import { sourceCatalog, scopedSources } from '../../project/authoring/sources.mjs';
import { carryStatusLabel, frameLineageRows } from '../../recording/frame.mjs';

const lineageForAsk = (ask) =>
  ask?.carry
    ? {
        originFrame: ask.carry.origin,
        frame: ask.carry.receiving,
        carry: ask.carry,
        opening: ask.originOpening ?? ask.continuation?.originOpening ?? ask.carry.origin.opening,
      }
    : ask?.continuation?.carry
      ? ask.continuation
      : null;

const caseRoles = new WeakMap();
function hasCaseSources(data, placementId) {
  if (!caseRoles.has(data))
    caseRoles.set(
      data,
      new Set(
        sourceCatalog(data)
          .filter((s) => s.development?.asserted !== false)
          .map((s) => s.nodeId),
      ),
    );
  return caseRoles.get(data).has(placementId);
}
import { isContextualSource } from '../../recording/case-sources.mjs';

export function createInvestigation({
  state,
  config,
  forms,
  projects,
  navigation,
  draw,
  setNotice,
}) {
  const command = (pane, key, description, run) => ({ pane, key, description, run });
  const assessmentLabels = {
    selected: 'Candidate selected',
    open: 'Kept open',
    revoked: 'Assessment revoked',
  };
  const origin = () => {
    if (state.mode !== 'recording' && !state.ix?.recording) return null;
    const opening =
      state.page === 'scope'
        ? evidenceOpenings(state.ix, state.selection, state.interpretationDecisions)[
            state.openingIndex ?? 0
          ]
        : null;
    return {
      path: state.activeRecordingPath ?? state.ix?.recording?.reasoning?.path ?? null,
      recordingRevision: interpretationRevision(state.ix.recording),
      nodeId: state.selection.nodeId,
      occurrenceId: state.selection.occurrenceId,
      sourceId:
        opening?.sourceId ??
        state.ix.occurrences.get(state.selection.occurrenceId)?.sourceId ??
        null,
      askId: state.ix.recording.ask?.askId ?? null,
      ...(opening ? { opening } : {}),
    };
  };
  function contextRows(reference = origin()) {
    const ask = state.investigation?.data.asks.find((item) => item.id === reference?.askId);
    const question = !reference?.path ? ask?.question : undefined;
    if (!reference?.path && ask?.origin) reference = ask.origin;
    const ix = reference?.path === state.activeRecordingPath ? state.ix : null;
    const source = ix?.sources.get(reference.sourceId),
      opening = reference?.opening;
    const graph =
      opening?.edge &&
      ix?.graphs.get(opening.kind === 'query' ? ix.recording.inquiry.graphId : source?.graphId);
    return [
      [
        'Question',
        question ?? ix?.recording.inquiry.text ?? currentAsk(state.investigation?.data)?.question,
        'input',
      ],
      ['Candidate', ix?.nodes.get(reference?.nodeId)?.label],
      ['Source', source?.text, 'input'],
      [
        'Opening',
        graph
          ? relationReading(
              graph,
              opening.edge,
              opening.kind === 'query' ? ix.recording.inquiry.text : source.text,
            ).label
          : opening?.label,
      ],
    ].filter(([, value]) => value);
  }
  let writes = Promise.resolve();
  function persist(update = null) {
    const project = state.project,
      id = state.investigation.data.id;
    const next = writes.then(async () => {
      const current =
        state.investigation?.data.id === id
          ? state.investigation
          : await readInvestigation(project, id);
      const data =
        typeof update === 'function'
          ? update(structuredClone(current.data))
          : (update ?? current.data);
      const saved = await saveInvestigation(project, data, current.digest ?? null);
      if (state.investigation?.data.id === id) state.investigation = saved;
      await state.workflow?.refreshQuestions();
      return saved;
    });
    writes = next.catch(() => {});
    return next;
  }
  function picker(title, choices, choose, returnForm = state.form) {
    if (!choices.length) {
      setNotice(`${title} 0`);
      return;
    }
    forms.startForm(
      title,
      [],
      async () => {
        const step = state.form,
          back = { form: step, focus: state.focus, offset: state.offset };
        const ancestors = new Set(),
          pending = [step];
        while (pending.length) {
          const form = pending.pop();
          if (!form || ancestors.has(form)) continue;
          ancestors.add(form);
          pending.push(form.back?.form, form.returnForm);
        }
        const choice = step.move[step.index];
        if (!choice) return;
        forms.cancelForm();
        const completed = state.form;
        try {
          await choose(choice, back);
        } catch (error) {
          Object.assign(state, back);
          throw error;
        }
        if (state.form && state.form !== completed && !ancestors.has(state.form))
          state.form.back = back;
      },
      { submitLabel: 'select' },
    );
    state.form.move = choices;
    state.form.moveLabel = 'selection';
    state.form.returnForm = returnForm;
  }
  async function ensureProject() {
    const reference = state.ix?.recording.project;
    if (!state.project && reference) state.project = await openProject(dirname(reference.path));
    if (
      !state.project ||
      (state.mode === 'recording' && reference && state.project.data.id !== reference.id)
    )
      throw new Error('Project unavailable');
  }
  function recordedCase() {
    const recording = state.ix?.recording,
      root = state.ix?.nodes.get(recording?.caseState?.rootNodeId);
    if (!root) return null;
    let selected = structuredClone(recording.caseState.selection ?? null);
    if (!selected) {
      const conceptId =
        state.project.data.placements.find((item) => item.id === root.id)?.conceptId ??
        (recording.project.placementId === root.id ? recording.project.conceptId : null);
      if (!conceptId) return null;
      const sources = root.sourceIds.map((id, index) => ({
        projectId: state.project.data.id,
        placementId: root.id,
        conceptId,
        index,
        text: state.ix.sources.get(id).text,
        textDigest: textDigest(state.ix.sources.get(id).text),
        revision: recording.project.digest,
      }));
      selected = {
        id: randomUUID(),
        projectId: state.project.data.id,
        placementId: root.id,
        conceptId,
        label: root.label,
        revision: recording.project.digest,
        sources,
        availableSources: sources,
        binding: null,
      };
    }
    const reference = acceptedCaseReference(state.ix, state.interpretationDecisions);
    if (reference)
      selected.binding = { ...reference, questionDigest: textDigest(recording.inquiry.text) };
    return selected;
  }
  async function attach() {
    await ensureProject();
    if (!state.investigation && state.mode === 'project') {
      const saved = (await listInvestigations(state.project)).find(
        (entry) => currentAsk(entry.data)?.scopePlacementId === state.placementId,
      );
      if (saved) state.investigation = saved;
    }
    const link = state.mode === 'recording' ? state.ix?.recording.ask : null;
    if (link && state.investigation?.data.id !== link.investigationId) {
      try {
        state.investigation = await readInvestigation(state.project, link.investigationId);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state.investigation = null;
      }
    }
    if (
      !link &&
      state.mode === 'recording' &&
      state.investigation &&
      !state.investigation.data.asks.some(
        (ask) =>
          ask.origin?.path === state.activeRecordingPath ||
          ask.runs.some((run) => run.path === state.activeRecordingPath),
      )
    )
      state.investigation = null;
    if (!state.investigation || state.investigation.data.projectId !== state.project.data.id) {
      const question = state.mode === 'recording' ? state.ix.recording.inquiry.text : '';
      let data = newInvestigation(state.project, question);
      const placementId =
        state.mode === 'recording'
          ? (state.ix?.recording.project?.placementId ?? state.placementId)
          : state.placementId;
      data = addAsk(data, {
        question,
        scopePlacementId: placementId,
        origin: origin(),
        caseSelection: state.mode === 'recording' ? recordedCase() : null,
      });
      if (state.mode === 'recording') {
        currentAsk(data).runs.push({
          ...origin(),
          question,
          projectDigest: state.ix.recording.project.digest,
          revision: 0,
        });
        currentAsk(data).status = 'complete';
      }
      state.investigation = { data, digest: null };
      await persist();
    }
    if (state.mode === 'recording') {
      const ask = state.investigation.data.asks.find(
        (item) =>
          item.id === link?.askId ||
          item.runs.some((run) => run.path === state.activeRecordingPath),
      );
      if (ask && currentAsk(state.investigation.data)?.id !== ask.id)
        await persist((data) => ({ ...data, activeAskId: ask.id }));
    }
    return state.investigation;
  }
  async function saveDraft(active = state.form) {
    if (!active?.workspace || !state.investigation) return;
    const data = structuredClone(state.investigation.data),
      ask = data.asks.find((item) => item.id === active.askId);
    if (!ask) throw new Error('Ask unavailable');
    const question = active.fields[0].value;
    if (ask.question !== question && ask.caseSelection?.binding) ask.caseSelection.binding = null;
    Object.assign(ask, {
      question,
      cursor: active.fields[0].cursor,
      scopePlacementId: state.placementId,
      caseSelection: structuredClone(active.caseSelection),
      status: active.busy ? 'running' : 'draft',
    });
    if (ask.caseSelection?.binding?.questionDigest !== textDigest(question) && ask.caseSelection)
      ask.caseSelection.binding = null;
    if (data.intentions.length === 1 && data.asks.length === 1 && !ask.runs.length)
      data.intentions[0].text = question;
    if (!ask.checkedFrame) {
      const intention = data.intentions.find((item) => item.id === ask.intentionId) ?? null;
      ask.frame = refreshAskFrame(state.project, { ...ask, intention });
    }
    data.activeAskId = ask.id;
    await persist(data);
    active.draftStatus = 'Saved';
  }
  async function chooseScope() {
    const active = state.form;
    await saveDraft(active);
    const choices = projectTree(state.project.data).map(({ placement }) => ({
      id: placement.id,
      label: placementLabel(state.project.data, placement.id),
    }));
    picker(
      'Scope',
      choices,
      async ({ id }) => {
        state.placementId = id;
        await saveDraft(active);
      },
      active,
    );
    state.form.index = Math.max(
      0,
      choices.findIndex((choice) => choice.id === state.placementId),
    );
  }
  function writeCase(active) {
    const previous = active.caseSelection?.kind === 'authored' ? active.caseSelection : null;
    forms.startForm(
      previous ? 'Edit case' : 'Write a case',
      [['Case', previous?.sources.map((source) => source.text).join(' ') ?? '', true]],
      async ([text]) => {
        active.caseSelection = authorCase(state.project, text, previous);
        await saveDraft(active);
        state.form = active;
        state.focus = 'reading';
        state.offset = 0;
        setNotice('Case saved with this question');
      },
      { submitLabel: 'use case' },
    );
    state.form.returnForm = active;
    state.form.contextRows = [
      ['Question', active.fields[0].value, 'input'],
      ['Saved with', 'This question'],
      ['Corpus', 'Case text does not add source statements'],
    ];
  }
  async function chooseCase() {
    const active = state.form;
    await saveDraft(active);
    const available = new Map(),
      scopes = scopedSources(state.project.data);
    for (const source of sourceCatalog(state.project.data)) {
      if (source.development?.asserted === false || isContextualSource(source, scopes)) continue;
      if (!available.has(source.nodeId)) available.set(source.nodeId, []);
      available.get(source.nodeId).push(source.text);
    }
    const retained = active.caseSelection;
    if (retained)
      available.set(
        retained.placementId,
        retained.sources.map((source) => source.text),
      );
    const choices = [
      { id: null, label: 'No case', texts: [] },
      {
        id: 'write-case',
        label: retained?.kind === 'authored' ? 'Edit case' : 'Write a case',
        texts: [],
      },
      ...projectTree(state.project.data)
        .filter(({ placement }) => available.has(placement.id))
        .map(({ placement }) => ({
          id: placement.id,
          label: placementLabel(state.project.data, placement.id),
          texts: available.get(placement.id),
        })),
      ...(retained &&
      !state.project.data.placements.some((item) => item.id === retained.placementId)
        ? [
            {
              id: retained.placementId,
              label: caseName(retained) + ' (saved case)',
              texts: available.get(retained.placementId),
            },
          ]
        : []),
    ];
    picker(
      'Case',
      choices,
      async ({ id }) => {
        if (id === 'write-case') return writeCase(active);
        if (id !== (active.caseSelection?.placementId ?? null))
          active.caseSelection = id
            ? id === retained?.placementId
              ? retained
              : selectCase(state.project, id)
            : null;
        await saveDraft(active);
      },
      active,
    );
    const selection = state.form;
    selection.index = Math.max(
      0,
      choices.findIndex((choice) => choice.id === (active.caseSelection?.placementId ?? null)),
    );
    selection.contextDetails = () => [
      ['Scope', placementLabel(state.project.data, state.placementId)],
      ...(selection.move[selection.index].texts.length
        ? selection.move[selection.index].texts.map((text) => ['Case sentence', text, 'input'])
        : [
            [
              'Case',
              selection.move[selection.index].id === 'write-case'
                ? 'Independent situation, saved with this question.'
                : 'None; use the corpus without an independent case.',
            ],
          ]),
    ];
  }
  async function startAsk(options = {}) {
    await ensureProject();
    if (!options.fresh && !state.investigation && state.mode === 'project') await attach();
    if (
      options.fresh ||
      !state.investigation ||
      state.investigation.data.projectId !== state.project.data.id
    ) {
      state.investigation = {
        data: newInvestigation(state.project, options.question ?? ''),
        digest: null,
      };
      state.investigation.data = addAsk(state.investigation.data, {
        question: options.question ?? '',
        scopePlacementId: options.scopePlacementId ?? state.placementId,
        caseSelection: options.caseSelection ?? null,
      });
      const ask = currentAsk(state.investigation.data);
      ask.frame = buildInquiryFrame(state.project, {
        question: ask.question,
        intention: state.investigation.data.intentions.at(-1),
        scopePlacementId: ask.scopePlacementId,
        caseSelection: ask.caseSelection,
      });
    }
    if (options.followup || options.continuation) {
      const previous = currentAsk(state.investigation.data);
      const caseSelection = options.caseSelection ?? previous?.caseSelection ?? null;
      const continuation = options.continuation ?? null;
      const data = addAsk(state.investigation.data, {
        question: options.question ?? '',
        scopePlacementId:
          options.scopePlacementId ?? previous?.scopePlacementId ?? state.placementId,
        caseSelection,
        origin: options.origin ?? origin(),
        continuation,
      });
      const ask = currentAsk(data);
      if (continuation) {
        const optionData = draftContinuationFrame(state.project, continuation, {
          ...ask,
          intention: data.intentions.find((item) => item.id === ask.intentionId),
        });
        ask.continuation = optionData;
        ask.frame = optionData.frame;
        ask.carry = optionData.carry;
      } else {
        ask.frame = buildInquiryFrame(state.project, {
          question: ask.question,
          intention: data.intentions.find((item) => item.id === ask.intentionId),
          scopePlacementId: ask.scopePlacementId,
          caseSelection: ask.caseSelection,
        });
      }
      await persist(data);
    }
    const ask = currentAsk(state.investigation.data);
    if (!state.project.data.placements.some((item) => item.id === ask.scopePlacementId))
      throw new Error('Scope unavailable');
    state.placementId = ask.scopePlacementId;
    state.mode = 'project';
    state.investigationReturn = false;
    const returnTo = options.returnTo ?? null;
    forms.startForm(
      'Ask',
      [['Question', ask.question, true]],
      async ([query]) => {
        const active = state.form;
        await saveDraft(active);
        const project = state.project;
        const submitted = structuredClone(state.investigation.data),
          revision = currentAsk(submitted);
        const disk = await openProject(dirname(project.path));
        if (disk.digest !== project.digest)
          throw Object.assign(new Error('Project changed'), { code: 'PROJECT_CHANGED' });
        const draft = currentAsk(state.investigation.data);
        const draftIntention = submitted.intentions.find((item) => item.id === draft.intentionId);
        draft.intention = structuredClone(draftIntention);
        if (draft.origin?.path) {
          const parent = indexRecording(await readSavedRecording(draft.origin.path));
          if (interpretationRevision(parent.recording) !== draft.origin.recordingRevision)
            throw new Error('Parent changed');
          if (draft.continuation?.assumption) {
            const decisions = await loadInterpretationDecisions(draft.origin.path, parent);
            if (
              !activeInterpretations(decisions).some(
                (item) => item.id === draft.continuation.assumption.decisionId,
              )
            )
              throw new Error('Interpretation changed');
          }
        }
        revision.revision++;
        revision.status = 'running';
        await persist(submitted);
        const link = {
          investigationId: submitted.id,
          askId: revision.id,
          revision: revision.revision,
          intention: structuredClone(draftIntention),
          question: query,
          origin: revision.origin,
        };
        const controller = (active.controller = new AbortController());
        active.busy = true;
        active.engineInquiry = true;
        active.error = '';
        active.recovery = null;
        for (const client of ['egemma', 'penman', 'semcat']) state.serviceStatus[client] = 'idle';
        const continuationIntention = submitted.intentions.find(
          (item) => item.id === revision.intentionId,
        );
        const continuation = revision.continuation
          ? draftContinuationFrame(project, revision.continuation, {
              ...revision,
              question: query,
              intention: continuationIntention,
            })
          : null;
        if (continuation) {
          // The submitted draft may already carry the origin selected before the form opened.
          const originOpening =
            revision.originOpening ??
            draft.originOpening ??
            continuation.originOpening ??
            continuation.opening;
          revision.originOpening = originOpening;
          draft.originOpening = originOpening;
          revision.retainedOpening =
            revision.retainedOpening ?? continuation.retainedOpening ?? continuation.opening;
          revision.carry = continuation.carry;
          revision.frame = continuation.frame;
          revision.continuation = continuation;
          revision.intention = structuredClone(continuationIntention);
        }
        const submittedInvestigationId = submitted.id;
        active.execution = (config.captureInquiry ?? captureProjectInquiry)(
          project,
          revision.scopePlacementId,
          query,
          (message) => {
            if (state.form === active && !controller.signal.aborted) {
              active.progress = message;
              draw();
            }
          },
          controller.signal,
          {
            actor: config.actor ?? 'participant',
            via: 'workbench',
            caseSelection: revision.caseSelection,
            ask: link,
            ...(continuation ? { continuation } : {}),
            onEngineUpdate(run) {
              if (active.controller !== controller) return;
              active.engineRunId = run.id;
              if (state.project?.data.id !== project.data.id) return;
              for (const [client, service] of [
                ['AMR', 'egemma'],
                ['PENMAN', 'penman'],
                ['SEMCAT', 'semcat'],
              ]) {
                state.serviceStatus[service] =
                  run.calls.filter((call) => call.client === client).at(-1)?.status ?? 'idle';
              }
            },
          },
        )
          .then(async ({ recording, path }) => {
            if (controller.signal.aborted) return;
            const update = (next) => {
              const item = next.asks.find((entry) => entry.id === revision.id);
              item.status = 'complete';
              // Rechecking unchanged authored wording replaces its prior assessment.
              item.runs = item.runs.filter((run) => run.revision !== revision.revision);
              item.runs.push({
                path,
                recordingRevision: interpretationRevision(recording),
                revision: revision.revision,
                intentionId: revision.intentionId,
                question: query,
                scopePlacementId: revision.scopePlacementId,
                projectDigest: project.digest,
                caseSelection: revision.caseSelection,
                ...(recording.reasoning ? { engineRunId: recording.reasoning.runId } : {}),
              });
              const settled = finalizeAskFrame(
                project,
                {
                  ...item,
                  intention: submitted.intentions.find((entry) => entry.id === item.intentionId),
                  origin:
                    item.origin ??
                    (item.continuation?.parent
                      ? {
                          path: item.continuation.parent.path,
                          recordingRevision: item.continuation.parent.revision,
                        }
                      : null),
                },
                recording,
              );
              item.frame = settled.frame;
              item.checkedFrame = settled.frame;
              item.carry = settled.carry;
              item.continuation = recording.continuation ?? item.continuation;
              item.runs.at(-1).frame = settled.frame;
              item.runs.at(-1).carry = settled.carry;
              return next;
            };
            if (state.investigation?.data.id === submittedInvestigationId) await persist(update);
            else {
              const saved = await readInvestigation(project, submittedInvestigationId);
              await saveInvestigation(project, update(saved.data), saved.digest);
            }
            if (state.form !== active) return;
            state.ix = indexRecording(recording);
            state.activeRecordingPath = path;
            state.interpretationDecisions = [];
            state.answerKnowledge = null;
            state.selection = { ...initialSelection(state.ix), visitId: null };
            const first = rankedFindings(state.ix)[0];
            if (first)
              state.selection = { nodeId: first.nodeId, occurrenceId: first.id, visitId: null };
            state.mode = 'recording';
            state.projectReadingOrigin = 'nodes';
            state.investigationReturn = true;
            navigation.resetView();
            state.focus = 'reading';
            state.askReturn = null;
            state.historyReturn = null;
            state.findingsList = Boolean(first);
            state.recordings = await listProjectRecordings(project);
            await projects.refreshOutline();
            if (recording.reasoning) await state.showEngineResult?.(recording.reasoning.runId);
            setNotice(state.workflow?.active() ? 'Checked' : 'Recorded');
            draw();
          })
          .catch(async (error) => {
            if (controller.signal.aborted) {
              if (state.investigation?.data.id === submittedInvestigationId)
                await persist((next) => {
                  const item = next.asks.find((item) => item.id === revision.id);
                  if (item?.revision === revision.revision && item.status === 'running') {
                    item.status = 'draft';
                    if (error.engineRunId) item.lastEngineRunId = error.engineRunId;
                  }
                  return next;
                });
              return;
            }
            if (state.form !== active || controller.signal.aborted) return;
            active.busy = false;
            active.error = error.message;
            active.recovery = {
              saved: false,
              state: 'Question draft saved; no answer established',
              steps: error.client
                ? `Restore the ${error.client === 'AMR' ? 'eGemma AMR' : error.client} service, then run the saved question again. The failed attempt and its client details remain available in Development.`
                : 'Your question remains editable. Run it again to retry acquisition and checking, or return to the corpus. The failed attempt remains in Development.',
            };
            if (error.engineRunId)
              await persist((next) => {
                const item = currentAsk(next);
                item.lastEngineRunId = error.engineRunId;
                item.status = 'draft';
                return next;
              });
            await saveDraft(active).catch(() => {});
            draw();
          });
      },
      { submitLabel: 'run' },
    );
    Object.assign(state.form, {
      inquiry: true,
      workspace: true,
      askId: ask.id,
      caseSelection: structuredClone(ask.caseSelection),
      continuation: ask.continuation,
      originOpening: ask.originOpening ?? ask.continuation?.originOpening,
      frame: ask.frame,
      carry: ask.carry,
      origin: ask.origin,
      revisesRecording: options.revisesRecording ?? null,
      onProjectReload: () => {
        // The question text and independent case remain authored draft material.
        // Sources and scope now come from the current saved project.
        state.form.contextRows = [];
      },
      onCancel: () => {
        if (returnTo) Object.assign(state, returnTo);
      },
    });
    state.form.contextDetails = () => [
      ['Scope', placementLabel(state.project.data, state.placementId)],
      ...(!state.form.caseSelection ? [['Case', 'None (optional)']] : []),
    ];
    state.form.fields[0].cursor = Math.min(
      ask.cursor ?? Array.from(ask.question).length,
      Array.from(ask.question).length,
    );
    state.form.onKey = async (key) => {
      const action = actions().find((item) => item.pane === state.focus && item.key === key);
      if (action) {
        await action.run();
        return true;
      }
      return false;
    };
    await persist();
  }
  async function editQuestion() {
    const { investigation: _investigation, ...returnTo } = recordingSnapshot();
    const revisesRecording = {
      path: state.activeRecordingPath,
      question: state.ix.recording.inquiry.text,
      frame: buildInquiryFrame(state.project, {
        question: state.ix.recording.inquiry.text,
        questionGraph: state.ix.graphs.get(state.ix.recording.inquiry.graphId),
        intention: state.ix.recording.ask?.intention ?? null,
        scopePlacementId: state.ix.recording.project.placementId,
        caseSelection: state.ix.recording.caseState?.selection ?? null,
      }),
    };
    await attach();
    const data = structuredClone(state.investigation.data),
      ask = currentAsk(data);
    ask.originFrame = revisesRecording.frame;
    ask.continuationAction = 'revise-question';
    ask.continuationRationale =
      'Revise the retained question after reviewing its current support and openings.';
    await persist(data);
    await startAsk({ returnTo, revisesRecording });
  }
  async function followup(opening = null, fresh = false) {
    opening ??=
      state.page === 'scope'
        ? evidenceOpenings(state.ix, state.selection, state.interpretationDecisions)[
            state.openingIndex ?? 0
          ]
        : null;
    const parent = origin(),
      continuation = authoredContinuation(
        state.ix,
        state.selection,
        state.activeRecordingPath,
        opening,
        state.interpretationDecisions,
        {
          action: 'continue-opening',
          rationale: opening
            ? `Continue from the open relation: ${opening.label ?? opening.id}.`
            : 'Continue the retained inquiry with a new question.',
        },
      );
    await attach();
    if (!parent) throw new Error('No retained inquiry origin is available to continue.');
    const existing =
      !fresh && followupFor(state.investigation.data, parent, continuation.opening.id);
    const returnTo = Object.fromEntries(
      [
        'mode',
        'page',
        'pageTrail',
        'focus',
        'offset',
        'nodesOffset',
        'placementId',
        'findingsList',
        'openingIndex',
        'investigationReturn',
      ].map((key) => [key, state[key]]),
    );
    if (existing) {
      await persist((data) => {
        const ask = data.asks.find((item) => item.id === existing.id);
        ask.continuation = continuation;
        return { ...data, activeAskId: existing.id };
      });
      await startAsk({ returnTo });
      return;
    }
    let legacy = null;
    if (opening?.kind === 'query') {
      const occurrence = state.ix.occurrences.get(state.selection.occurrenceId);
      const index = continuationOpenings(
        state.ix,
        occurrence,
        state.interpretationDecisions,
      ).findIndex((item) => item.edge.id === opening.edge.id);
      if (index >= 0)
        legacy = await readContinuationDraft(
          state.project,
          continuationContext(
            state.ix,
            occurrence,
            state.interpretationDecisions,
            state.activeRecordingPath,
            index,
          ),
        );
    }
    const previous = currentAsk(state.investigation.data);
    const caseSelection = previous?.caseSelection ?? recordedCase();
    await startAsk({
      followup: true,
      caseSelection,
      continuation,
      question: legacy?.question ?? '',
      origin: { ...parent, ...(opening ? { opening } : {}) },
      scopePlacementId: legacy?.scopePlacementId ?? state.ix.recording.project.placementId,
      returnTo,
    });
  }
  async function history() {
    if (!state.investigation && !state.ix?.recording.ask) {
      const recording = state.ix.recording;
      picker(
        'History',
        [...(recording.continuation?.history ?? []), { question: recording.inquiry.text }].map(
          (item) => ({ label: item.question, item }),
        ),
        ({ item }) => {
          forms.startForm('Ask', [], () => forms.backForm(), { submitLabel: 'back' });
          state.form.confirm = true;
          state.form.inspectRows = [
            ['Question', item.question, 'input'],
            ...(item.scopeLabel ? [['Scope', item.scopeLabel]] : []),
          ];
        },
      );
      return;
    }
    await attach();
    const data = state.investigation.data;
    picker(
      'History',
      [
        ...data.intentions.map((item) => ({
          label: item.text,
          group: 'Purpose',
          kind: 'intention',
          item,
          details: [['Recorded', [item.at]]],
        })),
        ...data.asks.flatMap((ask) => [
          {
            label: `${ask.status} - ${ask.question}`,
            group: 'Asks',
            kind: 'ask',
            item: ask,
            details: ask.carry
              ? [
                  ...(ask.frame?.intention?.text ? [['Purpose', [ask.frame.intention.text]]] : []),
                  ['Carry', [carryStatusLabel(ask.carry)]],
                ]
              : [],
          },
          ...ask.runs.map((run) => ({
            label: `Run ${run.revision} - ${run.question}`,
            group: 'Runs',
            kind: 'run',
            item: run,
          })),
        ]),
        ...data.assessments.map((item) => ({
          label: `${assessmentLabels[item.action]}${item.note ? ` - ${item.note}` : ''}`,
          group: 'Assessments',
          kind: 'assessment',
          item,
          details: [
            ...(item.evidence[0]?.reading ?? []).map(([label, value]) => [label, [value]]),
            ['Recorded', [item.at]],
          ],
        })),
      ],
      async (choice, back) => {
        if (state.form?.workspace) await saveDraft();
        if (choice.kind === 'ask') {
          forms.startForm('Past question', [], () => forms.backForm(), {
            submitLabel: 'back',
          });
          state.form.inspectRows = [
            ...frameLineageRows(lineageForAsk(choice.item)),
            ...(choice.item.frame?.intention?.text
              ? [['Purpose', choice.item.frame.intention.text]]
              : []),
            ['State', choice.item.status],
          ].filter(([, value]) => value);
          state.form.confirm = true;
        } else if (choice.kind === 'run') {
          const previous = { ...recordingSnapshot(), ...back };
          state.form = null;
          await projects.loadProjectRecording(choice.item.path);
          state.historyReturn = previous;
          const sourceId = previous.ix?.occurrences.get(previous.selection?.occurrenceId)?.sourceId;
          const findings = rankedFindings(state.ix, state.interpretationDecisions);
          const selected =
            findings.find(
              (item) =>
                item.nodeId === previous.selection?.nodeId && item.occurrence.sourceId === sourceId,
            ) ?? findings[0];
          if (selected)
            state.selection = { nodeId: selected.nodeId, occurrenceId: selected.id, visitId: null };
          state.findingsList = Boolean(findings.length);
        } else {
          forms.startForm(choice.kind === 'intention' ? 'Purpose' : 'Assessment', [], () =>
            forms.backForm(),
          );
          state.form.inspectRows =
            choice.kind === 'intention'
              ? [
                  ['Purpose', choice.item.text],
                  ['Recorded', choice.item.at],
                ]
              : [
                  ...(choice.item.evidence[0]?.reading ?? []),
                  ['Assessment', assessmentLabels[choice.item.action]],
                  ['Note', choice.item.note],
                  ['Recorded', choice.item.at],
                ].filter(([, value]) => value);
          state.form.confirm = true;
          state.form.submitLabel = 'back';
        }
      },
    );
  }
  async function reframe() {
    const reference = origin();
    await attach();
    const active = state.form;
    forms.startForm(
      'Purpose',
      [['Purpose', state.investigation.data.intentions.at(-1).text, true]],
      async ([value]) => {
        const next = reviseIntention(state.investigation.data, value, reference);
        const ask = currentAsk(next);
        ask.intentionId = next.intentions.at(-1).id;
        const current = currentFrameContext(state.project, {
          ...ask,
          intention: next.intentions.at(-1),
        });
        const prior = ask.checkedFrame ?? ask.frame ?? current;
        const purpose = purposeOnlyCarry(
          {
            ...ask,
            currentProjectRevision: current.project.revision,
            currentScope: current.scope,
            currentCase: current.case,
            currentSources: current.sources,
          },
          prior,
          next.intentions.at(-1),
          'Changed the purpose of the retained inquiry.',
          current,
        );
        ask.frame = purpose?.frame ?? current;
        if (purpose?.carry) {
          ask.checkedFrame = prior;
          ask.carry = purpose.carry;
          ask.continuationAction = 'revise-purpose';
          ask.continuationRationale = 'Changed the purpose of the retained inquiry.';
          if (active?.workspace) {
            active.frame = ask.frame;
            active.continuation = {
              ...(active.continuation ?? {
                schema: 'tendora.continuation',
                version: 3,
                author: 'participant',
                contextUse: 'review-only',
                question: ask.question,
                scopePlacementId: ask.scopePlacementId,
                parent: { queryGraph: {}, sourceGraph: null },
                opening: { id: 'question', kind: 'question', label: ask.question },
                history: [],
              }),
              ...(prior
                ? {
                    originFrame: prior,
                    frame: ask.frame,
                    carry: purpose.carry,
                    action: 'revise-purpose',
                    rationale: 'Changed the purpose of the retained inquiry.',
                  }
                : {}),
            };
          }
        }
        if (active?.workspace) {
          active.intentionId = ask.intentionId;
          active.frame = ask.frame;
          active.carry = ask.carry;
          active.continuation = ask.continuation ?? active.continuation;
        }
        await persist(next);
        forms.cancelForm();
        if (!active?.workspace) await startAsk();
      },
    );
    state.form.returnForm = active;
    state.form.contextRows = [
      [
        'Question',
        active?.workspace ? active.fields[0].value : currentAsk(state.investigation.data).question,
        'input',
      ],
      ...(currentAsk(state.investigation?.data)?.carry
        ? [['Carry', carryStatusLabel(currentAsk(state.investigation.data).carry)]]
        : []),
    ].filter(([, value]) => value);
  }
  function currentAssessments(reference = origin()) {
    const items = state.investigation?.data.assessments ?? [];
    return items.filter(
      (item) =>
        item.action !== 'revoked' &&
        item.origin.path === reference?.path &&
        item.origin.nodeId === reference?.nodeId &&
        item.origin.occurrenceId === reference?.occurrenceId &&
        !items.some(
          (other) => other.origin?.assessmentId === item.id && other.action === 'revoked',
        ),
    );
  }
  async function assessment() {
    const reference = origin();
    await attach();
    const reading = contextRows(reference);
    const previous = currentAssessments(reference);
    const decisionIds = activeInterpretations(state.interpretationDecisions)
      .map((item) => item.id)
      .sort();
    if (previous.length)
      reading.push([
        'Assessment',
        previous.map((item) => assessmentLabels[item.action]).join(', '),
      ]);
    picker(
      previous.length ? 'Review assessment' : 'Assess',
      [
        ...[
          { label: 'Select candidate', action: 'selected' },
          { label: 'Keep open', action: 'open' },
        ].filter(
          (choice) =>
            !previous.some(
              (item) =>
                item.action === choice.action &&
                JSON.stringify([...(item.evidence[0]?.interpretationDecisionIds ?? [])].sort()) ===
                  JSON.stringify(decisionIds),
            ),
        ),
        ...previous.map((item) => ({
          label: `Revoke - ${assessmentLabels[item.action]}`,
          action: 'revoked',
          assessmentId: item.id,
          details: [['Recorded', [item.at]], ...(item.note ? [['Note', [item.note]]] : [])],
        })),
      ],
      (choice) => {
        forms.startForm(choice.label, [['Note', '', true, false]], async ([note]) => {
          await persist(
            assessInvestigation(state.investigation.data, {
              action: choice.action,
              origin: {
                ...reference,
                ...(choice.assessmentId ? { assessmentId: choice.assessmentId } : {}),
              },
              evidence: [
                {
                  ...reference,
                  reading,
                  interpretationDecisionIds: activeInterpretations(
                    state.interpretationDecisions,
                  ).map((item) => item.id),
                },
              ],
              note,
            }),
          );
          forms.cancelForm();
          setNotice('Recorded');
        });
        state.form.contextRows = reading;
      },
    );
    state.form.contextRows = reading;
  }

  function recordingSnapshot() {
    return Object.fromEntries(
      [
        'mode',
        'page',
        'pageTrail',
        'focus',
        'offset',
        'nodesOffset',
        'placementId',
        'selection',
        'ix',
        'activeRecordingPath',
        'findingsList',
        'openingIndex',
        'investigationReturn',
        'form',
        'interpretationDecisions',
        'investigation',
        'recordingIndex',
        'expandReading',
        'historyReturn',
        'askReturn',
      ].map((key) => [key, state[key]]),
    );
  }

  async function chooseInvestigation() {
    const entries = await listInvestigations(state.project);
    const scopeLabel = (id) => placementLabel(state.project.data, id);
    const choices = inquiryGroups(entries, state.placementId);
    if (!choices.length) return;
    forms.startForm(`Inquiries - ${scopeLabel(state.placementId)}`, [], () =>
      activateInquiry(state.form.move[state.form.index]),
    );
    const form = state.form;
    form.move = choices;
    form.investigationBrowser = true;
    form.onSelect = async () => {
      const choice = form.move[form.index],
        { ask, entry } = choice,
        run = currentRun(ask);
      form.submitLabel = run ? 'open findings' : 'resume draft';
      form.browserRows = [
        ['Inquiry', ask.question, 'input'],
        ['Scope', scopeLabel(ask.scopePlacementId)],
        ...(ask.caseSelection ? [['Case', caseName(ask.caseSelection)]] : []),
      ];
      form.browserOpenings = [];
      if (run) {
        try {
          const recording = await readSavedRecording(run.path);
          const result = evaluateAnswer(recording, knowledgeSnapshot(state.project.data));
          form.browserRows.push(
            ['Result', result.status],
            ...result.answers.map((answer) => ['Answer', answer.text, 'input']),
            ...result.answers.flatMap((answer) =>
              (answer.dependsOn ?? answer.qualifications).map((value) => ['Qualification', value]),
            ),
          );
          const graph = recording.graphs.find((graph) => graph.id === recording.inquiry.graphId);
          form.browserOpenings = (result.openings ?? []).map((opening) => {
            const edge = graph.edges.find((edge) => edge.id === opening.id);
            return edge
              ? relationReading(graph, edge, ask.question).label
              : (opening.concept ?? `${opening.from} ${opening.role} → ${opening.to}`);
          });
          if (recording.project.digest !== state.project.digest)
            form.browserRows.push(
              ['Acquisition', 'Earlier corpus revision'],
              ['Evaluation', 'Current corpus'],
            );
        } catch (error) {
          form.browserRows.push(['Unavailable', error.message, 'warning']);
        }
      } else form.browserRows.push(['State', 'Draft']);
      form.browserChanges = entry.data.proposals
        .filter((proposal) => proposal.status === 'proposed')
        .map((proposal) => proposal.text);
    };
    await form.onSelect();
    state.focus = 'nodes';
  }
  async function activateInquiry({ entry, ask, run = currentRun(ask) }, edit = false) {
    const previous = recordingSnapshot();
    if (run && !edit) {
      state.form = null;
      await projects.loadProjectRecording(run.path);
      state.historyReturn = previous;
    } else {
      state.investigation = await readInvestigation(state.project, entry.data.id);
      if (state.investigation.data.activeAskId !== ask.id)
        await persist((data) => ({ ...data, activeAskId: ask.id }));
      await startAsk();
    }
  }
  function inquiryHistory(browser) {
    const choice = browser.move[browser.index];
    picker(
      'Inquiry history',
      inquiryAttempts(choice).map((attempt) => ({
        ...attempt,
        label: `${attempt.at?.replace('T', ' ').slice(0, 16) ?? ''} - ${attempt.run ? 'recorded' : 'draft'}`,
        details: [['Question', [attempt.run?.question ?? attempt.ask.question]]],
        summary: [['Investigation', attempt.entry.data.id.slice(0, 8)]],
      })),
      async (attempt) => activateInquiry(attempt),
      browser,
    );
  }
  function chooseCaseSources(active, value = active.caseSelection) {
    const sources = value.availableSources ?? value.sources;
    const choices = () =>
      sources.map((source) => ({
        label: `${active.caseSelection?.sources.some((item) => item.index === source.index) ? '✓' : ' '} ${source.text}`,
        source,
      }));
    picker(
      'Case sources',
      choices(),
      async ({ source }) => {
        const indexes = new Set(active.caseSelection?.sources.map((item) => item.index) ?? []);
        if (indexes.has(source.index)) indexes.delete(source.index);
        else indexes.add(source.index);
        active.caseSelection = indexes.size
          ? { ...value, sources: sources.filter((item) => indexes.has(item.index)), binding: null }
          : null;
        await saveDraft(active);
        selection.move = choices();
        state.form = selection;
      },
      active,
    );
    const selection = state.form;
  }
  function reviewCase(active) {
    const catalog = active.caseSelection;
    const choices = () => [
      ...(active.caseSelection
        ? [{ label: caseName(active.caseSelection), action: 'inspect' }]
        : []),
      { label: 'Sources', action: 'sources' },
      ...(catalog.kind === 'authored'
        ? [{ label: 'Edit case', action: 'edit' }]
        : [{ label: 'Use current revision', action: 'refresh' }]),
    ];
    picker(
      'Case',
      choices(),
      async ({ action }) => {
        const value = active.caseSelection;
        if (action === 'edit') writeCase(active);
        else if (action === 'refresh') {
          state.project = await openProject(dirname(state.project.path));
          const next = selectCase(state.project, catalog.placementId);
          if (
            value &&
            next.sources.length === value.sources.length &&
            next.sources.every((source, i) => source.textDigest === value.sources[i].textDigest)
          )
            next.binding = value.binding;
          active.caseSelection = next;
          await saveDraft(active);
        } else if (action === 'sources') chooseCaseSources(active, value ?? catalog);
        else {
          forms.startForm('Case', [], () => forms.backForm(), { submitLabel: 'back' });
          state.form.confirm = true;
          state.form.returnForm = active;
          state.form.inspectRows = value.sources.map((source) => ['Source', source.text, 'input']);
        }
      },
      active,
    );
    const menu = state.form;
    menu.onResume = () => {
      const selected = menu.move[menu.index]?.action;
      menu.move = choices();
      menu.index = Math.max(
        0,
        menu.move.findIndex((item) => item.action === selected),
      );
    };
  }
  function actions() {
    if (state.help || state.quitPrompt) return [];
    if (state.form?.investigationBrowser) {
      const browser = state.form,
        choice = browser.move[browser.index];
      return ['nodes', 'reading'].flatMap((pane) => [
        ...(currentRun(choice.ask)
          ? [command(pane, 'e', 'edit question', () => activateInquiry(choice, true))]
          : []),
        ...(inquiryAttempts(choice).length > 1
          ? [command(pane, 'h', 'history', () => inquiryHistory(browser))]
          : []),
      ]);
    }

    if (state.form?.workspace) {
      if (state.form.busy) return [];
      const primary = [
        command('reading', 'CTRL_S', 'save draft', () => saveDraft()),
        command('reading', 'ALT_S', 'scope', chooseScope),
        command('reading', 'ALT_C', 'case', chooseCase),
      ];
      const data = state.investigation?.data;
      const hasHistory =
        data &&
        (data.intentions.length > 1 ||
          data.asks.length > 1 ||
          data.asks.some((ask) => ask.runs.length) ||
          data.assessments.length);
      return [
        ...primary,
        command('reading', 'ALT_I', 'purpose', reframe),
        ...(hasHistory ? [command('reading', 'ALT_H', 'history', history)] : []),
        ...(!(
          state.form.caseSelection?.placementId === state.placementId &&
          state.form.caseSelection.revision === state.project.digest
        ) && hasCaseSources(state.project.data, state.placementId)
          ? [
              command('nodes', 'c', 'use as case', async () => {
                state.form.caseSelection = selectCase(state.project, state.placementId);
                await saveDraft();
              }),
            ]
          : []),
        ...(state.form.origin?.path
          ? [
              command('reading', 'ALT_B', 'origin', async () => {
                await saveDraft();
                const active = state.form;
                const snapshot = Object.fromEntries(
                  ['mode', 'placementId', 'focus', 'offset', 'form', 'investigationReturn'].map(
                    (key) => [key, state[key]],
                  ),
                );
                await projects.loadProjectRecording(active.origin.path);
                state.askReturn = snapshot;
                state.focus = 'reading';
                state.selection = {
                  nodeId: active.origin.nodeId,
                  occurrenceId: active.origin.occurrenceId,
                  visitId: null,
                };
              }),
            ]
          : []),
        ...(state.form.caseSelection
          ? [
              command('nodes', 'x', 'clear case', async () => {
                state.form.caseSelection = null;
                await saveDraft();
              }),
              command('reading', 'ALT_R', 'review case', () => reviewCase(state.form)),
            ]
          : []),
      ];
    }
    if (state.form) return [];
    const backToHistory =
      state.historyReturn && state.mode === 'recording' && state.page === 'overview'
        ? [
            command('reading', 'ESCAPE', 'back to history', async () => {
              const previous = state.historyReturn,
                latest = state.investigation;
              Object.assign(state, previous);
              if (
                latest?.data.id === previous.investigation?.data.id &&
                latest.digest !== previous.investigation.digest
              ) {
                state.investigation = latest;
                const menu = state.form,
                  selected = menu.move[menu.index];
                state.form = menu.back?.form ?? menu.returnForm ?? null;
                await history();
                state.form.index = Math.max(
                  0,
                  state.form.move.findIndex(
                    (item) =>
                      item.kind === selected.kind &&
                      item.item.id === selected.item.id &&
                      item.item.path === selected.item.path,
                  ),
                );
                state.form.back = menu.back;
                state.form.returnForm = menu.returnForm;
              }
            }),
          ]
        : [];
    if (
      state.mode === 'project' &&
      !['concept', 'material-concept', 'workspace'].includes(state.selectedProjectEntry?.()?.kind)
    )
      return [];
    if (state.mode === 'project')
      return [
        ...(inquiryGroups(
          [...(state.investigationEntries ?? []), state.investigation],
          state.placementId,
        ).length
          ? [command('nodes', 'i', 'inquiries', chooseInvestigation)]
          : []),
        command('nodes', 'A', 'new ask', () => startAsk({ fresh: true })),
      ];
    if (state.mode !== 'recording' || !state.ix.recording.project) return backToHistory;
    const material = selectedMaterial(state.ix, state.selection);

    if (state.page === 'scope') {
      const opening = evidenceOpenings(state.ix, state.selection, state.interpretationDecisions)[
        state.openingIndex ?? 0
      ];
      return opening
        ? [
            ...(followupFor(state.investigation?.data, origin(), opening.id)
              ? [command('reading', 'N', 'new question', () => followup(opening, true))]
              : []),
          ]
        : [];
    }
    if (state.page !== 'overview') return [];
    return [
      ...backToHistory,
      ...(material.occurrence
        ? [
            command(
              'reading',
              'd',
              currentAssessments().length ? 'review assessment' : 'assess',
              assessment,
            ),
          ]
        : []),
      ...(state.askReturn
        ? [
            command('global', 'A', 'return to ask', () => {
              const saved = state.askReturn;
              state.askReturn = null;
              Object.assign(state, saved);
            }),
          ]
        : [command('global', 'A', 'edit question', editQuestion)]),
    ];
  }

  return {
    actions,
    startAsk,
    editCase: () => writeCase(state.form),
    saveDraft,
    attach,
    followup,
    picker,
    persist,
    origin,
    history,
    reframe,
  };
}
