/** Workspace and form rows, plus reading-pane wrapping. No I/O or mutations. */
import { relationReading } from './wording.mjs';
import { branch, treeRows, detailRows } from './tree.mjs';
import { projectEntryTree } from '../concepts/project-outline.mjs';
import { readingDevelopment } from './state.mjs';
import { graphEditorRows } from '../recordings/graph-preview.mjs';

import { engineSections } from '../engine/view.mjs';

export function createContent({ state, text, recordingContent, selectedConcept }) {
  const { row, labeledRow, wrap, sectionRows } = text;
  const { passageRows } = recordingContent;
  const tableRow = (table) => ({ ...row('', 'plain', 1), table });
  const tabsRow = (labels, selected) => ({
    ...row('', 'plain', 1),
    tabs: labels.map((label, index) => ({ label, index, active: index === selected })),
  });
  const relationTable = (groups) =>
    tableRow({
      headers: ['State', 'Inquiry relation'],
      widths: [16, null],
      minWidth: 48,
      repeatColumns: 1,
      groupColumns: [0],
      entries: groups.flatMap(([label, lines, tone]) =>
        lines.map((value) => ({ cells: [label, value], tone })),
      ),
    });
  const yesNoRows = (choice) => [
    row(`${choice.yes ? '●' : ' '} Yes`, choice.yes ? 'selected' : 'plain', 1),
    row(`${choice.yes ? ' ' : '●'} No`, choice.yes ? 'plain' : 'selected', 1),
  ];
  const sectionHeading = (label) => ({ ...row(label, 'section'), surface: text.background });
  const sectionValue = (section, entry, index) => {
    const item = entry[0] ? labeledRow([entry]) : row(entry[1], entry[2] ?? 'plain', 1);
    const choice = section.rowChoices?.find((choice) => choice.rowIndex === index);
    if (!choice) return item;
    return {
      ...item,
      text: `${choice.selected ? '›' : ' '} ${item.text}`,
      choiceIndex: choice.choiceIndex,
      tone: choice.selected ? 'selected' : item.tone,
      spans: choice.selected
        ? []
        : item.spans?.map((span) => ({ ...span, start: span.start + 2, end: span.end + 2 })),
      hangingIndent: (item.hangingIndent ?? 0) + 2,
    };
  };
  const sectionContent = (section) => [
    ...(section.heading ? [sectionHeading(section.heading)] : []),
    ...(section.rows ?? []).flatMap((entry, index) =>
      entry[2] === 'amr'
        ? [
            row(),
            ...(entry[0] ? [sectionHeading(entry[0])] : []),
            ...String(entry[1])
              .split('\n')
              .map((line) => ({ ...row(line, 'amr', 1), surface: text.sourceBand })),
          ]
        : [
            ...(section.rows[index - 1]?.[2] === 'amr' ? [row()] : []),
            sectionValue(section, entry, index),
          ],
    ),
    ...(section.rows?.length && (section.table || section.tables?.length) ? [row()] : []),
    ...(section.table ? [tableRow(section.table)] : []),
    ...(section.tables ?? []).flatMap((table) => [row(), tableRow(table)]),
    ...(section.graphLines ?? []).map((line) => ({
      ...row(line.text, 'amr', 1),
      spans: line.spans,
      surface: text.sourceBand,
    })),
    ...(section.groups ?? []).flatMap((group) => [row(), ...sectionContent(group)]),
  ];
  const sectionsContent = (view) => [
    ...(view.sections.length > 1
      ? [
          tabsRow(
            view.sections.map((item) => item.label),
            view.sectionIndex ?? 0,
          ),
          row(),
        ]
      : []),
    ...sectionContent(view.sections[view.sectionIndex ?? 0]),
  ];
  function projectRows() {
    const view = state.projectReadingView?.();
    if (!view) return selectedProjectRows();
    const section = view.sections[view.sectionIndex];
    if (!section.material) return sectionsContent(view);
    return [
      tabsRow(
        view.sections.map((s) => s.label),
        view.sectionIndex,
      ),
      row(),
      ...selectedProjectRows(),
    ];
  }
  function selectedProjectRows() {
    const item = state.projectReadingEntry?.();
    if (!state.help && item?.kind === 'workspace')
      return [
        row('Develop your corpus', 'section'),
        labeledRow([['Material', 'None']]),
        labeledRow([['Questions', 'None']]),
      ];
    if (!state.help && item?.kind === 'material-concept') {
      return [
        labeledRow([['State', item.materialState, item.open ? 'warning' : 'plain']]),
        ...(item.relation ? [labeledRow([['Relationship', item.relation]])] : []),
        ...(item.contextNote ? [labeledRow([['Context', item.contextNote, 'warning']])] : []),
        ...(item.referenceTo ? [labeledRow([['Reference', 'Shared participant']])] : []),
        row(),
        row('Saved Sources', 'section'),
        ...(item.question ? [labeledRow([['Question', item.question, 'input']])] : []),
        ...(item.partId !== 'question'
          ? [labeledRow([['Contribution', item.sourceText, 'input']])]
          : []),
        ...(item.children.length
          ? [
              row(),
              row('Relationships', 'section'),
              ...item.children.map((child) =>
                labeledRow([
                  [
                    child.contextLink ? 'Develops here' : (child.relation ?? 'Part'),
                    child.contextLink
                      ? child.question
                      : child.name + (child.referenceTo ? ' (shared reference)' : ''),
                    child.open ? 'warning' : 'plain',
                  ],
                ]),
              ),
            ]
          : []),
      ];
    }
    if (!state.help && item && item.kind !== 'concept') {
      if (item.currentRun && state.projectReadingTab !== 'Material')
        return sectionsContent(
          state.engineReadingView?.() ?? { sections: engineSections(item.currentRun, null, null) },
        );
      if (item.kind === 'group') return item.children.map((child) => row(child.label, 'plain', 1));
      const details = projectEntryTree(
        item,
        state.project.data,
        state.projectDetailMaterial,
        state.project.digest,
      );
      return detailRows(details, text);
    }
    const concept = selectedConcept();
    return [
      ...(concept.description
        ? [row('Description', 'section'), row(concept.description, 'plain', 1), row()]
        : []),
      ...(concept.passages.length
        ? [
            row('Sources', 'section'),
            ...concept.passages.flatMap((text, index) => [
              ...(index ? [row()] : []),
              row(text, 'input', 1),
            ]),
          ]
        : []),
    ];
  }
  // Stabilize only the source header, with a small cap on blank space.
  function findingsRows(view, width) {
    const rows = contentRows(view);
    if (
      !state.quitPrompt &&
      !state.form &&
      state.mode === 'recording' &&
      !state.help &&
      state.page === 'overview' &&
      !readingDevelopment(state) &&
      view.occurrence?.bindings?.length
    ) {
      const height = (items) => items.reduce((sum, item) => sum + wrap(item, width).length, 0);
      const own = height(passageRows([view.occurrence.sourceId]));
      const target = Math.min(
        6,
        Math.max(...view.occurrences.map((item) => height(passageRows([item.sourceId])))),
      );
      const at = rows.findIndex(
        (item) => item.tone === 'section' && item.text === 'Proposed binding',
      );
      if (at >= 0)
        rows.splice(at, 0, ...Array.from({ length: Math.max(0, target - own) }, () => row()));
    }
    return rows.flatMap((item) => wrap(item, width));
  }
  function contentRows(view) {
    // The pane owns the outer gutter. Rows already carry their semantic depth.
    return sectionRows([
      ...(state.failure && !state.form
        ? [row('Not applied', 'warning'), row(state.failure, 'plain', 1), row()]
        : []),
      ...pageRows(view),
    ]);
  }
  function inquiryContextRows() {
    const form = state.form;
    if (!form?.workspace) return [];
    const investigation = state.investigation?.data;
    const ask = investigation?.asks.find((item) => item.id === form.askId);
    const purpose = investigation?.intentions.find((item) => item.id === ask?.intentionId)?.text;
    const rows =
      purpose && purpose !== form.fields[0].value ? [labeledRow([['Purpose', purpose]])] : [];
    if (form.revisesRecording && form.revisesRecording.question !== form.fields[0].value)
      rows.push(labeledRow([['Recorded question', form.revisesRecording.question]]));
    const context = form.continuation,
      opening = form.origin?.opening ?? context?.opening;
    if (!opening) return rows;
    const graph =
      opening.kind === 'query'
        ? (context?.interpretedGraphs?.query ?? context?.parent.queryGraph)
        : (context?.interpretedGraphs?.source ?? context?.parent.sourceGraph);
    const sentence =
      opening.kind === 'query' ? context?.parent.question : context?.parent.source?.text;
    return [
      ...rows,
      labeledRow([
        [
          'Opening',
          graph && opening.edge
            ? relationReading(graph, opening.edge, sentence).label
            : opening.label,
        ],
      ]),
      ...(context?.parent.source
        ? [labeledRow([['Source', context.parent.source.text, 'input']])]
        : []),
      row(),
    ];
  }

  function pageRows(view) {
    if (state.quitPrompt) return yesNoRows(state.quitPrompt);
    if (state.help) {
      const shortcuts = new Map();
      for (const [key, label] of state.helpState?.actions ?? []) {
        if (['?', 'UP', 'DOWN', '↑↓', '↑/↓'].includes(key)) continue;
        const normalized = /^[A-Z]$/u.test(key)
          ? `shift+${key.toLowerCase()}`
          : key.toLowerCase().replaceAll('_', '+').replaceAll('-', '+');
        shortcuts.set(normalized === 'escape' ? 'esc' : normalized, label);
      }
      return [
        ...(state.mode === 'recording' && state.readOnlyRecording
          ? [row('Recording diagnostics (read-only)', 'section'), row()]
          : []),
        row('Shortcuts after closing help', 'section'),
        row(),
        ...[
          ['↑/↓', state.helpState?.selectable ? 'select item' : 'scroll'],
          ['Home/End', state.helpState?.selectable ? 'first/last item' : 'start/end of text'],
          [
            'PgUp/PgDn',
            state.helpState?.selectable ? 'previous/next page of items' : 'scroll page',
          ],
          ...shortcuts.entries(),
        ].map(([key, label]) => row(`${key}  ${label}`, 'plain', 1)),
      ];
    }
    const highlights = [
      ...(state.form?.highlights ?? []),
      ...(state.form?.move?.[state.form.index]?.highlights ?? []),
    ];
    const contextRows = [
      ...(state.form?.contextRows ?? []).flatMap((entry, index) => [
        ...(index && entry[2] === 'input' ? [row()] : []),
        labeledRow([entry], highlights),
      ]),
      ...(state.form?.contextDetails?.() ?? []).map((entry) => labeledRow([entry])),
    ];
    const caseRows = state.form?.caseSelection
      ? [
          row('Case', 'section'),
          labeledRow([
            [
              state.form.caseSelection.kind === 'authored' ? 'Text' : 'Role',
              state.form.caseSelection.label,
            ],
            ['Sentences', state.form.caseSelection.sources.length],
          ]),
          row(),
        ]
      : [];
    const errors = state.form?.error
      ? [
          row(),
          labeledRow([['Problem', state.form.error, 'error']]),
          ...(state.form.recovery?.state || state.form.recovery?.saved
            ? [
                labeledRow([
                  ['Saved', state.form.recovery.state ?? 'Material saved; assessment incomplete'],
                ]),
              ]
            : []),
        ]
      : [];
    if (state.form?.graphEditor)
      return [
        ...contextRows,
        ...(contextRows.length ? [row()] : []),
        ...graphEditorRows(state.form, text),
        ...errors,
      ];

    if (state.form?.investigationBrowser) {
      const form = state.form;
      return [
        ...(form.browserRows ?? []).map((entry) => labeledRow([entry])),
        ...(form.browserOpenings?.length
          ? [row(), relationTable([['Open', form.browserOpenings, 'plain']])]
          : []),
        ...(form.browserChanges?.length
          ? [
              row('Pending source changes', 'section'),
              ...treeRows(
                form.browserChanges.map((value) => branch('Source', value, [], 'input')),
                text,
              ),
            ]
          : []),
        ...errors,
      ];
    }
    if (state.form?.sections) {
      return [
        ...contextRows,
        ...(contextRows.length ? [row()] : []),
        ...sectionsContent(state.form),
        ...errors,
      ];
    }
    if (state.form?.interpretationView) {
      const {
        basis = [],
        changes,
        changeLabel,
        metrics,
        groups,
        partial,
      } = state.form.interpretationView;
      return [
        ...contextRows,
        row(),
        ...(basis.length || changes.length
          ? [
              row('Changes', 'section'),
              ...treeRows(
                [
                  ...basis.map(([label, value]) =>
                    branch(label, value, [
                      branch('State', 'Applied', [], 'located'),
                      branch('Scope', 'Recorded comparison'),
                    ]),
                  ),
                  ...changes.map(([label, value]) =>
                    branch(label, value, [
                      branch(
                        'State',
                        changeLabel === 'Accepted changes'
                          ? 'Accepted'
                          : label.startsWith('Remove ')
                            ? 'Remove on accept'
                            : 'Proposed',
                      ),
                      branch('Scope', 'Recorded comparison'),
                    ]),
                  ),
                ],
                text,
              ),
            ]
          : []),
        ...(metrics.length ? [row(), labeledRow(metrics)] : []),
        ...(partial ? [row('Partial search', 'warning', 1)] : []),
        ...(groups.length ? [row(), relationTable(groups)] : []),
        ...errors,
      ];
    }
    if (state.form?.changeTree)
      return [...contextRows, row(), ...treeRows(state.form.changeTree, text), ...errors];
    if (state.form?.inspectRows) {
      const groups = [];
      for (const [label, value, tone = 'plain'] of state.form.inspectRows) {
        if (groups.at(-1)?.label === label && groups.at(-1).tone === tone)
          groups.at(-1).values.push(value);
        else groups.push({ label, values: [value], tone });
      }
      return groups
        .flatMap(({ label, values, tone }, index) => [
          ...(index &&
          (values.length > 1 ||
            groups[index - 1].values.length > 1 ||
            tone === 'input' ||
            groups[index - 1].tone === 'input')
            ? [row()]
            : []),
          ...(values.length === 1
            ? [labeledRow([[label, values[0], tone]])]
            : [
                tableRow({
                  headers: [label],
                  widths: [null],
                  minWidth: 0,
                  repeatColumns: 0,
                  entries: values.map((value) => ({ cells: [value], tone })),
                }),
              ]),
        ])
        .concat(state.form.yesNo ? [row(), ...yesNoRows(state.form.yesNo)] : [], errors);
    }
    if (state.form?.busy && state.form.roleStatements)
      return [
        ...contextRows.slice(0, 1),
        row(),
        row('Saving statements', 'section'),
        labeledRow([['Progress', state.form.progress ?? 'Reading your changes']]),
        row(
          state.form.committing ? 'Finishing the save.' : 'All edits are saved together.',
          'muted',
          1,
        ),
      ];
    if (state.form?.busy)
      return [
        ...(state.form.workspace ? caseRows : contextRows),
        ...(state.form.fields[0] ? [labeledRow([['Inquiry', state.form.fields[0].value]])] : []),
        ...(state.form.workspace ? contextRows : []),
        labeledRow([['State', state.form.phase ?? 'Running']]),
        ...(state.form.progress ? [labeledRow([['Progress', state.form.progress]])] : []),
      ];

    if (state.form?.move)
      return [
        ...contextRows,
        ...(contextRows.length ? [row()] : []),
        ...(state.form.selectors
          ? [
              tableRow({
                headers: ['Selector', 'Selection'],
                widths: [19, null],
                minWidth: 40,
                repeatColumns: 0,
                entries: state.form.selectors.map((selector, index) => ({
                  cells: [
                    `${index === state.form.selectorIndex ? '●' : ' '} ${selector.label}`,
                    selector.selected?.label ??
                      (index === state.form.selectorIndex
                        ? state.form.move[state.form.index].label
                        : 'Select wording'),
                  ],
                  selectorIndex: index,
                  tone: index === state.form.selectorIndex ? 'plain' : 'muted',
                })),
              }),
              row(),
              row(state.form.selectors[state.form.selectorIndex].label, 'section'),
            ]
          : []),
        ...state.form.move.flatMap((choice, i) => [
          ...(choice.group &&
          choice.group !== state.form.move[i - 1]?.group &&
          (choice.group !== 'Actions' || i > 0)
            ? [...(i ? [row()] : []), row(choice.group, 'section')]
            : []),
          {
            ...row(
              `${i === state.form.index ? '●' : ' '} ${choice.label}`,
              i === state.form.index
                ? 'selected'
                : (choice.tone ?? (choice.presentation === 'choice' ? 'muted' : 'plain')),
              1,
            ),
            choiceIndex: i,
          },
          ...(choice.summary ?? []).map((entry) => ({
            ...labeledRow([entry]),
            indent: 3,
            choiceIndex: i,
          })),
          ...(choice.tree?.length && !choice.collapsed && i === state.form.index
            ? choice.tree.some((node) => node.section)
              ? detailRows(choice.tree, text, { choiceIndex: i })
              : treeRows(choice.tree, text, { indent: 2, choiceIndex: i })
            : []),
        ]),
        ...(state.form.detailsOpen && state.form.move[state.form.index]?.details?.length
          ? [
              row(),
              tableRow({
                headers: ['Detail', 'Value'],
                widths: [14, null],
                minWidth: 42,
                repeatColumns: 1,
                groupColumns: [0],
                entries: state.form.move[state.form.index].details.flatMap(([label, lines]) =>
                  lines.map((value) => ({ cells: [label, value], tone: 'muted' })),
                ),
              }),
            ]
          : []),
        ...errors,
      ];
    if (state.form?.confirm)
      return [row(state.form.fields[0]?.label ?? '', 'plain', 1), row(), ...errors];
    if (state.form)
      return [
        ...(state.form.readOnly ? errors : []),
        ...caseRows,
        ...(!state.form.workspace ? contextRows : []),
        ...inquiryContextRows(),
        ...(!state.form.workspace && contextRows.length ? [row()] : []),
        ...(state.form.readOnly ? [row('Unsaved draft', 'section')] : []),
        ...state.form.fields.flatMap((field, i) => {
          return [
            row(`${field.label}:`, 'muted', 1),
            {
              ...row(
                field.value,
                !state.form.readOnly && i === state.form.index ? 'selected' : 'plain',
                1,
              ),
              field,
              active: !state.form.readOnly && i === state.form.index,
            },
            row(),
          ];
        }),
        ...(state.form.workspace ? contextRows : []),
        ...(!state.form.readOnly ? errors : []),
      ];
    if (state.mode === 'project' || readingDevelopment(state)) return projectRows();
    if (state.mode === 'home' && state.projectChoices) {
      const chosen = state.projectChoices[state.homeIndex];
      return [
        row(chosen?.name ?? 'Another location', 'section'),
        row(chosen?.path ?? state.projectLocation, 'muted', 1),
        row(),
        ...(chosen
          ? [
              row(
                chosen.error ??
                  (chosen.contributionCount
                    ? `${chosen.contributionCount} corpus ${chosen.contributionCount === 1 ? 'contribution' : 'contributions'}`
                    : `${chosen.count} ${chosen.count === 1 ? 'role' : 'roles'}`),
                chosen.error ? 'warning' : 'plain',
                1,
              ),
            ]
          : []),
      ];
    }
    if (state.mode === 'home')
      return [
        row(state.homeIndex === 0 ? 'New project' : 'Open project', 'section'),
        row(),
        tableRow({
          headers: ['Field', 'Value'],
          widths: [16, null],
          minWidth: 45,
          repeatColumns: 0,
          rowSpacing: 1,
          entries: (state.homeIndex === 0
            ? [
                ['Project name', 'Required'],
                ['Directory', 'New project folder'],
                ['Top role', 'Optional'],
              ]
            : [
                ['Location', state.projectLocation],
                ['Projects', 'Saved roles, statements and questions'],
              ]
          ).map((cells) => ({ cells })),
        }),
      ];
    return recordingContent.pageRows(view);
  }

  return { contentRows, findingsRows };
}
