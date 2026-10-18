/** Project-wide reading view; rows refer back to real authored material. */
import { conceptSources } from '../../project/authoring/sources.mjs';
import { readingDevelopment } from '../shell/state.mjs';
import { pageStep } from '../shell/layout.mjs';
import { contributionContext, relationMeaning } from './meaning.mjs';
import { currentPartialParts } from '../../project/authoring/partial.mjs';
const counted = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const questionStatus = (item) =>
  item.currentRun
    ? item.currentRun.status.replace(/^./u, (letter) => letter.toUpperCase())
    : item.latestRun
      ? 'Check pending'
      : 'Not assessed';

export function corpusRows(data, development) {
  const rows = [];
  for (const item of development) {
    const add = (kind, status, text, tone = 'plain', partId = null) =>
      rows.push({ kind, status, text, tone, entryId: item.id, partId });
    if (item.kind === 'corpus-contribution') {
      const c = item.entry;
      if (c.question)
        add('Question', questionStatus(item), c.question.text, item.stateTone, 'question');
      for (const part of currentPartialParts(data, c))
        add(
          'Supported part',
          part.current ? 'Source dependent' : 'Earlier support',
          [...new Set(part.sources.map((source) => source.text))].join('\n'),
          part.current ? 'plain' : 'warning',
          'question',
        );
      for (const response of c.responses.filter((r) => !r.withdrawn)) {
        const open = response.composition?.connection === 'unresolved';
        add(
          response.graph.edges.some((e) => e.role === ':condition') ? 'Conditional' : 'Statement',
          open ? 'Open connection' : 'Saved',
          response.text,
          open ? 'warning' : 'plain',
          response.id,
        );
      }
      for (const wording of c.wordings.filter((w) => !w.withdrawn))
        add(
          wording.kind === 'clarification' ? 'Interpretation' : 'Wording',
          wording.kind === 'clarification' ? 'Confirmed connection' : 'Declared wording',
          wording.text,
          'plain',
          wording.id,
        );
      if (!c.question && !c.responses.some((r) => !r.withdrawn))
        add('Material', 'No active statements', item.label, 'muted');
    } else
      add(
        item.kind === 'mapping' ? 'Interpretation' : 'Question',
        item.kind === 'mapping' ? item.materialState : questionStatus(item),
        item.label,
        item.stateTone,
      );
  }
  // A source shared by several placements appears once, with its original owner.
  for (const concept of data.concepts) {
    const placement = data.placements.find((p) => p.conceptId === concept.id);
    for (const source of conceptSources(concept))
      rows.push({
        kind: 'Source',
        status: 'Saved',
        text: source.text,
        tone: 'plain',
        entryId: placement?.id,
      });
  }
  for (const entry of data.knowledge ?? [])
    rows.push({
      kind: 'Knowledge',
      status: 'Authored',
      text: entry.name + (entry.attribution ? `\n${entry.attribution}` : ''),
      attribution: entry.attribution,
      entryId: null,
      tone: 'plain',
    });
  return rows;
}

