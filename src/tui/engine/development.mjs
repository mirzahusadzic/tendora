/** Language-only corpus development using the same project and engine as Ask. */
import {
  developContribution,
  reviseContribution,
  withdrawContributionPart,
  addMaterial,
  reviseMaterial,
} from '../../engine/develop.mjs';
import { contributionRevision, contributionTitle } from '../../project/authoring/development.mjs';
import { readEngineArtifact } from '../../project/storage/engine-runs.mjs';
import { placementLabel } from '../concepts/placement-label.mjs';
import { runEngine } from '../../engine/run.mjs';
import { inputFromProject } from '../../engine/input.mjs';
import { readingDevelopment } from '../shell/state.mjs';
import { deleteQuestion } from '../../project/inquiries/delete-engine-runs.mjs';
import { listProjectRecordings } from '../../project/inquiries/recordings.mjs';
import { acceptClarification } from '../../engine/clarify.mjs';
import { retainPartialContribution } from '../../engine/partial.mjs';
import { createStatementsEditor } from './statements.mjs';

export function createDevelopment({ state, forms, projects, investigation, draw, setNotice }) {
  const statementsEditor = createStatementsEditor({ state, forms, projects, draw, setNotice });
  const command = (key, description, run, pane = 'reading') => ({ key, description, run, pane });
  const contribution = (id) => state.project.data.contributions.find((c) => c.id === id);
  async function assess(c, question = c.question?.text, signal) {
    if (!question) return;
    const project = state.project;
    await runEngine(project, {
      input: await inputFromProject(project, { scopePlacementId: c.scopePlacementId, question }),
      acquireMissing: true,
      trace: false,
      signal,
      purpose: 'contribution-assessment',
    });
  }
  function execute(form, request) {
    const project = state.project;
    form.controller = new AbortController();
    form.busy = true;
    form.error = '';
    form.recovery = null;
    const operation = form.materialEditor
      ? form.revisesContribution
        ? reviseMaterial
        : addMaterial
      : form.revisesContribution
        ? reviseContribution
        : developContribution;
    form.execution = operation(project, request, {
      signal: form.controller.signal,
      progress: (message) => {
        form.progress = message;
        draw();
      },
    })
      .then(async ({ data, contribution: c }) => {
        form.controller.signal.throwIfAborted();
        form.committing = true;
        draw();
        try {
          state.project = await projects.persistProject(project, data);
        } finally {
          form.committing = false;
        }
        form.corpusSaved = true;
        form.progress = 'Checking saved statements';
        draw();
        await assess(
          c,
          request.perspective ? request.question : c.question?.text,
          form.controller.signal,
        );
        await projects.refreshOutline();
        if (state.form === form) {
          // A successful save finishes authoring. Back must not resurrect a stale
          // draft or an earlier picker that could accidentally duplicate the material.
          state.form = null;
          if (form.returnToMaterial) {
            const active = c.responses.filter((r) => !r.withdrawn);
            const part =
              active.find((r) => r.id === form.editPartId || r.replaces === form.editPartId) ??
              active[0];
            const next = state
              .projectOutline(null)
              .find(
                (item) => item.contributionId === c.id && item.partId === (part?.id ?? 'question'),
              );
            if (next) {
              state.projectExpanded.add(next.id);
              state.selectProjectEntry(next.id, { focus: 'reading' });
            }
          } else await selectContribution(c.id);
          setNotice(
            state.workflow?.active()
              ? 'Statements saved'
              : form.revisesContribution
                ? 'Contribution revised; earlier meaning retained in history'
                : c.responses.length
                  ? 'Corpus contribution saved'
                  : 'Open connection retained',
          );
        }
      })
      .catch((error) => {
        if (state.form === form && !form.controller.signal.aborted) {
          form.busy = false;
          if (error.code === 'ANSWER_ATTACHMENT') {
            investigation.picker(
              'Which part answers this perspective?',
              error.choices,
              ({ id }) => {
                state.form = form;
                execute(form, { ...request, answerNodeId: id });
              },
            );
            state.form.contextRows = [
              ['Question', request.question, 'input'],
              [
                'Meaning',
                'Choose the answer already expressed by this contribution. If it needs a new fact, go back and develop that connection.',
              ],
            ];
            return;
          }
          form.error = projects.saveError(error);
          form.openQuestion = error.code === 'OPEN_MATERIAL' ? error.text : null;
          form.recovery = {
            saved: state.project.digest !== project.digest,
            steps:
              state.project.digest !== project.digest
                ? 'The material is saved, but its assessment did not finish. Return to the corpus and ask the question again to retry.'
                : error.client === 'AMR'
                  ? 'Your text remains in these fields. Restore the eGemma AMR service, then save again to retry. Returning cancels these unsaved changes.'
                  : form.openQuestion
                    ? 'Develop this sentence as a question with an optional answer, or edit it into a statement. Returning from question development preserves this draft.'
                    : 'Your text remains in these fields. Edit the material and save again, or return without saving.',
          };
        }
      })
      .finally(draw);
  }
  function materialEditor(id = null, anchor = null) {
    const c = id ? contribution(id) : null;
    forms.startForm(
      c ? 'Edit statements' : 'Add statements',
      [
        [
          'Statements',
          c?.responses
            .filter((r) => !r.withdrawn)
            .map((r) => r.text)
            .join('\n') ?? '',
          true,
        ],
      ],
      ([text]) =>
        execute(state.form, {
          text,
          contributionId: id,
          scopePlacementId: c?.scopePlacementId ?? state.placementId,
          anchor,
        }),
      { submitLabel: 'save statements' },
    );
    state.form.materialEditor = true;
    state.form.revisesContribution = Boolean(c);
    state.form.contextRows = [
      ['At', placementLabel(state.project.data, c?.scopePlacementId ?? state.placementId)],
      [
        'Purpose',
        'Write observations or rules in ordinary language. Questions can use them here and from roles above.',
      ],
      ...(anchor ? [['Develops', anchor.label, 'input']] : []),
    ];
  }

  function open({
    question = '',
    id = null,
    wording = false,
    perspective = false,
    basisResponseId = null,
    anchor = null,
    origin = null,
  } = {}) {
    const c = id ? contribution(id) : null;
    const scopePlacementId = c?.scopePlacementId ?? state.placementId;
    forms.startForm(
      perspective
        ? 'Another perspective'
        : wording
          ? 'Another wording'
          : c
            ? 'Contribute an answer'
            : 'Develop corpus',
      wording || perspective
        ? [['Question', question, true]]
        : c
          ? [['Answer or supporting sentence', '', true]]
          : [
              ['Question', question, true],
              ['Answer (optional)', '', true, false],
            ],
      (values) => {
        const q = wording || perspective || !c ? values[0] : c.question.text;
        execute(state.form, {
          scopePlacementId,
          question: q,
          answer: wording || perspective ? '' : c ? values[0] : values[1],
          contributionId: id,
          wording,
          perspective,
          basisResponseId,
          anchor,
          origin,
        });
      },
      { submitLabel: perspective ? 'save perspective' : wording ? 'save wording' : 'contribute' },
    );
    state.form.contextRows = [
      ['Scope', placementLabel(state.project.data, scopePlacementId)],
      ...(c?.question ? [['Question', c.question.text, 'input']] : []),
      ...(anchor ? [['Develop from', anchor.label ?? anchor.question, 'input']] : []),
      [
        'Meaning',
        perspective
          ? 'Ask about this same established relationship from another angle. This declaration becomes corpus knowledge; it cannot supply a missing connection.'
          : wording
            ? 'This asks for the same answer under the same conditions. The correspondence becomes corpus knowledge.'
            : c
              ? 'Supply an answer or an observation. Yes / No affirms or denies a yes/no question.'
              : 'Leave the answer blank to retain an open connection. Yes / No affirms or denies a yes/no question.',
      ],
    ];
    state.form.developingContribution = true;
  }
  function selectContribution(id) {
    if (state.workflow?.active()) return state.workflow.sourceSaved(id);
    const c = contribution(id);
    state.form = null;
    state.selectProjectEntry(`${c.scopePlacementId}/contribution/${c.id}`, { focus: 'reading' });
  }
  const selectedContributionId = () => {
    if (state.mode !== 'project' && !readingDevelopment(state)) return null;
    const item = !state.form && state.projectReadingEntry?.();
    return item?.kind === 'corpus-contribution' ? item.entry.id : null;
  };
  function editMaterial(item) {
    if (item.partId === 'question' && item.open) {
      open({ id: item.contributionId });
      return;
    }
    editContribution(item.contributionId, {
      partId: item.partId,
      returnToMaterial: true,
      focusQuestion: item.partId === 'question',
    });
  }
  function editContribution(id, { partId, returnToMaterial = false, focusQuestion = true } = {}) {
    const c = contribution(id),
      active = c.responses.filter((r) => !r.withdrawn),
      responses = active.length ? active : [{ id: null, text: '' }];
    if (!c.question) return materialEditor(id);
    forms.startForm(
      state.workflow?.active() ? 'Edit source' : 'Edit contribution',
      [
        ['Question', c.question.text, true],
        ...responses.map((r, i) => [
          active.length > 1 ? `Answer ${i + 1} or supporting sentence` : 'Answer (optional)',
          r.text,
          true,
          false,
        ]),
      ],
      ([question, ...answers]) => {
        if (
          question.trim() === c.question.text &&
          answers.every((text, i) => text.trim() === responses[i].text)
        ) {
          forms.backForm();
          return;
        }
        execute(state.form, {
          contributionId: c.id,
          question,
          responses: responses.map((r, i) => ({ id: r.id, text: answers[i] })),
        });
      },
      { submitLabel: 'save' },
    );
    state.form.revisesContribution = true;
    state.form.returnToMaterial = returnToMaterial;
    state.form.editPartId = partId;
    if (!focusQuestion)
      state.form.index =
        Math.max(
          0,
          responses.findIndex((r) => r.id === partId),
        ) + 1;
    state.form.contextRows = [
      [
        'Meaning',
        'Saving updates the source meaning. Questions will be checked against the changed source.',
      ],
      ['Answers', 'Clear an answer to withdraw its support and keep the question.'],
      ...(c.wordings.some((w) => !w.withdrawn)
        ? [
            [
              'Declarations',
              'Declarations tied to replaced meaning are retired; unchanged supporting sentences keep their connections.',
            ],
          ]
        : []),
    ];
  }
  function browse() {
    const entries = (state.project.data.contributions ?? []).filter(
      (c) => c.scopePlacementId === state.placementId,
    );
    if (!entries.length) {
      open();
      return;
    }
    investigation.picker(
      'Corpus questions',
      entries.map((c) => ({
        id: c.id,
        label: `${c.responses.some((r) => !r.withdrawn) ? 'Material' : 'Question'}: ${contributionTitle(c)}`,
      })),
      ({ id }) => selectContribution(id),
    );
  }
  function developQuestion({ question = '', contributionIds = [] } = {}) {
    const retained = (state.project.data.contributions ?? []).filter(
      (c) =>
        c.question &&
        c.scopePlacementId === state.placementId &&
        (contributionIds.includes(c.id) || c.question.text === question),
    );
    if (retained.length === 1) return selectContribution(retained[0].id);
    if (retained.length > 1)
      return investigation.picker(
        'Continue which question?',
        retained.map((c) => ({
          id: c.id,
          label: contributionTitle(c),
        })),
        (choice) => selectContribution(choice.id),
      );
    open({ question });
  }
  function clarifyConnection({ run, input }) {
    const candidates = run.answer?.clarifications ?? [];
    const question = input?.question?.text ?? run.questions?.[0]?.text ?? '';
    if (!candidates.length) return developQuestion({ question });
    const project = state.project;
    forms.startForm(
      'Clarify connection',
      [],
      () => {
        const form = state.form;
        const choice = form.move[form.index];
        if (choice.kind === 'open') {
          forms.backForm();
          setNotice('Connection kept open');
          return;
        }
        if (choice.kind === 'develop') {
          state.form = null;
          if (state.workflow?.active()) materialEditor();
          else open({ question });
          return;
        }
        form.busy = true;
        form.committing = true;
        form.error = '';
        form.progress = 'Save the confirmed connection';
        form.execution = (async () => {
          const { data } = await acceptClarification(project, choice.candidate);
          state.project = await projects.persistProject(project, data);
          form.corpusSaved = true;
          await projects.refreshOutline();
          state.form = null;
          await (state.workflow?.ask ?? investigation.startAsk)({
            fresh: true,
            question,
            scopePlacementId: run.scopePlacementId,
            caseSelection: input?.caseSelection,
          });
          const ask = state.form;
          await forms.submitForm();
          await ask.execution;
          if (!ask.error) setNotice('Connection saved; question checked against the corpus');
        })()
          .catch((error) => {
            if (!state.form) state.form = form;
            if (state.form === form) {
              form.busy = false;
              form.error = projects.saveError(error);
              form.recovery = {
                saved: Boolean(form.corpusSaved),
                steps: form.corpusSaved
                  ? 'The connection is saved. Return to the corpus and ask the question again.'
                  : 'No connection was saved. Check the current corpus and ask again.',
              };
            }
          })
          .finally(() => {
            form.committing = false;
            draw();
          });
      },
      { submitLabel: 'confirm choice' },
    );
    const form = state.form;
    form.move = [
      { kind: 'open', label: 'Keep open' },
      ...candidates.map((candidate) => ({
        kind: 'clarify',
        label: `${candidate.answerNodeId ? `Confirm ${candidate.answerLabel}` : 'Confirm source connection'}: ${candidate.source.text}`,
        candidate,
      })),
      {
        kind: 'develop',
        label: state.workflow?.active() ? 'Add a source statement' : 'Develop a new contribution',
      },
    ];
    form.contextDetails = () => {
      const candidate = form.move[form.index]?.candidate;
      return [
        ['Question', question, 'input'],
        [
          'Meaning',
          'Confirm that the selected source answers this question. The connection is saved for other questions in this corpus.',
        ],
        ...(candidate
          ? [
              ['Source', candidate.source.text, 'input'],
              ...(candidate.answerNodeId ? [['Would answer', candidate.answerLabel, 'input']] : []),
              [
                'Confirm only if',
                'The source really establishes this answer to the whole question.',
                'warning',
              ],
            ]
          : []),
      ];
    };
  }
  async function retainPartial({ run, input, result }) {
    try {
      const { data, contribution: c } = retainPartialContribution(state.project, input, result);
      state.project = await projects.persistProject(state.project, data);
      await assess(c);
      await projects.refreshOutline();
      selectContribution(c.id);
      setNotice('Supported parts and open connections retained; select a part to develop it');
    } catch (error) {
      setNotice(error.message);
    }
    draw();
  }
  function withdrawDeclaration(contributionId, partId) {
    const c = contribution(contributionId);
    const part = c?.wordings.find((w) => w.id === partId && !w.withdrawn);
    if (!part) throw new Error('This connection is no longer available.');
    const project = state.project;
    forms.startForm(
      'Withdraw connection',
      [],
      () => {
        const form = state.form;
        form.busy = true;
        form.committing = true;
        form.controller = new AbortController();
        form.developingContribution = true;
        form.error = '';
        form.progress = 'Withdrawing the connection';
        draw();
        form.execution = (async () => {
          state.project = await projects.persistProject(
            project,
            withdrawContributionPart(project.data, contributionId, partId),
          );
          form.corpusSaved = true;
          form.committing = false;
          form.progress = 'Checking the remaining support';
          draw();
          await assess(contribution(contributionId), undefined, form.controller.signal);
          if (form.controller.signal.aborted || state.form !== form) return;
          await projects.refreshOutline();
          await selectContribution(contributionId);
          state.projectReadingView?.();
          state.projectReadingTab = 'Corpus';
          setNotice('Connection withdrawn');
        })()
          .catch((error) => {
            if (form.controller.signal.aborted || state.form !== form) return;
            form.error = projects.saveError(error);
            form.recovery = { saved: Boolean(form.corpusSaved) };
          })
          .finally(() => {
            form.busy = false;
            form.committing = false;
            draw();
          });
      },
      { submitLabel: 'withdraw' },
    );
    state.form.confirm = true;
    state.form.yesNo = { yes: false };
    state.form.inspectRows = [
      ['Connection', part.text, 'input'],
      ...(part.basisSources ?? []).map((source) => ['Source', source.text, 'input']),
      ['Withdraw', 'This interpretation and the support that depends on it'],
      ['Retain', 'The question, source statements and other connections'],
    ];
  }
  function related(id) {
    const c = contribution(id),
      base = c.responses.filter((r) => !r.withdrawn).at(-1) ?? c.question;
    if (!base) return materialEditor(id);
    const nodes = base.graph.nodes.filter(
      (n) => n.literal === undefined && n.concept !== 'amr-unknown',
    );
    investigation.picker(
      'Develop a connection',
      [
        { id: base.graph.top, label: 'This relationship' },
        ...nodes
          .filter((n) => n.id !== base.graph.top)
          .map((n) => ({
            id: n.id,
            label:
              n.authoredLabel ??
              n.surfaceLabel ??
              n.concept.replace(/-\d+$/u, '').replaceAll('-', ' '),
          })),
      ],
      (node) =>
        open({
          anchor: {
            contributionId: id,
            partId: base.id ?? 'question',
            nodeId: node.id,
            revision: contributionRevision(base.graph),
            question: contributionTitle(c),
            label: node.label,
          },
        }),
    );
  }
  function confirmDeleteQuestion(item) {
    const c = item?.kind === 'corpus-contribution' ? contribution(item.entry.id) : null;
    if ((!c?.question && item?.kind !== 'engine-run') || state.form) return;
    const project = state.project;
    const origin = { focus: state.focus, tab: state.projectReadingTab };
    const index = state.projectDevelopmentOutline().findIndex((entry) => entry.id === item.id);
    const question = {
      contributionId: c?.id,
      scopePlacementId: item.placementId,
      text: c?.question.text ?? item.label,
    };
    forms.startForm('Delete question', [], async () => {
      const form = state.form;
      form.busy = true;
      try {
        const result = await deleteQuestion(project, question, {
          persist: async (base, data) => {
            state.project = await projects.persistProject(base, data);
            return state.project;
          },
        });
        state.project = result.project;
        state.form = null;
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
          projectReadingRunId: null,
          projectReadingTab: null,
          offset: 0,
        });
        await state.cancelEngine?.();
        state.recordings = await listProjectRecordings(state.project);
        await projects.refreshOutline();
        const items = state.projectDevelopmentOutline();
        const next = items[Math.max(0, Math.min(index, items.length - 1))];
        state.selectProjectEntry(next?.id ?? state.placementId, {
          focus: next ? origin.focus : 'nodes',
        });
        if (origin.tab === 'Corpus') {
          state.focus = 'reading';
          state.projectReadingView?.();
          state.projectReadingTab = 'Corpus';
        }
        setNotice('Question deleted');
      } catch (error) {
        form.busy = false;
        throw error;
      }
    });
    state.form.confirm = true;
    state.form.yesNo = { yes: false };
    state.form.inspectRows = [
      ['Question', question.text, 'input'],
      [
        'Delete',
        c ? 'Question, its contributions and saved assessments' : 'Question and saved assessments',
      ],
      ['Keep', 'Other corpus material and follow-up questions'],
    ];
  }
  function legacyActions() {
    if (!state.project || state.help || state.quitPrompt || state.form?.busy) return [];
    const id = selectedContributionId();
    if (id)
      return [
        command('c', 'view concepts', () => {
          state.form = null;
          const selected = state.selectedConceptEntry();
          state.selectProjectEntry(selected.id, { focus: 'nodes' });
          state.projectExpanded.add(selected.id);
        }),
        command('d', 'develop question', () => open()),
        command('e', 'edit contribution', () => editContribution(id)),
        command('a', 'add answer', () => open({ id })),
        ...(contribution(id).question
          ? [command('w', 'another wording', () => open({ id, wording: true }))]
          : []),
        ...(contribution(id).responses.some((r) => !r.withdrawn)
          ? [
              command('p', 'another perspective', () => {
                const responses = contribution(id).responses.filter((r) => !r.withdrawn);
                if (responses.length === 1)
                  open({ id, perspective: true, basisResponseId: responses[0].id });
                else
                  investigation.picker(
                    'Perspective on which contribution?',
                    responses.map((r) => ({ id: r.id, label: r.text })),
                    (r) => open({ id, perspective: true, basisResponseId: r.id }),
                  );
              }),
            ]
          : []),
        command('g', 'develop connection', () => related(id)),
        command('K', 'corpus questions', browse),
        command('D', 'develop open connection', () => selectContribution(id)),
        command('t', 'test a question', () => investigation.startAsk({ fresh: true })),
        command('k', 'corpus questions', browse),
        ...([...contribution(id).responses, ...contribution(id).wordings].some((r) => !r.withdrawn)
          ? [
              command('x', 'withdraw contribution', () =>
                investigation.picker(
                  'Withdraw which contribution?',
                  [...contribution(id).responses, ...contribution(id).wordings]
                    .filter((r) => !r.withdrawn)
                    .map((r) => ({ id: r.id, label: r.text })),
                  async (part) => {
                    state.project = await projects.persistProject(
                      state.project,
                      withdrawContributionPart(state.project.data, id, part.id),
                    );
                    await assess(contribution(id));
                    await projects.refreshOutline();
                    selectContribution(id);
                    setNotice('Withdrawn; corpus reassessed');
                  },
                ),
              ),
            ]
          : []),
      ];
    if (state.form?.workspace)
      return [
        command('ALT_D', 'develop in corpus', () => open({ question: state.form.fields[0].value })),
      ];
    if (state.form) return [];
    const openings =
      state.mode === 'recording'
        ? state.ix?.recording.reasoning?.openings
        : state.engineReadingView?.()?.engineReview?.run?.openings;
    const retained = (openings ?? []).filter(
      (o) =>
        o.kind === 'aporia' &&
        state.project.data.contributions?.some((c) => c.id === o.contributionId),
    );
    const q =
      state.mode === 'recording'
        ? state.ix?.recording.inquiry.text
        : (state.engineReadingView?.()?.engineReview?.run?.questions?.[0]?.text ?? '');
    const selected =
      state.mode === 'project' && state.projectReadingOrigin === 'nodes'
        ? state.selectedConceptEntry?.()
        : null;
    const material = selected?.kind === 'material-concept' ? selected : null;
    const edits =
      state.mode === 'project'
        ? ['nodes', 'development', 'reading'].flatMap((pane) => {
            const item =
              pane === 'nodes'
                ? state.selectedConceptEntry?.()
                : pane === 'development'
                  ? state.selectedDevelopmentEntry?.()
                  : state.projectReadingEntry?.();
            const id = item?.kind === 'corpus-contribution' ? item.entry.id : item?.contributionId;
            return id
              ? [
                  command(
                    'e',
                    'edit contribution',
                    () =>
                      editContribution(id, {
                        partId: item.partId,
                        returnToMaterial: item.kind === 'material-concept',
                      }),
                    pane,
                  ),
                ]
              : [];
          })
        : [];
    return [
      ...edits,
      ...['nodes', 'reading'].flatMap((pane) => [
        command(
          'D',
          retained.length
            ? 'develop open connection'
            : material
              ? 'develop this part'
              : 'develop corpus',
          () => {
            if (retained.length === 1) selectContribution(retained[0].contributionId);
            else if (retained.length > 1)
              investigation.picker(
                'Open connections',
                retained.map((o) => ({ id: o.contributionId, label: o.text })),
                ({ id }) => selectContribution(id),
              );
            else if (
              material?.open &&
              !contribution(material.contributionId).responses.some((r) => !r.withdrawn)
            )
              open({ id: material.contributionId });
            else open({ question: q, ...(material ? { anchor: material.anchor } : {}) });
          },
          pane,
        ),
        command('K', 'corpus questions', browse, pane),
      ]),
    ];
  }
  function actions() {
    if (!state.project || state.help || state.quitPrompt || state.form?.busy) return [];
    const legacy = legacyActions();
    if (state.form?.openQuestion)
      return [
        command('ALT_D', 'develop this question', () =>
          open({ question: state.form.openQuestion }),
        ),
      ];
    if (state.form) return legacy;
    if (state.mode !== 'project' && !readingDevelopment(state))
      return legacy
        .filter((action) => action.key === 'D')
        .map((action) => ({
          ...action,
          presentation: 'workspace',
        }));
    const panes = ['nodes', 'development', 'reading'];
    const primary = panes.flatMap((pane) => {
      const tab =
        pane === 'reading' &&
        state.projectReadingView?.()?.sections[state.projectReadingView().sectionIndex]?.key;
      if (tab && !['Material', 'Meaning', 'Outcome', 'Openings'].includes(tab)) return [];
      const item =
        pane === 'nodes'
          ? state.selectedConceptEntry?.()
          : pane === 'development'
            ? state.selectedDevelopmentEntry?.()
            : state.projectReadingEntry?.();
      const cid =
        item?.contributionId ?? (item?.kind === 'corpus-contribution' ? item.entry.id : null);
      const c = cid ? contribution(cid) : null;
      const deletion =
        pane !== 'nodes' &&
        (item?.kind === 'engine-run' || (item?.kind === 'corpus-contribution' && c?.question))
          ? [command('x', 'delete question', () => confirmDeleteQuestion(item), pane)]
          : [];
      if (tab === 'Meaning')
        return cid
          ? [
              command(
                'e',
                'edit material',
                () =>
                  editContribution(cid, {
                    partId: state.projectReadingView().selectedPartId,
                    focusQuestion: state.projectReadingView().selectedPartId === 'question',
                    returnToMaterial: item.kind === 'material-concept',
                  }),
                pane,
              ),
              ...deletion,
            ]
          : [];
      const unresolved =
        c?.question &&
        (!c.responses.some((r) => !r.withdrawn) ||
          c.responses.some((r) => !r.withdrawn && r.composition?.connection === 'unresolved'));
      return [
        ...(item?.kind === 'workspace'
          ? [command('n', 'add material', () => materialEditor(), pane)]
          : []),
        ...(item?.kind === 'corpus-contribution' && unresolved
          ? [command('g', 'develop connection', () => related(cid), pane)]
          : []),
        command(
          'd',
          unresolved
            ? 'develop answer'
            : item?.kind === 'corpus-contribution'
              ? 'develop connection'
              : c?.question
                ? 'follow-up question'
                : 'develop question',
          () => {
            if (unresolved) open({ id: cid });
            else if (item?.kind === 'corpus-contribution') related(cid);
            else open({ ...(item?.anchor ? { anchor: item.anchor } : {}) });
          },
          pane,
        ),
        command(
          'a',
          c?.question ? 'check question' : 'ask corpus',
          async () => {
            const input =
              c?.question && item?.latestRun?.inputRef
                ? await readEngineArtifact(state.project, item.latestRun.inputRef)
                : null;
            return investigation.startAsk(
              c?.question
                ? { fresh: true, question: c.question.text, caseSelection: input?.caseSelection }
                : { fresh: true },
            );
          },
          pane,
        ),
        ...(cid
          ? [
              command(
                'e',
                c?.question ? 'edit contribution' : 'edit material',
                () =>
                  editContribution(cid, {
                    partId: item?.partId,
                    returnToMaterial: item?.kind === 'material-concept',
                  }),
                pane,
              ),
            ]
          : []),
        ...(item?.kind === 'corpus-contribution'
          ? legacy
              .filter((a) => ['w', 'p'].includes(a.key) || (a.key === 'x' && !c?.question))
              .map((a) => ({ ...a, pane }))
          : []),
        ...deletion,
      ];
    });
    return [
      ...primary.map((action) => ({ ...action, presentation: 'workspace' })),
      ...legacy
        .filter(
          (a) =>
            !primary.some((p) => p.key === a.key && p.pane === a.pane) &&
            !(
              a.pane === 'reading' &&
              !state.form &&
              !['Material', 'Outcome', 'Openings'].includes(
                state.projectReadingView?.()?.sections[state.projectReadingView().sectionIndex]
                  ?.key,
              )
            ),
        )
        .map((a) => ({ ...a, presentation: 'choice' })),
    ];
  }
  return {
    statementsEditor,
    actions,
    open,
    developQuestion,
    selectContribution,
    browse,
    editMaterial,
    materialEditor,
    confirmDeleteQuestion,
    clarifyConnection,
    retainPartial,
    withdrawDeclaration,
  };
}
