/** Compose and draw a terminal frame, retaining viewport geometry for input. */
import { projectInterpretations } from '../../recording/interpretation.mjs';
import terminalKit from 'terminal-kit';
import { paneActions } from './pane-actions.mjs';
import { relative } from 'node:path';
import { projectTree } from '../../project/authoring/project.mjs';
import { layoutPane, layoutFooter, sidebarSize, scrollThumb } from './layout.mjs';
import {
  viewModel,
  rankedFindings,
  routePresentation,
  findingSummary,
  sliceHighlights,
} from '../recordings/view.mjs';
import { pageLabels, readingDevelopment, hasRecordingProject } from './state.mjs';
import { currentRun } from '../inquiries/inquiry-groups.mjs';
import { placementLabel } from '../concepts/placement-label.mjs';

/** DEC 2026 prevents the terminal from displaying an incomplete frame, even
 * when one write is split across PTY reads. Unsupported private modes are ignored.
 * https://ghostty.org/docs/help/synchronized-output
 */
export function writeTerminalFrame(term, frame) {
  term.raw(`\x1b[?2026h${frame}\x1b[?2026l`);
}

export function createRenderer({
  state,
  term,
  text,
  noColor,
  contentRows,
  findingsRows,
  bindingMarks,
  recordingNavigation,
  homeLabels,
  selectedConcept,
  projectActionEnabled,
  canDeleteSentence,
  updatePointer,
}) {
  const {
    row,
    shortcutRow,
    wrap,
    pack,
    fit,
    paint,
    progressHeader,
    background,
    sidebar,
    headerBand,
  } = text;
  let previousFrame = null,
    previousReadingGeometry = null;
  function writeFrame(frame) {
    // Trackpad momentum keeps arriving at scroll edges. Identical frames must
    // not repaint the screen or hide/show an unchanged editor caret.
    if (frame === previousFrame) return;
    writeTerminalFrame(term, frame);
    previousFrame = frame;
  }
  function invalidate() {
    previousFrame = null;
  }
  function draw() {
    if (state.closed) return;
    if (state.mode === 'recording')
      state.ix = projectInterpretations(state.ix, state.interpretationDecisions);
    if (state.mode === 'recording')
      state.ix.answerKnowledge =
        state.answerKnowledge?.recording === state.ix.recording
          ? state.answerKnowledge.knowledge
          : state.ix.recording.knowledge;
    if (
      state.mode === 'recording' &&
      state.findingsList &&
      !rankedFindings(state.ix, state.interpretationDecisions).length
    )
      state.findingsList = false;
    const terminalWidth = Math.max(1, term.width ?? 80);
    const width = Math.max(1, terminalWidth - 1);
    const height = Math.max(1, term.height ?? 24);
    if (width < 48 || height < 16) {
      state.animatedHeader = null;
      state.viewport = null;
      updatePointer('default');
      const compact = ['Window too small', '49 × 16', 'ctrl+c quit'];
      writeFrame(
        '\x1b[H\x1b[2J' +
          compact
            .slice(0, height)
            .map((text, i) => `\x1b[${i + 1};1H${paint(fit(text, width))}`)
            .join(''),
      );
      return;
    }
    const engineActivity = state.engineActivity?.();
    const workflow = state.workflow?.active();
    const spacious = height >= 30;
    const headingWidth = width - 2;
    const projectNavigation =
      state.mode === 'project' || Boolean(state.form && state.projectTreeReturn);
    const developmentReading = readingDevelopment(state);
    const investigationBrowser = state.form?.investigationBrowser;
    const tree = projectNavigation
      ? state.form?.workspace
        ? projectTree(state.project.data).map((item) => ({
            ...item,
            id: item.placement.id,
            kind: 'concept',
            label: item.concept.name,
          }))
        : state.projectConceptOutline()
      : [];
    const view =
      state.mode === 'recording'
        ? viewModel(state.ix, { ...state.selection, detail: state.page })
        : null;
    const projectPath = projectNavigation
      ? !workflow && state.projectReadingTab === 'Corpus' && !state.form
        ? 'Complete project corpus'
        : (!state.form?.workspace && state.projectConceptPath?.()) ||
          placementLabel(state.project.data, state.placementId)
      : '';
    const routeVisits = view?.visit ? [view.visit] : (view?.visits ?? []);
    const route = projectNavigation
      ? {
          text: projectPath,
          selectedSpans: [
            {
              start: projectPath.includes(' → ') ? projectPath.lastIndexOf(' → ') + 3 : 0,
              end: projectPath.length,
            },
          ],
        }
      : view
        ? routePresentation(state.ix, routeVisits)
        : { text: '', selectedSpans: [] };
    const routeRows =
      state.mode === 'home'
        ? []
        : wrap(
            {
              ...row(route.text, 'muted'),
              spans: route.selectedSpans.map((span) => ({ ...span, tone: 'plain' })),
            },
            headingWidth,
          );
    const headerHeight = (spacious ? 4 : 3) + routeRows.length;
    const navigation = investigationBrowser
      ? { ids: state.form.move.map((_, index) => index) }
      : projectNavigation
        ? { ids: tree.map((item) => item.id) }
        : state.mode === 'recording'
          ? recordingNavigation()
          : { ids: homeLabels().map((_, i) => i) };
    const selectedId = investigationBrowser
      ? state.form.index
      : projectNavigation
        ? state.form?.workspace
          ? state.placementId
          : (state.selectedConceptEntry?.()?.id ?? state.placementId)
        : state.mode === 'recording'
          ? state.findingsList
            ? state.selection.occurrenceId
            : state.selection.nodeId
          : state.homeIndex;
    const sidebarWidth =
      !investigationBrowser && state.expandReading && state.focus === 'reading'
        ? 0
        : sidebarSize(width, state.preferredSidebar);
    const showNodes =
      !sidebarWidth && ['nodes', 'development', 'recordings'].includes(state.focus) && !state.help;
    const readingArea = Math.max(1, width - (sidebarWidth ? sidebarWidth + 1 : 0));
    const padding = readingArea >= 30 ? 1 : 0;
    const readingWidth = Math.max(1, readingArea - 2 - padding * 2);
    const guide =
      !state.quitPrompt &&
      state.mode === 'recording' &&
      !state.form &&
      !state.help &&
      !developmentReading;
    const paneTitle = state.quitPrompt
      ? 'Quit'
      : state.form
        ? state.form.title
        : state.mode === 'home'
          ? 'Projects'
          : state.mode === 'project' || developmentReading
            ? state.help
              ? 'Help'
              : !workflow && state.projectReadingTab === 'Corpus'
                ? 'Corpus'
                : workflow
                  ? (state.workflow.readingView()?.title ?? 'Develop question')
                  : state.engineReadingView?.()
                    ? 'Question result'
                    : (state.projectReadingEntry()?.label ?? selectedConcept().name).replace(
                        /^(\s*)(\p{L})/u,
                        (_, space, letter) => space + letter.toLocaleUpperCase(),
                      )
            : state.help
              ? 'Help'
              : state.page === 'setup'
                ? `Recorded inputs - ${state.ix.recording.sources.length} sentences`
                : `${view.node.label} - ${pageLabels[state.page]}`;
    const eventNavigation =
      guide && state.page !== 'setup' && view.occurrences.length > 1
        ? `${state.focus === 'reading' ? '← ' : ''}findings ${view.occurrences.findIndex((item) => item.id === view.occurrence?.id) + 1}/${view.occurrences.length}${state.focus === 'reading' ? ' →' : ''}`
        : '';
    const wrapped = findingsRows(view, readingWidth);
    const readingTabs = [];
    while (wrapped[0]?.sectionChoices) readingTabs.push(wrapped.shift());
    if (readingTabs.length && !wrapped[0]?.text) wrapped.shift();
    const relationMarks = new Set(wrapped.map((item) => item.relationMark));
    const graphLegend = guide
      ? pack(
          [
            ...Object.entries({
              '=': 'located',
              '?': 'open',
              '≠': 'alternative',
              '-': 'not examined',
            })
              .filter(([mark]) => relationMarks.has(mark))
              .map(([mark, label]) => `${mark} ${label}`),
            ...(wrapped.some(
              (item) => item.spans?.some((span) => span.color !== undefined) || item.nodes?.length,
            )
              ? ['underlined: proposed binding']
              : []),
          ],
          readingWidth,
        )
      : [];
    const ancestors = [],
      seenForms = new Set();
    for (let form = state.form?.back?.form; form && !seenForms.has(form); form = form.back?.form) {
      seenForms.add(form);
      if (ancestors[0] !== form.title) ancestors.unshift(form.title);
    }
    const readingHeadingRows = [
      {
        ...row(
          (noColor && state.focus === 'reading' ? '› ' : '') +
            (investigationBrowser ? 'Inquiry' : paneTitle),
          'title',
        ),
        right: eventNavigation,
      },
      row(),
      ...readingTabs,
      ...(readingTabs.length ? [row()] : []),
      ...(ancestors.length
        ? [...wrap(row(` ${ancestors.join(' › ')}`, 'muted'), readingWidth), row()]
        : []),
    ];
    const controls = paneActions({
      state,
      view,
      projectActionEnabled,
      canDeleteSentence: Boolean(state.form && canDeleteSentence()),
    });
    state.helpActionChoices = [...(controls[state.focus] ?? []), ...controls.global];
    const actionRow = (label, actions, inset = '') => {
      const item = shortcutRow(label, actions, inset);
      item.actions = actions.filter((action) => item.text.includes(action.label));
      return item;
    };
    const controlRows = (pane, availableWidth) => {
      if (workflow && !state.form && state.focus !== pane) return [];
      const inset = pane === 'reading' ? '' : ' ';
      const controlsWidth = Math.max(1, availableWidth - inset.length);
      if (pane === 'reading' && controls.formSections) {
        const formRow = (label, actions) =>
          state.focus === 'reading' ? actionRow(label, actions) : row();
        const groupGap = '      ';
        const sectionLabel = (section, labels) => `${section.title}  ${labels.join('   ')}`;
        const reservedLine = controls.formSections
          .map((section) => sectionLabel(section, section.reserve))
          .join(groupGap);
        if (terminalKit.stringWidth(reservedLine) <= controlsWidth) {
          const label = controls.formSections
            .map((section) =>
              sectionLabel(
                section,
                section.actions.map((item) => item.label),
              ),
            )
            .join(groupGap);
          return [formRow(label, controls.reading)];
        }
        const prefixWidth =
          Math.max(...controls.formSections.map((section) => section.title.length)) + 2;
        const groupWidth = Math.max(1, controlsWidth - prefixWidth);
        return controls.formSections.flatMap((section) => {
          const labels = pack(
            section.actions.map((item) => item.label),
            groupWidth,
          );
          const reserved = pack(section.reserve, groupWidth).length;
          return [...labels, ...Array(Math.max(0, reserved - labels.length)).fill('')].map(
            (label, i) =>
              formRow(
                `${i === 0 ? section.title.padEnd(prefixWidth) : ' '.repeat(prefixWidth)}${label}`,
                section.actions,
              ),
          );
        });
      }
      const actions = controls[pane].map((item) => {
        if (!workflow || state.form || pane !== 'reading' || controlsWidth >= 60) return item;
        const description =
          {
            'select row': 'select',
            'read selected text': 'read text',
            'follow selected role': 'follow role',
            'ask here': 'ask',
            'expand reading': 'expand',
            'split panes': 'split',
            'close question': 'close',
          }[item.description] ?? item.description;
        return { ...item, description, label: `${item.key} ${description}` };
      });
      const labels = pack(
        actions.filter((item) => !item.helpOnly).map((item) => item.label),
        controlsWidth,
      );
      const reserved =
        workflow && !state.form
          ? labels.length
          : pack(controls.reserves[pane], controlsWidth).length;
      return [...Array(Math.max(0, reserved - labels.length)).fill(''), ...labels].map((label) =>
        actionRow(label, actions, label ? inset : ''),
      );
    };
    const readingControls = controlRows('reading', readingWidth);
    if (graphLegend.length) {
      const last = readingControls.at(-1);
      if (last) {
        const available = readingWidth - terminalKit.stringWidth(last.text) - 2;
        if (available >= 4) {
          const legend = fit(graphLegend.join('   '), available).trimEnd();
          last.text +=
            ' '.repeat(
              readingWidth - terminalKit.stringWidth(last.text) - terminalKit.stringWidth(legend),
            ) + legend;
        }
      }
    }
    const bottomRows = readingControls;
    const allGlobal = controls.global.map((item) => item.label);
    const globalLabels =
      pack(allGlobal, width - 18).length > 1
        ? controls.global.filter((item) => !item.optional).map((item) => item.label)
        : allGlobal;
    const footerLayout = layoutFooter({
      width,
      actions: globalLabels,
      reserve: globalLabels,
      pack,
      // Fit the status message in the space the shortcuts leave, without rewrapping them.
      statusWidth: engineActivity
        ? Math.min(72, Math.floor(width / 2))
        : Math.max(
            16,
            Math.min(
              Math.floor(width / 2),
              width - terminalKit.stringWidth(pack(globalLabels, width)[0] ?? '') - 4,
              terminalKit.stringWidth(state.notice ?? '') + 2,
            ),
          ),
    });
    const bodyHeight = height - headerHeight - footerLayout.rows.length;
    let readingPane = layoutPane({
      height: bodyHeight,
      header: readingHeadingRows,
      content: wrapped,
      pinned: bottomRows,
      offset: state.offset,
      minimumContentRows: state.form || state.quitPrompt ? 2 : 4,
    });
    const { rows: footer, actionWidth: footerWidth, statusWidth } = footerLayout;
    const { visibleRows } = readingPane;
    const treeById = new Map(tree.map((item) => [item.id, item]));
    const nodeContent = investigationBrowser
      ? state.form.move.flatMap((choice, index) => {
          const ask = choice.ask;
          const placement = state.project.data.placements.find(
            (item) => item.id === ask?.scopePlacementId,
          );
          const scope =
            state.project.data.concepts.find((item) => item.id === placement?.conceptId)?.name ??
            ask?.scopePlacementId;
          const available = Math.max(1, (sidebarWidth || readingArea) - 4);
          return [
            ...wrap(
              {
                ...row(
                  `${index === state.form.index ? '●' : ' '} ${choice.label}`,
                  index === state.form.index ? 'selected' : 'plain',
                  1,
                ),
                hangingIndent: 2,
              },
              available,
            ),
            ...wrap(
              row(
                [
                  currentRun(ask) ? 'recorded' : 'draft',
                  scope,
                  ask?.caseSelection ? `case: ${ask.caseSelection.label}` : '',
                ]
                  .filter(Boolean)
                  .join(' - '),
                'muted',
                3,
              ),
              available,
            ),
            row(),
          ].map((item) => ({ ...item, surface: sidebar, navigationId: index }));
        })
      : !projectNavigation && state.mode === 'recording' && state.findingsList
        ? rankedFindings(state.ix, state.interpretationDecisions).flatMap((item) => {
            const selected = item.id === state.selection.occurrenceId;
            const width = Math.max(1, (sidebarWidth || readingArea) - 3);
            // Align the highlight with the heading without moving indented detail text.
            const detail = (value, indent = 4) =>
              wrap(row(value, selected ? 'selected' : 'muted', indent), width).map((line) =>
                selected ? { ...line, selectionInset: 3 } : line,
              );
            const routeRows = [];
            let line = '',
              indent = 4;
            for (const label of item.route.slice(0, -1)) {
              const next = line ? `${line} → ${label}` : label;
              if (line && terminalKit.stringWidth(next) > width - indent) {
                routeRows.push(...detail(line, indent));
                line = `→ ${label}`;
                indent = 5;
              } else line = next;
            }
            if (line) routeRows.push(...detail(line, indent));
            return [
              row(
                ` ${selected ? '●' : ' '} ${state.ix.nodes.get(item.nodeId).label}`,
                selected ? 'selected' : 'plain',
              ),
              ...detail(
                `${item.matched} source matches${item.carried ? ` - ${item.carried} carried` : ''} - ${item.caseLinked} case-supported - ${item.unresolved} unmatched here${item.complete ? '' : ' - partial search'}`,
              ),
              ...(item.interpretationState
                ? detail(`Interpretation - ${item.interpretationState}`)
                : []),
              ...routeRows,
              row(),
            ].map((line) => ({ ...line, surface: sidebar, navigationId: item.id }));
          })
        : navigation.ids
            .map((id) => {
              if (state.mode === 'home')
                return row(
                  ` ${id === state.homeIndex ? '●' : ' '} ${homeLabels()[id]}`,
                  id === state.homeIndex ? 'selected' : 'plain',
                );
              if (projectNavigation) {
                const item = treeById.get(id);
                const linked = state.linkedProjectConcepts?.().has(id);
                const marker = workflow
                  ? ' '
                  : item.children?.length
                    ? state.projectExpanded.has(id)
                      ? '▾'
                      : '▸'
                    : linked
                      ? '→'
                      : ' ';
                const label = item.label;
                return row(
                  ` ${'  '.repeat(Math.min(item.depth, 6))}${id === selectedId ? '●' : marker} ${!workflow && id === selectedId && item.children?.length ? `${marker} ` : ''}${label}`,
                  id === selectedId
                    ? 'selected'
                    : linked
                      ? 'input'
                      : item.open
                        ? 'warning'
                        : 'plain',
                );
              }
              const node = state.ix.nodes.get(id);
              const out = view.node.crossingIds.includes(id),
                incoming = node.crossingIds.includes(state.selection.nodeId);
              const crossing =
                id === state.selection.nodeId
                  ? '●'
                  : state.page === 'setup'
                    ? ' '
                    : out && incoming
                      ? '↔'
                      : out
                        ? '→'
                        : incoming
                          ? '←'
                          : ' ';
              return row(
                ` ${crossing} ${node.label}`,
                id === state.selection.nodeId ? 'selected' : 'plain',
              );
            })
            .flatMap((item, i) =>
              (workflow
                ? wrap(
                    {
                      ...item,
                      hangingIndent:
                        3 + 2 * Math.min(treeById.get(navigation.ids[i])?.depth ?? 0, 6),
                    },
                    Math.max(1, (sidebarWidth || width) - 4),
                  )
                : [item]
              ).map((line) => ({ ...line, surface: sidebar, navigationId: navigation.ids[i] })),
            );
    const selectedIndex = nodeContent.findIndex((item) => item.navigationId === selectedId);

    const leftWidth = Math.max(1, (sidebarWidth || width) - 2);
    const leftContentWidth = Math.max(1, leftWidth - 1);
    const nodeControls = controlRows('nodes', leftWidth);
    const recordingControls = controlRows('recordings', leftWidth);
    const recordingsAvailable =
      !workflow && state.project && (state.mode === 'project' || hasRecordingProject(state));
    // Roles get room for their tree and hints before Development, up to 60%.
    const minimumNodeHeight = workflow
      ? Math.max(
          10,
          Math.floor(bodyHeight * 0.48),
          Math.min(nodeContent.length + nodeControls.length + 4, Math.floor(bodyHeight * 0.6)),
        )
      : Math.max(8, nodeControls.length + 8);
    const developmentItems =
      (projectNavigation || hasRecordingProject(state)) &&
      (workflow || !state.form?.workspace) &&
      !investigationBrowser
        ? state.projectDevelopmentOutline()
        : [];
    const compactSidebar = workflow && (!sidebarWidth || bodyHeight < 16);
    const developmentHeight = compactSidebar
      ? state.focus === 'development' && !state.help
        ? bodyHeight
        : 0
      : (workflow ||
            developmentItems.length ||
            (hasRecordingProject(state) && !state.form?.workspace && !investigationBrowser)) &&
          (workflow || state.projectPanel !== 'recordings') &&
          bodyHeight >= 16
        ? developmentItems.length
          ? Math.max(
              8,
              Math.min(
                bodyHeight - minimumNodeHeight,
                Math.round(bodyHeight * state.developmentFraction),
              ),
            )
          : Math.min(10, Math.max(8, Math.floor(bodyHeight * 0.32)))
        : 0;
    const developmentSelected = state.selectedDevelopmentEntry?.()?.id;
    const developmentContent = developmentItems.flatMap((item, index) => {
      if (workflow) {
        const selected = item.id === developmentSelected;
        const lines = [
          ...wrap(
            {
              ...row(` ${selected ? '●' : ' '} ${item.question}`, selected ? 'selected' : 'plain'),
              hangingIndent: 3,
            },
            leftContentWidth,
          ),
          ...wrap(
            row(
              `${item.scope}${item.caseSelection ? ` / ${item.caseSelection.label ?? item.caseSelection}` : ''}`,
              'muted',
              3,
            ),
            leftContentWidth,
          ),
        ].map((line, i, lines) => ({
          ...line,
          surface: sidebar,
          developmentId: item.id,
          groupStart: i === 0,
          keepWithNext: i < lines.length - 1,
        }));
        return [...(index ? [{ ...row(), surface: sidebar }] : []), ...lines];
      }
      const marker = item.children?.length ? (state.projectExpanded.has(item.id) ? '▾' : '▸') : ' ';
      const selected = item.id === developmentSelected;
      const prefix = `${' '.repeat(item.depth)}${selected ? '●' : marker} ${selected && item.children?.length ? marker + ' ' : ''}`;
      const label = ` ${prefix}${item.label}`;
      const heading =
        item.section !== developmentItems[index - 1]?.section
          ? [
              ...(index ? [{ ...row(), surface: sidebar }] : []),
              ...wrap(row(` ${item.section}`, 'plain'), leftContentWidth).map((line) => ({
                ...line,
                surface: sidebar,
                developmentHeadingFor: item.id,
              })),
            ]
          : [];
      return [
        ...heading,
        ...wrap(
          {
            ...row(label, selected ? 'selected' : 'plain'),
            hangingIndent: prefix.length + 1,
          },
          leftContentWidth,
        ).map((line) => ({ ...line, surface: sidebar, developmentId: item.id })),
        ...wrap(
          {
            ...row(`     State: ${item.materialState}`, item.stateTone ?? 'muted'),
            hangingIndent: 5,
          },
          leftContentWidth,
        ).map((line) => ({ ...line, surface: sidebar, developmentId: item.id })),
      ];
    });
    if (workflow && !developmentItems.length)
      developmentContent.push(
        ...wrap({ ...row(' No questions yet.', 'muted'), hangingIndent: 1 }, leftContentWidth),
      );
    const developmentPane = layoutPane({
      height: developmentHeight,
      header: [
        row(noColor && state.focus === 'development' ? ' › Development' : ' Development', 'title'),
        row(),
      ],
      content: developmentContent,
      pinned: controlRows('development', leftWidth),
      offset: state.developmentOffset ?? 0,
      minimumContentRows: 2,
      groupStarts: workflow
        ? developmentContent.flatMap((line, i) => (line.groupStart ? [i] : []))
        : [],
      // No selection must not match separator rows whose IDs are also absent.
      // Such a false match scrolls a long first question to its detached tail.
      selectedIndex: developmentSelected
        ? developmentContent.findIndex((item) => item.developmentId === developmentSelected)
        : null,
      selectedContextIndex: developmentSelected
        ? developmentContent.findIndex((item) => item.developmentHeadingFor === developmentSelected)
        : null,
      selectedEndIndex: developmentSelected
        ? developmentContent.findLastIndex((item) => item.developmentId === developmentSelected)
        : null,
    });
    state.developmentOffset = developmentPane.offset;
    const recordingsHeight =
      !developmentHeight &&
      recordingsAvailable &&
      state.recordingsVisible &&
      bodyHeight >= 12 &&
      state.recordings.length &&
      !state.form?.workspace &&
      !investigationBrowser
        ? Math.max(
            6,
            Math.min(
              Math.max(6, bodyHeight - minimumNodeHeight),
              Math.round(bodyHeight * state.recordingsFraction),
            ),
          )
        : 0;
    const conceptsHeight = bodyHeight - recordingsHeight - developmentHeight;
    state.recordingIndex = Math.max(0, Math.min(state.recordings.length - 1, state.recordingIndex));
    const recordingContent = state.recordings.flatMap((entry, index) => {
      const selected = state.mode === 'recording' && state.activeRecordingPath === entry.path;
      const highlighted = state.focus === 'recordings' ? index === state.recordingIndex : selected;
      const version =
        entry.revision === state.project.digest
          ? 'current'
          : `older - ${entry.revision?.slice(0, 8) ?? 'unknown'}`;
      const title = wrap(
        row(entry.query, highlighted ? 'selected' : 'plain'),
        Math.max(1, leftContentWidth - 3),
      ).map((line, i) => ({
        ...line,
        text: `${i ? '   ' : ` ${selected ? '▶' : highlighted ? '›' : ' '} `}${line.text}`,
      }));
      const metadata = wrap(
        row(
          `${entry.file.slice(5, 16).replace('T', ' ')} - ${version}`,
          highlighted ? 'selected' : 'muted',
          3,
        ),
        leftContentWidth,
      );
      return [...title, ...metadata, row()].map((line) => ({
        ...line,
        surface: sidebar,
        recordingPath: entry.path,
        recordingIndex: index,
      }));
    });
    const recordingsPane = layoutPane({
      height: recordingsHeight,
      pinned: recordingControls,
      minimumContentRows: 1,
      header: [row(' Recordings', 'title'), row()],
      content: recordingContent,
      offset: state.recordingsOffset,
      selectedIndex:
        state.focus === 'recordings' && state.recordings.length
          ? recordingContent.findIndex((item) => item.recordingIndex === state.recordingIndex)
          : null,
      selectedEndIndex:
        state.focus === 'recordings' && state.recordings.length
          ? recordingContent.findLastIndex(
              (item) => item.recordingIndex === state.recordingIndex && item.text.trim(),
            )
          : null,
    });
    state.recordingsOffset = recordingsPane.offset;
    const nodeHeadingRows = [
      row(
        investigationBrowser
          ? ` ${state.form.title}`
          : projectNavigation
            ? workflow
              ? noColor && state.focus === 'nodes'
                ? ' › Roles'
                : ' Roles'
              : ' Concepts'
            : state.mode === 'home'
              ? ' Projects'
              : state.findingsList
                ? ' Findings - ranked'
                : ' Nodes',
        'title',
      ),
      row(),
    ];
    const nodePane = layoutPane({
      height: conceptsHeight,
      header: nodeHeadingRows,
      content: nodeContent,
      pinned: nodeControls,
      // Preserve selection and its essential commands even when a long role
      // tree shares a short sidebar with Development. Remaining roles scroll.
      minimumContentRows: 2,
      overflow: workflow
        ? actionRow(' ? more actions', [
            {
              key: '?',
              inputKey: '?',
              pane: 'global',
              description: 'help',
              label: '? more actions',
            },
          ])
        : null,
      selectedIndex,
      selectedEndIndex: nodeContent.findLastIndex(
        (item) => item.navigationId === selectedId && item.text.trim(),
      ),
      offset: state.nodesOffset,
    });
    state.nodesOffset = nodePane.offset;
    state.maxOffset = readingPane.maxOffset;
    state.offset = readingPane.offset;
    const selectedView = !state.form ? state.projectReadingView?.() : null;
    const geometry = [readingWidth, visibleRows, state.focus].join(':');
    const changedGeometry = geometry !== previousReadingGeometry;
    previousReadingGeometry = geometry;
    // Wrapping or returning focus can move the selected row out of view even
    // though its identity did not change. Keep the action target visible before
    // publishing the resized frame, without pinning intentional manual scroll.
    const corpusChoice =
      selectedView?.choiceIndex ??
      (workflow && state.focus === 'reading' && changedGeometry
        ? selectedView?.activeChoice
        : null);
    if (
      Number.isInteger(corpusChoice) ||
      (state.form &&
        state.focus === 'reading' &&
        !state.form.confirm &&
        !state.form.readOnly &&
        !state.form.busy &&
        !state.form.browseContext &&
        !investigationBrowser)
    ) {
      const selectedRow =
        Number.isInteger(corpusChoice) || state.form.move
          ? wrapped.findIndex((item) => item.choiceIndex === (corpusChoice ?? state.form.index))
          : wrapped.findIndex((item) => item.caret !== undefined);
      const lastRow =
        Number.isInteger(corpusChoice) || state.form.move
          ? wrapped.findLastIndex((item) => item.choiceIndex === (corpusChoice ?? state.form.index))
          : selectedRow;
      const targetRow = lastRow - selectedRow < visibleRows ? lastRow : selectedRow;
      if (state.form?.error) state.offset = state.maxOffset;
      else if (selectedRow >= 0) {
        if (selectedRow < state.offset) state.offset = selectedRow;
        else if (targetRow >= state.offset + visibleRows)
          state.offset = Math.max(0, targetRow - visibleRows + 1);
      }
      readingPane = layoutPane({
        height: bodyHeight,
        header: readingHeadingRows,
        content: wrapped,
        pinned: bottomRows,
        offset: state.offset,
        minimumContentRows: state.form || state.quitPrompt ? 2 : 4,
      });
      if (Number.isInteger(corpusChoice)) state.projectReadingView?.()?.consumeChoiceReveal?.();
    }
    state.offset = readingPane.offset;
    for (const [pane, total, headings] of [
      [nodePane, nodeContent.length, nodeHeadingRows.length],
      [recordingsPane, recordingContent.length, 2],
      [developmentPane, developmentContent.length, 2],
      [readingPane, wrapped.length, readingHeadingRows.length],
    ]) {
      const thumb = scrollThumb(total, pane.visibleRows, pane.offset);
      if (!thumb) continue;
      for (let i = 0; i < pane.visibleRows; i++) {
        const item = pane.rows[headings + i];
        if (item) item.scrollbar = i >= thumb.start && i < thumb.start + thumb.size ? '┃' : '┆';
      }
    }
    state.viewport = {
      visibleRows,
      readingWidth,
      sidebarWidth,
      headerHeight,
      bodyHeight,
      minimumNodeHeight,
      nodeWidth: sidebarWidth || (showNodes ? width : 0),
      developmentTop: headerHeight + conceptsHeight,
      developmentHeight,
      developmentHits: developmentHeight
        ? developmentPane.rows.flatMap((item, i) =>
            item.developmentId
              ? [{ id: item.developmentId, y: headerHeight + conceptsHeight + i + 2 }]
              : [],
          )
        : [],
      recordingsTop: headerHeight + conceptsHeight,
      recordingsHeight,
      recordingsMaxOffset: recordingsPane.maxOffset,
      recordingsVisibleRows: recordingsPane.visibleRows,
      recordingHits: recordingsHeight
        ? recordingsPane.rows.flatMap((item, i) =>
            item.recordingPath
              ? [{ path: item.recordingPath, y: headerHeight + conceptsHeight + i + 2 }]
              : [],
          )
        : [],
      nodeHits: nodePane.rows.flatMap((item, i) =>
        item.navigationId !== undefined ? [{ id: item.navigationId, y: headerHeight + i + 2 }] : [],
      ),
      choiceHits: readingPane.rows.flatMap((item, i) =>
        item.choiceIndex !== undefined
          ? [{ index: item.choiceIndex, y: headerHeight + i + 2 }]
          : [],
      ),
      selectorHits: readingPane.rows.flatMap((item, i) =>
        item.selectorIndex !== undefined
          ? [{ index: item.selectorIndex, y: headerHeight + i + 2 }]
          : [],
      ),
      sectionHits: readingPane.rows.flatMap((item, i) =>
        (item.sectionChoices ?? []).map((choice) => ({
          index: choice.index,
          y: headerHeight + i + 2,
          x: (sidebarWidth ? sidebarWidth + 1 : 0) + 2 + padding + choice.start,
          endX: (sidebarWidth ? sidebarWidth + 1 : 0) + 2 + padding + choice.end,
        })),
      ),
      actionHits: [],
    };
    const addHits = (rows, x, y, maxWidth) =>
      rows.forEach((item, index) => {
        for (const action of item.actions ?? []) {
          if (['SHIFT_DRAG', 'RELEASE'].includes(action.inputKey)) continue;
          const at = item.text.indexOf(action.label),
            start = terminalKit.stringWidth(item.text.slice(0, at));
          const end = start + terminalKit.stringWidth(action.label);
          if (end <= maxWidth)
            state.viewport.actionHits.push({
              ...action,
              x: x + start,
              endX: x + end - 1,
              y: y + index,
            });
        }
      });
    if (sidebarWidth || showNodes) {
      addHits(nodePane.rows, 2, headerHeight + 2, leftWidth);
      if (developmentHeight)
        addHits(developmentPane.rows, 2, headerHeight + conceptsHeight + 2, leftWidth);
      if (recordingsHeight)
        addHits(recordingsPane.rows, 2, headerHeight + conceptsHeight + 2, leftWidth);
    }
    if (!showNodes)
      addHits(
        readingPane.rows,
        (sidebarWidth ? sidebarWidth + 1 : 0) + 2 + padding,
        headerHeight + 2,
        readingWidth,
      );
    addHits(
      footer.map((label) => actionRow(label, controls.global)),
      1,
      headerHeight + bodyHeight + 1,
      footerWidth,
    );
    updatePointer();
    const brand = 'tendora / workbench';
    const recordedRevision =
      state.ix?.recording.project?.digest ?? state.ix?.recording.asset.revision;
    const revisionBadge =
      state.investigationReturn && state.project
        ? recordedRevision === state.project.digest
          ? 'current revision - '
          : `older revision ${recordedRevision?.slice(0, 8) ?? 'unknown'} - `
        : '';
    const badge = state.form?.revisesRecording
      ? 'Ask - revise question'
      : state.form?.continuation
        ? 'Ask - follow-up'
        : state.mode === 'recording'
          ? `${revisionBadge}recorded - read only`
          : state.mode === 'project'
            ? relative(process.cwd(), state.project.path)
            : '';
    const statuses =
      state.form?.roleStatements && state.form.busy
        ? 'Saving statements'
        : (engineActivity ? 'Checking corpus   ' : '') +
          (state.form?.engineInquiry ||
          (state.mode === 'recording' && state.ix?.recording.reasoning) ||
          (!state.form &&
            state.project &&
            state.mode !== 'home' &&
            state.projectReadingEntry?.()?.latestRun)
            ? `AMR - ${state.serviceStatus.egemma}   PENMAN - ${state.serviceStatus.penman ?? 'idle'}   SEMCAT - ${state.serviceStatus.semcat ?? 'idle'}`
            : `eGemma - ${state.serviceStatus.egemma}`);
    const headerLeft =
      terminalWidth >= brand.length + statuses.length + 8 ? `${brand}   ${statuses}` : statuses;
    const badgeWidth = Math.max(
      0,
      Math.min(terminalKit.stringWidth(badge), terminalWidth - headerLeft.length - 5),
    );
    const banner =
      fit(headerLeft, terminalWidth - badgeWidth) + (badgeWidth ? fit(badge, badgeWidth) : '');
    const bannerSpans = headerLeft.startsWith(brand)
      ? [{ start: 0, end: brand.length, tone: 'title' }]
      : [];
    const projectTitle = state.mode === 'project' ? state.project.data.name : 'Create or open';
    const projectHeading =
      paint(' ') + paint(fit(projectTitle, headingWidth), 'heading') + paint(' ');
    const busy = (state.form?.busy || engineActivity) && !state.quitPrompt;
    state.animatedHeader =
      busy && !noColor ? { text: banner, width: terminalWidth, spans: bannerSpans } : null;
    const header = state.animatedHeader
      ? progressHeader(banner, terminalWidth, undefined, bannerSpans)
      : paint(banner, 'plain', headerBand, { spans: bannerSpans });
    const summary =
      state.mode === 'recording'
        ? findingSummary(state.ix, state.selection, state.interpretationDecisions)
        : '';
    const summaryWidth = summary
      ? Math.min(terminalKit.stringWidth(summary), Math.max(0, headingWidth - 37))
      : 0;
    const summaryText = fit(summary, summaryWidth);
    const summarySpans = [...summaryText.matchAll(/\b[1-9]\d* (?:matched|case-supported)\b/gu)].map(
      (match) => ({ start: match.index, end: match.index + match[0].length, tone: 'located' }),
    );
    const lines = [
      header,
      ...(spacious ? [paint(' '.repeat(width))] : []),
      state.mode === 'recording'
        ? paint(' Inquiry: ', 'muted') +
          paint(
            fit(
              state.ix.recording.inquiry.text,
              Math.max(1, headingWidth - 9 - summaryWidth - (summary ? 2 : 0)),
            ),
            'heading',
            background,
            bindingMarks('query'),
          ) +
          (summary
            ? paint('  ') + paint(summaryText, 'plain', background, { spans: summarySpans })
            : '') +
          paint(' ')
        : projectHeading,
      paint(' '.repeat(width)),
      ...routeRows.map(
        (line) =>
          paint(' ') + paint(fit(line.text, headingWidth), 'muted', background, line) + paint(' '),
      ),
    ];
    const panelLine = (
      item,
      panelWidth,
      index,
      active,
      surface = background,
      inset = 0,
      panelHeight = bodyHeight,
    ) => {
      const borderTone = active ? 'focusBorder' : 'inactiveBorder';
      if (index === 0 || index === panelHeight - 1) {
        const edge =
          (index === 0 ? '╭' : '╰') + '─'.repeat(panelWidth - 2) + (index === 0 ? '╮' : '╯');
        return paint(edge, borderTone, background);
      }
      const edge = paint('│', borderTone, background);
      const gutterSurface = surface;
      surface = item.surface ?? surface;
      const innerWidth = panelWidth - 2 - inset * 2;
      const rightWidth = item.right ? terminalKit.stringWidth(item.right) : 0;
      const body =
        rightWidth && innerWidth > rightWidth + 3
          ? paint(fit(item.text, innerWidth - rightWidth - 2), item.tone, surface, item) +
            paint(`  ${item.right}`, 'muted', surface)
          : paint(fit(item.text, innerWidth), item.tone, surface, item);
      return (
        edge +
        paint(' '.repeat(inset), 'plain', gutterSurface) +
        body +
        paint(' '.repeat(inset), 'plain', gutterSurface) +
        (item.scrollbar
          ? paint(
              item.scrollbar,
              item.scrollbar === '┃' ? 'scrollbar' : 'scrollbarTrack',
              background,
            )
          : edge)
      );
    };
    for (let i = 0; i < bodyHeight; i++) {
      const at = i - 1;
      const item = readingPane.rows[at] ?? row();
      const inRecordings = recordingsHeight && i >= conceptsHeight;
      const inDevelopment = developmentHeight && i >= conceptsHeight;
      const leftLine = (panelWidth) => {
        const index = inRecordings || inDevelopment ? i - conceptsHeight : i;
        const leftItem =
          (inRecordings ? recordingsPane : inDevelopment ? developmentPane : nodePane).rows[
            index - 1
          ] ?? row();
        const inset = leftItem.surface === sidebar ? 1 : 0;
        const leading = leftItem.text.startsWith(' ') ? 1 : 0;
        // Use the existing leading space as the gutter so labels stay aligned.
        const content = inset
          ? {
              ...leftItem,
              text: leftItem.text.slice(leading),
              ...(leftItem.selectionInset !== undefined
                ? { selectionInset: Math.max(0, leftItem.selectionInset - leading) }
                : {}),
              ...(leftItem.spans
                ? { spans: sliceHighlights(leftItem.spans, leading, leftItem.text.length) }
                : {}),
            }
          : leftItem;
        return panelLine(
          content,
          panelWidth,
          index,
          state.focus === (inRecordings ? 'recordings' : inDevelopment ? 'development' : 'nodes'),
          background,
          inset,
          inRecordings ? recordingsHeight : inDevelopment ? developmentHeight : conceptsHeight,
        );
      };
      if (sidebarWidth) {
        lines.push(
          leftLine(sidebarWidth) +
            paint(' ') +
            panelLine(item, readingArea, i, state.focus === 'reading', background, padding),
        );
      } else {
        lines.push(
          showNodes ? leftLine(width) : panelLine(item, width, i, true, background, padding),
        );
      }
    }
    footer.forEach((text, index) => {
      const parseWarning =
        state.mode === 'recording' &&
        !state.form &&
        !state.quitPrompt &&
        state.ix.failedSources.length
          ? `AMR: ${state.ix.failedSources.length} failed`
          : '';
      const status =
        index === footer.length - 1
          ? state.form?.busy
            ? (state.form.progress ?? 'Starting…')
            : engineActivity?.progress || parseWarning || state.notice
          : '';
      const clipped = fit(status, statusWidth - 1).trimEnd();
      const shortcuts = shortcutRow(text, controls.global);
      lines.push(
        paint(fit(shortcuts.text, footerWidth), 'muted', background, shortcuts) +
          paint(
            ' '.repeat(statusWidth - 1 - terminalKit.stringWidth(clipped)) + clipped + ' ',
            state.failure || parseWarning ? 'warning' : 'muted',
          ),
      );
    });
    // One synchronized frame includes pane content and the final caret state.
    const caretRow = readingPane.rows.findIndex((item) => item.caret !== undefined);
    const caret =
      caretRow >= 0 && !showNodes && !state.quitPrompt
        ? `\x1b[6 q\x1b[${headerHeight + caretRow + 2};${(sidebarWidth ? sidebarWidth + 1 : 0) + 2 + padding + readingPane.rows[caretRow].caret}H\x1b[?25h`
        : '';
    writeFrame(
      '\x1b[?25l' +
        lines
          .slice(0, height)
          .map((line, index) => `\x1b[${index + 1};1H${line}`)
          .join('') +
        caret,
    );
  }

  return { draw, invalidate };
}