export function createProjectReading({ state }) {
  const view = {};
  let owner = null,
    engineView = null,
    rows = [],
    previousData = null,
    previousItems = null,
    choice = 0,
    meaningParts = [],
    meaningChoice = 0,
    revealMeaning = false,
    revealCorpus = false;
  const available = () =>
    !state.form &&
    !state.help &&
    !state.quitPrompt &&
    state.project &&
    (state.mode === 'project' || readingDevelopment(state));
  function refresh() {
    if (!available()) return null;
    const identity = `${state.project.path}:${state.projectReadingEntry()?.id}`;
    const changedOwner = owner !== identity;
    if (owner !== identity) {
      owner = identity;
      state.projectReadingTab = null;
    }
    engineView = state.engineReadingView?.();
    const item = state.projectReadingEntry();
    const contribution =
      item?.kind === 'corpus-contribution'
        ? item.entry
        : state.project.data.contributions?.find((c) => c.id === item?.contributionId);
    const previousPart = meaningParts[meaningChoice]?.id;
    meaningParts = contribution
      ? [
          ...(contribution.question ? [{ ...contribution.question, id: 'question' }] : []),
          ...contribution.responses.filter((r) => !r.withdrawn),
        ]
      : [];
    meaningChoice = Math.max(
      0,
      meaningParts.findIndex(
        (p) => p.id === (changedOwner ? (item.partId ?? 'question') : previousPart),
      ),
    );
    const part = meaningParts[meaningChoice];
    const context =
      state.projectReadingTab === 'Meaning' && part && contributionContext(contribution, part);
    const meaning = {
      key: 'Meaning',
      label: 'Meaning',
      heading: 'Saved source meaning',
      table: {
        headers: ['Part', 'Language'],
        widths: [13, null],
        minWidth: 0,
        repeatColumns: 0,
        entries: meaningParts.map((p, index) => ({
          cells: [
            `${index === meaningChoice ? '>' : ' '} ${p.id === 'question' ? 'Question' : 'Statement'}`,
            p.text,
          ],
          cellTones: { 0: index === meaningChoice ? 'selected' : 'plain', 1: 'input' },
          choiceIndex: index,
        })),
      },
      groups:
        state.projectReadingTab === 'Meaning' && part
          ? [
              {
                rows: [
                  ...(context.label ? [['Question context', context.label, context.tone]] : []),
                  ...(item.contextNote ? [['Attachment', item.contextNote, 'warning']] : []),
                ],
                groups: [
                  relationMeaning(part.graph, {
                    text: part.text,
                    sourceId: `contribution:${contribution.id}:${part.id}`,
                    marks: context.marks,
                    selectedNodeId: item.partId === part.id ? item.nodeId : null,
                    question: part.id === 'question',
                  }),
                ],
              },
              {
                rows: [
                  ...[
                    contribution.question?.acquisition,
                    part.id === 'question' ? null : part.acquisition,
                  ]
                    .filter(Boolean)
                    .flatMap((a) => [
                      ['Original text', a.text, 'input'],
                      ['Original AMR', a.penman, 'amr'],
                    ]),
                ],
              },
            ]
          : [],
    };
    const items = state.projectDevelopmentOutline();
    if (state.project.data !== previousData || items !== previousItems) {
      const selected = rows[choice];
      rows = corpusRows(state.project.data, items);
      const retained = rows.findIndex(
        (r) =>
          r.entryId === selected?.entryId &&
          r.partId === selected?.partId &&
          r.kind === selected?.kind,
      );
      if (retained >= 0) choice = retained;
      previousData = state.project.data;
      previousItems = items;
    }
    choice = Math.min(choice, Math.max(0, rows.length - 1));
    const questions = rows.filter((r) => r.kind === 'Question'),
      assessed = items.filter((i) => i.currentRun && i.kind !== 'mapping').length,
      selected = rows[choice];
    const selectedItem = items.find((item) => item.id === selected?.entryId);
    const selectedDeclaration = selectedItem?.entry.wordings?.find(
      (part) => part.id === selected?.partId,
    );
    const placement = state.project.data.placements.find(
      (p) => p.id === (selectedItem?.placementId ?? selected?.entryId),
    );
    const scope = state.project.data.concepts.find((c) => c.id === placement?.conceptId);
    const corpus = {
      key: 'Corpus',
      label: 'Corpus',
      heading: 'Complete corpus',
      rows: [
        [
          'Material',
          `${counted(questions.length, 'question')}; ${counted(rows.filter((r) => ['Statement', 'Conditional', 'Source'].includes(r.kind)).length, 'statement')}; ${counted((state.project.data.contributions ?? []).length, 'contribution')}`,
        ],
        [
          'Assessment',
          `${assessed} current; ${questions.length - assessed} not current`,
          assessed < questions.length ? 'warning' : 'plain',
        ],
        ...(selected?.attribution ? [['Attribution', selected.attribution]] : []),
        ...(selectedDeclaration
          ? [
              ['Connection', selectedDeclaration.text, 'input'],
              ...(selectedDeclaration.answerLabel
                ? [['Answer', selectedDeclaration.answerLabel, 'input']]
                : []),
              ...(selectedDeclaration.basisSources ?? []).map((source) => [
                'Source',
                source.text,
                'input',
              ]),
            ]
          : []),
        ...(scope && !scope.workspace ? [['Selected scope', scope.name]] : []),
        ...(selected?.kind === 'Question' && selectedItem?.currentRun?.case
          ? [['Selected assessment case', selectedItem.currentRun.case, 'input']]
          : []),
      ],
      table: {
        headers: ['Kind', 'State', 'Language'],
        widths: [13, 12, null],
        minWidth: 0,
        repeatColumns: 0,
        entries: rows.map((r, index) => ({
          cells: [
            `${index === choice && r.entryId ? '>' : ' '} ${r.kind}`,
            r.status,
            r.partId &&
            r.partId !== 'question' &&
            items.find((item) => item.id === r.entryId)?.entry.question
              ? `  ${r.text}`
              : r.text,
          ],
          cellTones: { 0: index === choice && r.entryId ? 'selected' : 'plain', 1: r.tone },
          ...(r.entryId ? { choiceIndex: index } : {}),
        })),
      },
    };
    view.sections = [
      ...(engineView?.sections ?? [{ key: 'Material', label: 'Material', material: true }]),
      ...(engineView && state.projectReadingEntry()?.kind === 'corpus-contribution'
        ? [{ key: 'Material', label: 'Material', material: true }]
        : []),
      ...(meaningParts.length ? [meaning] : []),
      corpus,
    ];
    view.sectionIndex = state.projectReadingTab
      ? Math.max(
          0,
          view.sections.findIndex((s) => s.key === state.projectReadingTab),
        )
      : (engineView?.sectionIndex ?? 0);
    view.choiceIndex =
      state.projectReadingTab === 'Corpus' && revealCorpus
        ? choice
        : state.projectReadingTab === 'Meaning' && revealMeaning
          ? meaningChoice
          : state.projectReadingTab
            ? null
            : (engineView?.choiceIndex ?? null);
    view.selectedPartId = state.projectReadingTab === 'Meaning' ? part?.id : null;
    return view;
  }
  view.selectSection = (index) => {
    refresh();
    if (['Corpus', 'Meaning'].includes(view.sections[index]?.key) || view.sections[index]?.material)
      state.projectReadingTab = view.sections[index].key;
    else {
      state.projectReadingTab = null;
      engineView?.selectSection(index);
    }
    state.offset = 0;
    revealMeaning = view.sections[index]?.key === 'Meaning';
    revealCorpus = view.sections[index]?.key === 'Corpus';
    refresh();
  };
  view.onChoice = (index) => {
    if (state.projectReadingTab === 'Meaning') {
      meaningChoice = Math.max(0, Math.min(meaningParts.length - 1, index));
      state.offset = 0;
      revealMeaning = true;
      refresh();
      return;
    }
    if (state.projectReadingTab !== 'Corpus') return engineView?.onChoice(index);
    if (!rows[index]?.entryId) return;
    choice = Math.max(0, Math.min(rows.length - 1, index));
    revealCorpus = true;
    refresh();
  };
  view.consumeChoiceReveal = () => {
    revealMeaning = false;
    revealCorpus = false;
    engineView?.consumeChoiceReveal?.();
  };
  function actions() {
    if (!refresh()) return [];
    const choices = rows.flatMap((r, index) => (r.entryId ? [index] : []));
    const at = Math.max(0, choices.indexOf(choice));
    const command = (key, description, run, presentation = 'workspace') => ({
      key,
      description,
      run,
      presentation,
      pane: 'reading',
    });
    const turn = (delta) =>
      view.selectSection((view.sectionIndex + delta + view.sections.length) % view.sections.length);
    return [
      { ...command('RIGHT', 'tabs', () => turn(1)), displayKey: '←→' },
      command('LEFT', 'previous tab', () => turn(-1), 'choice'),
      ...(state.projectReadingTab === 'Meaning'
        ? ['UP', 'DOWN', 'HOME', 'END'].map((key) =>
            command(
              key,
              'select source',
              () =>
                view.onChoice(
                  key === 'HOME'
                    ? 0
                    : key === 'END'
                      ? meaningParts.length - 1
                      : meaningChoice + (key === 'UP' ? -1 : 1),
                ),
              'choice',
            ),
          )
        : []),
      ...(state.projectReadingTab === 'Corpus'
        ? [
            ...(choices.length ? ['UP', 'DOWN', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN'] : []).map(
              (key) =>
                command(
                  key,
                  'select material',
                  () =>
                    view.onChoice(
                      choices[
                        key === 'HOME'
                          ? 0
                          : key === 'END'
                            ? choices.length - 1
                            : Math.max(
                                0,
                                Math.min(
                                  choices.length - 1,
                                  at +
                                    (['UP', 'PAGE_UP'].includes(key) ? -1 : 1) *
                                      (key.startsWith('PAGE_')
                                        ? pageStep(state.viewport?.choiceHits, 'index')
                                        : 1),
                                ),
                              )
                      ],
                    ),
                  'choice',
                ),
            ),
            ...(rows[choice]?.entryId
              ? [
                  command(
                    'ENTER',
                    ['Statement', 'Conditional'].includes(rows[choice].kind)
                      ? 'inspect statement'
                      : rows[choice].kind === 'Question'
                        ? 'open question'
                        : 'open material',
                    () => {
                      const row = rows[choice];
                      const contribution = previousItems.find(
                        (item) => item.id === row.entryId,
                      )?.entry;
                      const part = contribution?.responses?.find(
                        (response) => response.id === row.partId,
                      );
                      const source =
                        ['Statement', 'Conditional'].includes(row.kind) &&
                        state
                          .projectOutline(null)
                          .find(
                            (item) =>
                              item.kind === 'material-concept' &&
                              item.partId === row.partId &&
                              item.contributionId === contribution.id &&
                              item.nodeId === part?.graph?.top,
                          );
                      const material =
                        source ||
                        (['Statement', 'Conditional'].includes(row.kind) &&
                          state
                            .projectOutline(null)
                            .find(
                              (item) =>
                                item.kind === 'material-concept' &&
                                item.contributionId === contribution.id &&
                                item.partId === row.partId,
                            ));
                      state.projectReadingTab = null;
                      state.selectProjectEntry(material?.id ?? row.entryId, { focus: 'reading' });
                      refresh();
                      if (material)
                        view.selectSection(view.sections.findIndex((s) => s.key === 'Meaning'));
                      else if (['Wording', 'Interpretation'].includes(row.kind))
                        view.selectSection(view.sections.findIndex((s) => s.key === 'Material'));
                    },
                  ),
                ]
              : []),
            command('n', 'add material', () => state.addCorpusMaterial()),
            command('d', 'new question', () => state.developQuestion({ question: '' })),
            command('a', 'ask corpus', () => state.startAsk({ fresh: true, resumeDraft: true })),
            ...(rows[choice]?.kind === 'Question'
              ? [
                  command('x', 'delete question', () =>
                    state.deleteProjectQuestion(
                      previousItems.find((item) => item.id === rows[choice].entryId),
                    ),
                  ),
                ]
              : []),
            ...(['Wording', 'Interpretation'].includes(rows[choice]?.kind) && rows[choice]?.partId
              ? [
                  command('x', 'withdraw connection', () => {
                    const row = rows[choice];
                    const contribution = previousItems.find(
                      (item) => item.id === row.entryId,
                    )?.entry;
                    state.withdrawDeclaration(contribution.id, row.partId);
                  }),
                ]
              : []),
          ]
        : []),
    ];
  }
  return { readingView: refresh, actions };
}
