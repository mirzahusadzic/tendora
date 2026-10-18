import { unmatchedContextDifferences } from '../../amr/context-comparison.mjs';
import { penmanEdgeLocations } from './penman.mjs';
import { evidenceOpenings } from '../../recording/continuation.mjs';
import { interpretationEdge } from '../../amr/interpretation.mjs';
/** Recording pages rendered as rows; evidence and selection are read-only here. */
import { acceptedInterpretation } from '../../recording/interpretation.mjs';
import { interpretationRevision } from '../../recording/revisions.mjs';
import { followupFor } from '../../project/inquiries/investigation.mjs';
import { evaluateAnswer, sourceIdentity } from '../../recording/answers.mjs';
import { answerOutput } from '../../recording/answer-output.mjs';
import {
  inquiryContextLinks,
  provenanceSections,
  conditionalReturnSections,
  visitSummary,
  bindingHighlights,
  bindingPresentation,
  carriedContext,
  occurrenceRelations,
} from './view.mjs';
import { relationReading, proposalReading, unavailableReadings } from '../shell/wording.mjs';

export function createRecordingContent({ state, text }) {
  const { clean, row, labeledRow } = text;
  let answerCache;
  const helpRows = [
    ['tab', 'pane'],
    ['enter', 'select'],
    ['esc', 'return'],
    ['s', 'source openings'],
    ['a', 'AMR'],
    ['c', 'context'],
    ['v', 'origin'],
    ['t', 'interpret'],
    ['e', 'add source'],
    ['d', 'assess'],
  ].map(([key, label]) => row(`${key}  ${label}`));
  const acceptedLabel = ({ proposal, review }) =>
    proposalReading(proposal, {
      query: review.query ?? state.ix.graphs.get(proposal.scope.queryGraphId),
      source: review.source ?? state.ix.graphs.get(proposal.scope.sourceGraphId),
      queryText: state.ix.recording.inquiry.text,
      sourceText: state.ix.sources.get(proposal.scope.sourceId)?.text ?? '',
      caseLabel: state.ix.nodes.get(proposal.caseBinding?.caseNodeId)?.label,
    });
  function bindingMarks(
    side,
    occurrence = state.ix?.occurrences.get(state.selection?.occurrenceId),
  ) {
    const marks = state.ix ? bindingHighlights(state.ix, occurrence) : [];
    const original =
      side === 'query'
        ? state.ix?.recording.inquiry.text
        : state.ix?.sources.get(occurrence?.sourceId)?.text;
    return {
      nodes: marks.map((mark) => ({
        id: side === 'query' ? mark.queryNodeId : mark.sourceNodeId,
        color: mark.color,
      })),
      spans: marks.flatMap((mark) => {
        const span = side === 'query' ? mark.querySpan : mark.sourceSpan;
        return span && clean(original) === original ? [{ ...span, color: mark.color }] : [];
      }),
    };
  }
  function sourceRow(source, occurrence = state.ix.occurrences.get(state.selection.occurrenceId)) {
    return {
      ...row(source.text, source.id === occurrence?.sourceId ? 'input' : 'muted', 1),
      spans: source.id === occurrence?.sourceId ? bindingMarks('source', occurrence).spans : [],
    };
  }
  function codeRow(
    text,
    tone = 'plain',
    indent = 0,
    side = 'query',
    occurrence = state.ix.occurrences.get(state.selection.occurrenceId),
  ) {
    const item = row(text, tone, indent);
    const mark = text.match(/^\s*(?:[└├]─ )?([=?≠·-]) /u)?.[1];
    if (mark) item.relationMark = mark;
    if (!occurrence?.bindings?.length) return item;
    const graph = state.ix.graphs.get(
      side === 'query'
        ? state.ix.recording.inquiry.graphId
        : state.ix.sources.get(occurrence.sourceId).graphId,
    );
    const spans = [];
    for (const target of bindingMarks(side, occurrence).nodes) {
      const concept = graph.nodes.find((node) => node.id === target.id)?.concept;
      if (!concept || graph.nodes.filter((node) => node.concept === concept).length !== 1) continue;
      const pattern = new RegExp(
        `(?<![\\w-])${concept.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\w-])`,
        'gu',
      );
      for (const match of item.text.matchAll(pattern))
        spans.push({ start: match.index, end: match.index + match[0].length, color: target.color });
    }
    return { ...item, spans };
  }
  function similarityRow(source) {
    if (!Number.isFinite(source.affinity))
      return labeledRow([['Inspection', 'Authored scope order - retained AMRs', 'muted']]);
    const ranked = state.ix.nodes
      .get(source.nodeId)
      .sourceIds.map((id) => state.ix.sources.get(id))
      .sort((a, b) => b.affinity - a.affinity);
    return labeledRow([
      ['Inquiry similarity', source.affinity.toFixed(3), 'muted'],
      ['Sentence rank', `${ranked.indexOf(source) + 1}/${ranked.length}`, 'muted'],
    ]);
  }
  function contextRows() {
    const recording = state.ix.recording;
    const rows = [
      row('Inquiry', 'section'),
      { ...row(recording.inquiry.text, 'input', 1), spans: bindingMarks('query').spans },
    ];
    for (const node of recording.nodes.filter((item) => item.sourceIds.length)) {
      rows.push(row(), row(`Sources - ${node.label}`, 'section'));
      for (const [index, id] of node.sourceIds.entries())
        rows.push(...(index ? [row()] : []), sourceRow(state.ix.sources.get(id)));
    }
    const routing = recording.routing;
    const orderTable = (candidates, selectedId = null) => ({
      ...row('', 'plain', 1),
      table: {
        headers: ['Rank', 'Concept', 'Cosine', ...(selectedId ? ['State'] : [])],
        widths: [5, null, 8, ...(selectedId ? [12] : [])],
        minWidth: 54,
        entries: candidates.map((candidate) => ({
          cells: [
            String(candidate.rank),
            selectedId ? candidate.path.join(' → ') : candidate.name,
            candidate.similarity.toFixed(3),
            ...(selectedId ? [candidate.placementId === selectedId ? 'selected' : ''] : []),
          ],
          tone: 'muted',
        })),
      },
    });
    if (routing?.profile === 'question-role-similarity-v1') {
      rows.push(row(), row('Role matching', 'section'));
      if (routing.status === 'matched') {
        rows.push({
          ...row('', 'plain', 1),
          table: {
            headers: ['Role', 'Closest text', 'Cosine'],
            entries: routing.matches.map((match) => ({
              cells: [
                state.ix.nodes.get(match.nodeId)?.label ?? match.nodeId,
                match.best.text,
                match.best.score.toFixed(3),
              ],
              tone: 'muted',
            })),
          },
        });
      } else {
        rows.push(row(routing.reason ?? 'No saved role matches are available.', 'warning', 1));
      }
    } else if (routing?.policy === 'local-then-ranked-children-v1') {
      for (const step of routing.steps.filter((step) => step.candidates.length)) {
        rows.push(
          row(),
          row(`Inspection order - ${state.ix.nodes.get(step.nodeId).label}`, 'section'),
          orderTable(step.candidates),
        );
      }
    } else if (routing?.candidates) {
      rows.push(
        row(),
        row('Concept selection', 'section'),
        orderTable(routing.candidates, routing.selectedPlacementId),
      );
    }
    rows.push(
      row(),
      row('Provenance', 'section'),
      metadataRow(`Asset: ${recording.asset.name}`),
      ...(recording.asset.revision ? [metadataRow(`Revision: ${recording.asset.revision}`)] : []),
      metadataRow(`SHA256: ${recording.asset.digest}`),
      ...(routing?.model ? [metadataRow(`Routing model: ${routing.model}`)] : []),
    );
    return rows;
  }
  function passageRows(ids) {
    return ids.length
      ? ids.flatMap((id, i) => {
          const source = state.ix.sources.get(id);
          return [...(i ? [row()] : []), sourceRow(source), similarityRow(source)];
        })
      : [];
  }
  function occurrenceRows(occurrence) {
    if (
      !occurrence ||
      state.ix.recording.occurrences.filter((item) => item.sourceId === occurrence.sourceId)
        .length < 2
    )
      return [];
    return [
      row(),
      row('Examined relation', 'section'),
      ...occurrenceRelations(state.ix, occurrence).map((text) => row(text, 'plain', 1)),
      row(),
    ];
  }
  const bindingRows = (occurrence) =>
    occurrence?.bindings?.length
      ? [
          row(),
          row('Proposed binding', 'section'),
          ...bindingPresentation(occurrence, state.ix).map((item) => ({
            ...row(item.caption, 'plain', 1),
            spans: item.spans,
          })),
        ]
      : [];
  function findingRelations(links) {
    const queryText = state.ix.recording.inquiry.text,
      sourceText = state.ix.sources.get(links.sourceId).text;
    const label = (item) =>
      relationReading(
        links.query,
        links.query.edges.find((edge) => edge.id === item.queryEdgeId),
        queryText,
      ).label;
    const groups = [
      ['Unmatched in source', links.relations.filter((item) => item.status === 'open')],
      ['Unresolved', links.relations.filter((item) => item.status === 'unresolved')],
      ['Case-supported', links.relations.filter((item) => item.status === 'case-supported')],
      ['Matched', links.relations.filter((item) => item.status === 'matched')],
    ];
    const matchedSource = new Set(links.relations.map((item) => item.sourceEdgeId).filter(Boolean));
    const sourceEdges = links.sourceGraph.edges.filter((edge) => !matchedSource.has(edge.id));
    const sourceLabel = (edge) =>
      edge ? relationReading(links.sourceGraph, edge, sourceText).label : '';
    const entries = [
      ...groups.flatMap(([status, items]) =>
        items.map((item) => ({
          cells: [
            status,
            label(item),
            sourceLabel(links.sourceGraph.edges.find((edge) => edge.id === item.sourceEdgeId)),
          ],
          tone: ['matched', 'case-supported'].includes(item.status) ? 'located' : 'open',
        })),
      ),
      ...sourceEdges.map((edge) => ({
        cells: ['Source only', '', sourceLabel(edge)],
        tone: 'open',
      })),
    ];
    return entries.length
      ? [
          row(),
          {
            ...row('', 'plain', 1),
            table: {
              headers: ['State', 'Inquiry relation', 'Source relation'],
              widths: [20, null, null],
              minWidth: 72,
              repeatColumns: 1,
              groupColumns: [0],
              entries,
            },
          },
        ]
      : [];
  }
  function inquiryRows(view) {
    const openings = evidenceOpenings(state.ix, state.selection, state.interpretationDecisions);
    const selected = openings[state.openingIndex ?? 0],
      source = state.ix.sources.get(selected?.sourceId);
    const followup =
      selected &&
      followupFor(
        state.investigation?.data,
        {
          path: state.activeRecordingPath,
          recordingRevision: interpretationRevision(state.ix.recording),
          nodeId: state.selection.nodeId,
          occurrenceId: state.selection.occurrenceId,
        },
        selected.id,
      );
    const links = inquiryContextLinks(state.ix, view.occurrence, state.interpretationDecisions);
    const groupFor = (item) =>
      item.kind !== 'query'
        ? 'Source'
        : item.status === 'case-supported'
          ? 'Case-supported'
          : item.status === 'unresolved'
            ? 'Unresolved in source'
            : 'Unmatched in source';
    let previousGroup;
    return [
      ...answerRows(false),
      row('Source comparison', 'section'),
      labeledRow([['Question', state.ix.recording.inquiry.text, 'input']]),
      ...(source ? [row(), labeledRow([['Source', source.text, 'input']])] : []),
      ...(followup?.question
        ? [
            labeledRow([
              ['Follow-up', followup.question],
              ['Runs', followup.runs.length],
            ]),
          ]
        : []),
      row(),
      ...openings.flatMap((item, index) => {
        const active = index === (state.openingIndex ?? 0),
          local = state.ix.sources.get(item.sourceId);
        const graph =
          item.kind === 'query'
            ? links.query
            : (acceptedInterpretation(
                state.ix,
                { id: view.occurrence?.id ?? null, sourceId: item.sourceId },
                state.interpretationDecisions,
              )?.review.source ?? state.ix.graphs.get(local?.graphId));
        const reading =
          item.edge && graph
            ? relationReading(
                graph,
                item.edge,
                item.kind === 'query' ? state.ix.recording.inquiry.text : local.text,
              )
            : null;
        const group = groupFor(item);
        const header =
          previousGroup !== group
            ? [
                labeledRow([
                  [
                    group,
                    item.kind === 'query'
                      ? openings.filter((entry) => groupFor(entry) === group).length
                      : view.node.label,
                  ],
                ]),
              ]
            : [];
        previousGroup = group;
        return [
          ...(header.length && index ? [row()] : []),
          ...header,
          row(
            `${active ? '▸' : ' '} ${reading?.label ?? (source?.id === item.sourceId ? 'Whole source' : item.label)}`,
            active ? 'selected' : item.status === 'case-supported' ? 'located' : 'muted',
            1,
          ),
          ...(active && reading ? [labeledRow([['Parse', reading.parse, 'muted']]), row()] : []),
        ];
      }),
    ];
  }

  const connectionState = (connection, bound) =>
    connection.status === 'linked' ? (bound ? 'matched' : 'carried overlap') : connection.status;
  function connectionSummaryRows(view, links) {
    const relations = new Map();
    for (const [connections, bound] of [
      [links?.caseSupport.connections ?? [], true],
      [links?.carriedSupport.connections ?? [], false],
    ]) {
      for (const connection of connections) {
        const key = JSON.stringify([connection.inheritedSourceId, connection.queryEdgeId]);
        if (!relations.has(key))
          relations.set(key, { connection, state: connectionState(connection, bound) });
      }
    }
    const carried = carriedContext(state.ix, view.visits, view.occurrence?.sourceId);
    const distance = new Map();
    for (const visit of view.visits) {
      let depth = 1;
      for (
        let parent = state.ix.visits.get(visit.parentVisitId);
        parent;
        parent = state.ix.visits.get(parent.parentVisitId)
      ) {
        distance.set(parent.nodeId, Math.min(distance.get(parent.nodeId) ?? Infinity, depth++));
      }
    }
    carried.sort(
      (a, b) => (distance.get(a.node.id) ?? Infinity) - (distance.get(b.node.id) ?? Infinity),
    );
    const entries = carried.flatMap((item) => {
      const connections = [...relations.values()].filter(
        ({ connection }) => connection.inheritedSourceId === item.source.id,
      );
      return (connections.length ? connections : [{ connection: null, state: 'none' }]).map(
        ({ connection, state: status }) => ({
          tone: ['matched', 'scoped'].includes(status) ? 'located' : 'muted',
          cells: [
            item.node.label,
            item.source.text,
            connection
              ? relationReading(
                  links.query,
                  links.query.edges.find((edge) => edge.id === connection.queryEdgeId),
                  state.ix.recording.inquiry.text,
                ).label
              : '',
            status,
          ],
          ...(!['matched', 'scoped'].includes(status)
            ? { cellTones: { 1: 'plain', 2: 'open' } }
            : {}),
        }),
      );
    });
    if (!entries.length) return [];
    const hasRelations = entries.some((entry) => entry.cells[2]);
    const contextWidth = Math.min(
      32,
      Math.max(7, ...entries.map((entry) => text.editorMeasure(entry.cells[0]))),
    );
    const stateWidth = Math.max(5, ...entries.map((entry) => text.editorMeasure(entry.cells[3])));
    return [
      row(),
      row('Carried connections', 'section'),
      {
        ...row('', 'plain', 1),
        table: {
          headers: ['Context', 'Sentence', ...(hasRelations ? ['Inquiry relation'] : []), 'State'],
          widths: [contextWidth, null, ...(hasRelations ? [28] : []), stateWidth],
          minWidth: contextWidth + stateWidth + (hasRelations ? 28 + 9 : 6) + 24,
          repeatColumns: 1,
          groupColumns: [0, 1],
          entries: hasRelations
            ? entries
            : entries.map((entry) => ({
                ...entry,
                cells: [entry.cells[0], entry.cells[1], entry.cells[3]],
                cellTones: entry.cellTones ? { 1: entry.cellTones[1] } : undefined,
              })),
        },
      },
    ];
  }

  function inquiryRelationRows(view, links, showSentences = true) {
    return [
      row('Inquiry → selected source', 'section'),
      ...(showSentences
        ? [
            row(state.ix.recording.inquiry.text, 'input', 1),
            row(),
            ...(view.occurrence
              ? [sourceRow(state.ix.sources.get(view.occurrence.sourceId)), row()]
              : []),
          ]
        : []),
      ...(links.accepted ? [assumptionRow(acceptedLabel(links.accepted)), row()] : []),
      {
        ...row('', 'plain', 1),
        table: {
          headers: ['Inquiry ref', 'State', 'Basis', 'Inquiry relation', view.node.label],
          groupColumns: [1],
          entries: links.relations.map((relation) => {
            const connections = relation.caseConnections;
            const caseBasis = connections.length ? 'case' : null;
            const directBasis = relation.basis === 'accepted' ? 'assumed' : relation.basis;
            const basis = caseBasis
              ? !directBasis
                ? caseBasis
                : `${directBasis}, ${caseBasis}`
              : directBasis;
            const graph = links.sourceGraph;
            const sources = [
              ...new Set(
                connections.map((item) =>
                  interpretationEdge(
                    graph,
                    graph.edges.find((edge) => edge.id === item.sourceEdgeId),
                  ),
                ),
              ),
            ];
            return {
              cells: [
                relation.ref,
                relation.status,
                basis,
                relation.queryLabel,
                relation.sourceLabel ?? sources.join(' / '),
              ],
              tone: relation.sourceEdgeId ? 'located' : 'open',
            };
          }),
        },
      },
    ];
  }
  function caseRows(view, links, contextNodeId = null) {
    const support = links.caseSupport;
    const sameConnection = (a, b) =>
      ['queryEdgeId', 'sourceEdgeId', 'inheritedSourceId', 'visitId'].every(
        (key) => a[key] === b[key],
      );
    const groups = [
      { title: 'Case connections', connections: support.connections, bound: true },
      {
        title: 'Carried connections',
        connections: links.carriedSupport.connections.filter(
          (item) => !support.connections.some((other) => sameConnection(item, other)),
        ),
        bound: false,
      },
    ];
    const query = links.query;
    const local = links.sourceGraph;
    const label = (graph, id) =>
      interpretationEdge(
        graph,
        graph.edges.find((edge) => edge.id === id),
      );
    return groups.flatMap(({ title, connections: all, bound }) => {
      const connections = all.filter(
        (item) => !contextNodeId || item.contextNodeId === contextNodeId,
      );
      if (!connections.length) return [];
      return [
        row(),
        { ...row(title, 'section'), ...(contextNodeId ? { continueSection: true } : {}) },
        {
          ...row('', 'plain', 1),
          table: {
            headers: [
              'Inquiry ref',
              'State',
              'Context',
              bound ? 'Inquiry → source' : 'Inquiry / source',
              'Carried ↔ source',
            ],
            groupColumns: [0, 2],
            entries: connections.flatMap((connection) =>
              connection.witnesses.map((pair) => ({
                cells: [
                  links.relations.find((item) => item.queryEdgeId === connection.queryEdgeId).ref,
                  connectionState(connection, bound),
                  connection.contextRoute.map((id) => state.ix.nodes.get(id).label).join(' → '),
                  `${label(query, connection.queryEdgeId)} ${bound ? '→' : '/'} ${label(local, connection.sourceEdgeId)}`,
                  `${label(links.effective.graphs.get(state.ix.sources.get(connection.inheritedSourceId).graphId), pair.fromEdgeId)} ↔ ${label(local, pair.sourceEdgeId)}`,
                ],
                tone: ['linked', 'scoped'].includes(connection.status) ? 'located' : 'open',
              })),
            ),
          },
        },
        ...connections
          .filter((item) => item.scopePath.length)
          .flatMap((connection) => {
            const graph = links.effective.graphs.get(
              state.ix.sources.get(connection.inheritedSourceId).graphId,
            );
            const ref = links.relations.find(
              (item) => item.queryEdgeId === connection.queryEdgeId,
            ).ref;
            return [
              row(),
              row(
                `${ref} - Inherited path - ${state.ix.nodes.get(connection.contextNodeId).label}`,
                'subheading',
                1,
              ),
              row(),
              ...connection.scopePath.map((id) => row(label(graph, id), 'open', 2)),
            ];
          }),
      ];
    });
  }
  function carryRows(view) {
    const links = inquiryContextLinks(state.ix, view.occurrence, state.interpretationDecisions);
    const rows = inquiryRelationRows(view, links);
    const groups = new Map();
    for (const item of carriedContext(
      links.effective,
      view.visits.map((visit) => links.effective.visits.get(visit.id)),
      view.occurrence?.sourceId,
    )) {
      if (!groups.has(item.node.id)) groups.set(item.node.id, []);
      groups.get(item.node.id).push(item);
    }
    for (const items of groups.values()) {
      const first = items[0],
        localIds = [
          ...new Set(items.flatMap((item) => item.checks.map((check) => check.localSourceId))),
        ];
      const paths = new Set();
      for (const visit of view.visits) {
        const ancestors = [],
          seen = new Set();
        for (
          let parent = state.ix.visits.get(visit.parentVisitId);
          parent && !seen.has(parent.id);
          parent = state.ix.visits.get(parent.parentVisitId)
        ) {
          seen.add(parent.id);
          ancestors.unshift(parent.nodeId);
        }
        const at = ancestors.indexOf(first.node.id);
        if (at >= 0)
          paths.add(
            ancestors
              .slice(0, at + 1)
              .map((id) => state.ix.nodes.get(id).label)
              .join(' → '),
          );
      }
      const carriedName = `${first.node.label} (C)`,
        localName = `${view.node.label} (L)`;
      const localRef = (id) => `L${localIds.indexOf(id) + 1}`;
      const sources = (entries, tone) =>
        entries.flatMap(([label, sentence], index) => [
          ...(index ? [row()] : []),
          { ...row(`${label}  ${sentence}`, tone), sentence: true },
        ]);
      rows.push(
        ...(rows.length ? [row()] : []),
        row([...paths].join(' | ') || first.node.label, 'section'),
        {
          ...row('', 'plain', 1),
          columns: [
            [
              row(carriedName, 'subheading'),
              row(),
              ...sources(
                items.map((item, index) => [`C${index + 1}`, item.source.text]),
                'muted',
              ),
            ],
            [
              row(localName, 'subheading'),
              row(),
              ...sources(
                localIds.map((id) => [localRef(id), state.ix.sources.get(id).text]),
                'input',
              ),
            ],
          ],
        },
        row(),
      );
      const entries = [];
      const edgeLabel = (graphId, id) => {
        const graph = state.ix.graphs.get(graphId),
          edge = graph.edges.find((edge) => edge.id === id);
        return interpretationEdge(graph, edge);
      };
      for (const [index, item] of items.entries()) {
        if (!item.checks.length)
          entries.push({
            cells: [`C${index + 1}`, '', 'not checked', '', '', 'unlinked'],
            tone: 'muted',
          });
        for (const check of item.checks) {
          const pairLabel = `C${index + 1} / ${localRef(check.localSourceId)}`;
          if (check.status === 'parse-unavailable' || !check.anchors.length)
            entries.push({
              cells: [
                pairLabel,
                '',
                check.status === 'parse-unavailable' ? 'parse failed' : 'no event',
                '',
                '',
                'unlinked',
              ],
              tone: 'muted',
            });
          for (const anchor of check.anchors) {
            const event = anchor.concept + (anchor.complete ? '' : ' (partial)');
            if (!anchor.shared.length)
              entries.push({
                cells: [pairLabel, event, '0 shared', '', '', 'unlinked'],
                tone: 'muted',
              });
            for (const [pairs, status, tone] of [
              [anchor.shared, 'shared', 'located'],
              [unmatchedContextDifferences(anchor), 'different', 'open'],
            ]) {
              for (const pair of pairs)
                entries.push({
                  cells: [
                    pairLabel,
                    event,
                    status,
                    edgeLabel(item.source.graphId, pair.fromEdgeId),
                    edgeLabel(state.ix.sources.get(check.localSourceId).graphId, pair.sourceEdgeId),
                    links
                      .forSourceEdge(check.localSourceId, pair.sourceEdgeId)
                      .map(
                        (relation) =>
                          relation.ref +
                          (relation.basis === 'accepted'
                            ? ' (assumed)'
                            : relation.basis === 'binding'
                              ? ' (binding)'
                              : relation.basis === 'case'
                                ? ' (case)'
                                : relation.basis === 'context'
                                  ? ' (context)'
                                  : ''),
                      )
                      .join(', ') || 'unlinked',
                  ],
                  tone,
                  cellTones: { 5: 'muted' },
                });
            }
          }
        }
      }
      rows.push({
        ...row('', 'plain', 1),
        table: {
          headers: ['Sources', 'Fixed event', 'Result', carriedName, localName, 'Inquiry ref'],
          widths: [12, 18, 12, null, null, 18],
          minWidth: 132,
          groupColumns: [0, 1],
          entries,
        },
      });
      rows.push(...caseRows(view, links, first.node.id));
    }
    return rows;
  }
  function metadataRow(text) {
    if (text.startsWith('Accepted interpretation: '))
      return assumptionRow(text, 1, 'Accepted interpretation: ');
    if (text.startsWith('Applied interpretation: '))
      return assumptionRow(text, 1, 'Applied interpretation: ');
    const at = text.indexOf(': ');
    return at >= 0
      ? labeledRow([[text.slice(0, at), text.slice(at + 2), 'muted']])
      : row(text, 'muted', 1);
  }
  function assumptionRow(text, indent = 1, prefix = '') {
    const separator = text.indexOf('\n', prefix.length);
    return {
      ...row(text, 'muted', indent),
      hangingIndent: prefix.length,
      spans: [
        ...(prefix ? [{ start: 0, end: prefix.trimEnd().length, tone: 'plain' }] : []),
        { start: prefix.length, end: separator < 0 ? text.length : separator, tone: 'located' },
      ],
    };
  }
  function returnedRow(title, text, index) {
    if (['Accepted assumption', 'Applied interpretation'].includes(title))
      return assumptionRow(text, 2);
    if (title === 'Open inquiry relations') return row(text, 'open', 2);
    if (title === 'Case-supported inquiry relations') return row(text, 'located', 2);
    if (
      [
        'Conditional return - accepted interpretation',
        'Conditional return - applied interpretation',
      ].includes(title)
    ) {
      if (index === 0) return row(text, 'input', 2);
      const label = 'Source statement: ';
      if (text.startsWith(label))
        return {
          ...row(text, 'plain', 2),
          spans: [{ start: 0, end: label.length, tone: 'muted' }],
        };
    }
    return row(text, 'muted', 2);
  }
  function originRows(view) {
    return (view.occurrence ? [view.occurrence.sourceId] : view.node.sourceIds).flatMap((id) => {
      const source = sourceIdentity(
        state.ix.sources.get(id),
        state.answerKnowledge?.knowledge ?? state.ix.recording.knowledge,
      );
      return source.sentenceId
        ? [
            row(),
            row('Source origin', 'section'),
            labeledRow([['Source', source.text, 'input']]),
            row(),
            labeledRow([['Sentence', source.sentenceId, 'muted']]),
            labeledRow([['Concept', source.conceptId, 'muted']]),
            labeledRow([['Revision', source.revision, 'muted']]),
            ...referenceRows(source.sourceRefs ?? []),
            ...(source.authoring ?? []).map((entry) =>
              labeledRow([['Author', entry.actor ?? entry.attribution, 'muted']]),
            ),
          ]
        : [];
    });
  }
  function referenceRows(references) {
    const fields = (value, prefix = '') =>
      value && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, item]) =>
            fields(item, prefix ? `${prefix}.${key}` : key),
          )
        : [[prefix || 'Reference', String(value ?? '')]];
    return references.length
      ? [
          row(),
          {
            ...row('', 'plain', 1),
            table: {
              headers: ['Reference', 'Field', 'Value'],
              widths: [10, 15, null],
              minWidth: 64,
              repeatColumns: 1,
              groupColumns: [0],
              entries: references.flatMap((reference, index) =>
                fields(reference).map(([key, value]) => ({
                  cells: [String(index + 1), key, value],
                  tone: 'muted',
                  cellTones: key === 'quote' ? { 2: 'plain' } : {},
                })),
              ),
            },
          },
        ]
      : [];
  }
  function routeRows(view) {
    const rows = view.visits.length ? [row(), row('Recorded routes', 'section')] : [];
    for (const visit of view.visits)
      rows.push(
        ...visitSummary(state.ix, visit, '\n')
          .split('\n')
          .map((text, index) => row(text, 'muted', index === 0 ? 1 : 2)),
      );
    const step = state.ix.recording.routing?.steps?.find((item) => item.nodeId === view.node.id);
    if (step?.candidates.length) {
      rows.push(row(), row('Child inspection order - names and descriptions', 'section'));
      if (step.contextNodeIds?.length)
        rows.push(
          labeledRow([
            [
              'Context',
              step.contextNodeIds
                .filter((id) => state.ix.nodes.get(id).sourceIds.length)
                .map((id) => state.ix.nodes.get(id).label)
                .join(' → '),
              'muted',
            ],
          ]),
        );
      rows.push(
        ...(step.candidates.length
          ? step.candidates.map((candidate) =>
              row(
                `${candidate.rank}. ${candidate.name} - ${candidate.similarity.toFixed(3)}`,
                'muted',
                1,
              ),
            )
          : []),
      );
    }
    return rows;
  }
  function currentAnswer() {
    const recording = state.ix.recording;
    const knowledge =
      state.answerKnowledge?.recording === recording
        ? state.answerKnowledge.knowledge
        : recording.knowledge;
    if (!knowledge && !recording.project) return null;
    if (answerCache?.recording !== recording || answerCache.knowledge !== knowledge) {
      const result = evaluateAnswer(recording, knowledge);
      answerCache = {
        recording,
        knowledge,
        result,
        output: answerOutput(result, knowledge, { explain: true }),
      };
    }
    return answerCache.result;
  }
  function answerRows(details, view = null) {
    const answer = currentAnswer();
    if (!answer) return [];
    const rows = [
      row('Inquiry result', 'section'),
      labeledRow([['State', answer.status]]),
      ...(state.answerKnowledge?.evaluation
        ? [
            labeledRow([
              ['Evaluation', 'Current corpus', 'muted'],
              ['ID', state.answerKnowledge.evaluation.id.slice(0, 8), 'muted'],
            ]),
          ]
        : []),
      ...answerCache.output.answers.flatMap((item) => [
        row(),
        labeledRow([['Answer', item.text, 'input']]),
        row(),
      ]),
      ...answerCache.output.candidates.map((item) => labeledRow([['Candidate', item.text]])),
      ...answer.openings
        .filter((o) => o.kind === 'aporia')
        .flatMap((o) => [row(), labeledRow([['Open connection', o.text, 'warning']])]),
      ...[
        ...new Set(
          answer.answers
            .flatMap((item) => item.qualifications)
            .filter((value) => !answer.answers.some((item) => item.text === value)),
        ),
      ].map((value) => labeledRow([['Scope', value]])),
    ];
    const reasoning = state.ix.recording.reasoning;
    if (reasoning && !answer.answers.length) {
      const selectedSources = new Set(
        view?.occurrence ? [view.occurrence.sourceId] : (view?.node.sourceIds ?? []),
      );
      const all =
        !view || (!view.occurrence && view.node.id === state.ix.recording.project.placementId);
      const event = view?.occurrence?.sourceEventNodeId;
      const relevant = reasoning.candidates.filter(
        (candidate) =>
          all ||
          (selectedSources.has(candidate.sourceId) &&
            (!event || [candidate.valueNodeId, candidate.sourceEventNodeId].includes(event))) ||
          reasoning.chains?.some(
            (chain) =>
              chain.candidate === reasoning.candidates.indexOf(candidate) &&
              selectedSources.has(chain.otherSourceId) &&
              (!event ||
                chain.composition.interface.some(
                  ([from, to]) =>
                    [candidate.valueNodeId, candidate.sourceEventNodeId].includes(from) &&
                    to === event,
                )),
          ),
      );
      rows.push(
        ...relevant
          .slice(0, 1)
          .map((candidate) => labeledRow([['Structural candidate', candidate.text, 'input']])),
        labeledRow([['Search', 'Connected AMRs - bounded search - no model calls', 'muted']]),
      );
      if (details) {
        const sourceText = (id) => state.ix.sources.get(id)?.text ?? id;
        const pathText = (graph, steps) =>
          steps
            ?.map(
              (step) =>
                `${graph.nodes.find((node) => node.id === step.from)?.concept} ${step.forward ? step.role : step.role + '-of'} ${graph.nodes.find((node) => node.id === step.to)?.concept}`,
            )
            .join(' → ');
        for (const candidate of relevant) {
          rows.push(
            row(),
            row(`Support - ${candidate.text}`, 'section'),
            labeledRow([['Source', sourceText(candidate.sourceId), 'input']]),
          );
          const path = candidate.paths[0];
          if (path)
            rows.push(
              labeledRow([['Case', sourceText(path.caseId), 'input']]),
              labeledRow([
                [
                  'Case path',
                  pathText(
                    state.ix.graphs.get(state.ix.sources.get(path.caseId).graphId),
                    path.casePath,
                  ),
                ],
              ]),
              labeledRow([['Candidate link', path.concept]]),
              labeledRow([['Source path', pathText(candidate.sourceGraph, path.valuePath)]]),
            );
          const chain = reasoning.chains?.find(
            (chain) => chain.candidate === reasoning.candidates.indexOf(candidate),
          );
          if (chain)
            rows.push(
              labeledRow([['Linked source', sourceText(chain.otherSourceId), 'input']]),
              labeledRow([
                ['Reuse', 'SEMCAT: exact - Sources: preserved - Expansion: verified', 'muted'],
              ]),
            );
        }
        const applications =
          reasoning.applications?.filter(
            (application) => all || selectedSources.has(application.sourceId),
          ) ?? [];
        if (applications.length)
          rows.push(
            row(),
            row('Case fragment reuse', 'section'),
            ...applications.map((application) =>
              labeledRow([
                [
                  'Meaning',
                  application.composition.definition.edges
                    .filter(
                      (edge) =>
                        application.composition.interface.some(([id]) => id === edge.from) &&
                        application.composition.interface.some(([id]) => id === edge.to),
                    )
                    .map(
                      (edge) =>
                        `${application.composition.definition.nodes.find((node) => node.id === edge.from).concept} ${edge.role} ${application.composition.definition.nodes.find((node) => node.id === edge.to).concept}`,
                    )
                    .join(' - '),
                ],
                [
                  'Source',
                  state.ix.nodes.get(state.ix.sources.get(application.sourceId).nodeId).label,
                ],
              ]),
            ),
          );
        const openings = reasoning.openings.filter(
          (opening) =>
            all || selectedSources.has(opening.sourceId) || selectedSources.has(opening.inputId),
        );
        if (openings.length)
          rows.push(
            row(),
            row('Open question connections', 'section'),
            ...openings.map((opening) =>
              labeledRow([
                [
                  opening.label ?? 'Acquisition',
                  opening.kind === 'relation'
                    ? 'Missing mapped relation'
                    : opening.kind === 'concept'
                      ? opening.candidate
                        ? 'Different concepts'
                        : 'Unmapped concept'
                      : `${opening.text ?? ''} ${opening.reason}`,
                  'open',
                ],
              ]),
            ),
          );
      }
    }
    if (!details) return [...rows, row()];
    const stacks = [
      ...answerCache.output.evidence.answers,
      ...answerCache.output.evidence.candidates,
    ];
    const sources = new Map(
      stacks.flatMap((stack) => stack.sources).map((source) => [source.id, source]),
    );
    const interpretations = new Map(
      [
        ...stacks.flatMap((stack) => stack.interpretations),
        ...(answerCache.output.evidence.interpretations ?? []),
      ].map((item) => [item.id, item]),
    );
    const basisLabel = 'Recorded interpretations';
    return [
      ...rows,
      ...(interpretations.size || answer.questionParses.length
        ? [
            labeledRow([['Basis', basisLabel, 'muted']]),
            labeledRow([
              [
                'Authors',
                [
                  ...new Set(
                    [...interpretations.values()].map((rule) => rule.actor).filter(Boolean),
                  ),
                ].join(', ') || 'Recorded decisions',
                'muted',
              ],
            ]),
          ]
        : []),
      ...answer.questionParses.map((item) => labeledRow([['Question parse', item.attribution]])),
      ...[...sources.values()].flatMap((source) => [
        row(),
        labeledRow([['Evidence', source.text, 'input']]),
      ]),
      ...referenceRows([...sources.values()].flatMap((source) => source.sourceRefs ?? [])),
      ...(sources.size ? [row()] : []),
      ...[...interpretations.values()].map((rule) => labeledRow([['Interpretation', rule.name]])),
      ...(answer.skipped.length ? [row()] : []),
      ...unavailableReadings(answer.skipped).map((entry) => labeledRow([entry])),
    ];
  }
  function overview(view) {
    const occurrence = view.occurrence;
    const sourceIds = occurrence ? [occurrence.sourceId] : view.node.sourceIds;
    const eventNames = state.ix.recording.inquiry.obligation.branches
      .map((branch) => branch.concept)
      .join(' / ');
    const failed = sourceIds.filter((id) => !state.ix.sources.get(id).graphId);
    const accepted = acceptedInterpretation(state.ix, occurrence, state.interpretationDecisions);
    const links = occurrence
      ? inquiryContextLinks(state.ix, occurrence, state.interpretationDecisions)
      : null;
    let outcome;
    if (!sourceIds.length) outcome = '';
    else if (!view.visits.length) outcome = 'Not examined';
    else if (failed.length === sourceIds.length) outcome = 'Parse failed';
    else if (!occurrence) outcome = `No matching event (${eventNames})`;
    const result = [
      ...(sourceIds.length > 1 ? [labeledRow([['Sources', sourceIds.length]])] : []),
      ...sourceIds.flatMap((id, index) => [
        ...(index ? [row()] : []),
        sourceIds.length > 1
          ? sourceRow(state.ix.sources.get(id))
          : labeledRow(
              [['Source', state.ix.sources.get(id).text, 'input']],
              bindingMarks('source').spans.map((span) => ({ ...span, label: 'Source' })),
            ),
        ...(!state.ix.sources.get(id).graphId ? [row('Parse failed', 'warning', 1)] : []),
      ]),
      ...occurrenceRows(occurrence),
      ...(!accepted?.proposal.binding ? bindingRows(occurrence) : []),
      ...(accepted
        ? [
            row(),
            row(
              accepted.publicationIds?.length ? 'Applied interpretation' : 'Accepted assumption',
              'section',
            ),
            assumptionRow(acceptedLabel(accepted)),
          ]
        : []),
    ];
    const answer = currentAnswer();
    const answered = answer?.answers.length > 0;
    if (answered) result.length = 0;
    result.unshift(
      ...answerRows(true, view),
      ...(!answered && outcome && !occurrence ? [labeledRow([['State', outcome]])] : []),
      ...(!answered ? [row(), row('Source comparison', 'section')] : []),
    );
    if (!answered && links) result.push(...findingRelations(links));
    if (!answered) result.push(...connectionSummaryRows(view, links));

    if (!answered && !accepted) {
      const returned = conditionalReturnSections(
        state.ix,
        state.interpretationDecisions,
        view.node.id,
      ).filter(([title]) =>
        [
          'Conditional return - accepted interpretation',
          'Conditional return - applied interpretation',
          'Where',
          'Accepted assumption',
          'Applied interpretation',
          'Open inquiry relations',
          'Case-supported inquiry relations',
        ].includes(title),
      );
      if (returned.length)
        result.push(
          row(),
          row('Returned findings', 'section'),
          ...returned.flatMap(([title, lines]) => [
            row(),
            row(title, 'section', 1),
            ...lines.map((text, index) => returnedRow(title, text, index)),
          ]),
        );
    }
    if (!answered && state.ix.recording.inquiry.obligation.parentContext.length)
      result.push(
        row(),
        row('Question scope', 'section'),
        ...state.ix.recording.inquiry.obligation.parentContext.map((text) => row(text, 'open', 1)),
      );
    if (!answered && view.visits.some((visit) => visit.proposalIds.length))
      result.push(
        row(),
        row('Proposed changes', 'section'),
        row(
          String(view.visits.reduce((count, visit) => count + visit.proposalIds.length, 0)),
          'muted',
          1,
        ),
      );
    const assessments =
      state.investigation?.data.assessments.filter(
        (item) =>
          item.origin.path === state.activeRecordingPath &&
          item.origin.nodeId === view.node.id &&
          (!view.occurrence || item.origin.occurrenceId === view.occurrence.id),
      ) ?? [];
    const revoked = new Set(
      assessments
        .filter((item) => item.action === 'revoked')
        .map((item) => item.origin.assessmentId),
    );
    const labels = { selected: 'Candidate selected', open: 'Kept open', revoked: 'Revoked' };
    if (assessments.length)
      result.push(
        row(),
        row('Assessments', 'section'),
        ...assessments
          .filter((item) => !revoked.has(item.id))
          .flatMap((item) => [
            labeledRow([
              [
                'Assessment',
                item.action === 'revoked'
                  ? `Revoked (${labels[assessments.find((target) => target.id === item.origin.assessmentId)?.action] ?? ''})`
                  : labels[item.action],
              ],
            ]),
            ...(item.note ? [row(item.note, 'plain', 1)] : []),
          ]),
      );
    if (state.ix.recording.inquiry.retention === 'uncertain')
      result.unshift(row('Parse uncertain', 'warning'), row());
    return result;
  }
  function amrRows(view) {
    const links = inquiryContextLinks(state.ix, view.occurrence, state.interpretationDecisions);
    const annotations = (relations, edgeKey) =>
      new Map(
        relations
          .filter((r) => r[edgeKey])
          .map((r) => [
            r[edgeKey],
            [
              {
                ref: r.ref,
                status:
                  r.status === 'matched'
                    ? r.basis === 'accepted'
                      ? 'matched (assumed)'
                      : r.basis === 'binding'
                        ? 'matched (binding)'
                        : 'matched'
                    : r.status === 'case-supported'
                      ? 'case-supported'
                      : r.status,
                tone: r.status === 'matched' ? 'located' : 'open',
              },
            ],
          ]),
      );
    const queryMarks = annotations(links.relations, 'queryEdgeId');
    const sourceMarks = annotations(links.relations, 'sourceEdgeId');
    for (const connection of links.caseSupport.connections) {
      const ref = links.relations.find((item) => item.queryEdgeId === connection.queryEdgeId).ref;
      for (const [marks, ids] of [
        [queryMarks, [connection.queryEdgeId]],
        [
          sourceMarks,
          [connection.sourceEdgeId, ...connection.witnesses.map((pair) => pair.sourceEdgeId)],
        ],
      ]) {
        for (const id of ids) {
          if (!marks.has(id)) marks.set(id, []);
          const supported =
            links.relations.find((item) => item.ref === ref).status === 'case-supported';
          const status = supported ? 'case-supported' : 'case evidence';
          const previous = marks
            .get(id)
            .find((item) => item.ref === ref && item.status.startsWith('case'));
          if (!previous)
            marks
              .get(id)
              .push({ ref, status, tone: connection.status === 'linked' ? 'located' : 'open' });
          else if (connection.status !== 'linked')
            Object.assign(previous, { status, tone: 'open' });
        }
      }
    }
    const graphRows = (amrId, graphId, marks, side, eventNodeId) => {
      const response = state.ix.amrs.get(amrId)?.response;
      if (!response?.penman)
        return [
          row('Parse failed', 'warning', 1),
          ...(response?.decode_error ? [row(response.decode_error, 'muted', 1)] : []),
        ];
      const penman = response.penman;
      const source = [...state.ix.sources.values()].find((item) => item.graphId === graphId);
      const accepted =
        links.accepted ??
        (source &&
          acceptedInterpretation(
            state.ix,
            { id: null, sourceId: source.id },
            state.interpretationDecisions,
          ));
      const querySide = graphId === links.query.id;
      const edits = querySide ? accepted?.proposal.queryEdits : accepted?.proposal.sourceEdits;
      const derived = edits?.length
        ? querySide
          ? accepted.review.query
          : accepted.review.source
        : null;
      const originalMarks = derived ? new Map() : marks;
      const positions = penmanEdgeLocations(penman, state.ix.graphs.get(graphId));
      let offset = 0;
      const original = penman.split('\n').map((line) => {
        const edges = positions.filter((p) => p.start >= offset && p.start < offset + line.length);
        const spans = [],
          notes = [];
        for (const edge of edges) {
          const refs = originalMarks.get(edge.edgeId) ?? [];
          if (!refs.length) continue;
          spans.push({
            start: edge.start - offset,
            end: edge.end - offset,
            tone: refs.some((r) => r.tone === 'open') ? 'open' : 'located',
          });
          for (const ref of refs)
            if (!notes.some((n) => n.ref === ref.ref && n.status === ref.status)) notes.push(ref);
        }
        offset += line.length + 1;
        let value = line;
        if (notes.length) {
          value += '  # ';
          for (const [i, note] of notes.entries()) {
            if (i) value += '; ';
            const start = value.length;
            value += `${note.ref} ${note.status}`;
            spans.push({ start, end: value.length, tone: note.tone });
          }
        }
        const selected = eventNodeId && line.match(/\(([^\s/()]+)\s*\//u)?.[1] === eventNodeId;
        return {
          ...row(value, selected ? 'amr-event' : 'amr', 1),
          spans,
          eventNodeId,
          nodes: side ? bindingMarks(side).nodes : [],
        };
      });
      return derived
        ? [
            ...original,
            row(),
            row('Accepted parse', 'section'),
            ...derived.nodes.map((node) =>
              row(
                `${node.id}: ${node.concept}${node.id === derived.top ? ' (root)' : ''}`,
                'amr',
                1,
              ),
            ),
            ...derived.edges.map((edge) =>
              row(
                `${edge.id}: ${interpretationEdge(derived, edge)}${(marks.get(edge.id) ?? []).map((ref) => `; ${ref.ref} ${ref.status}`).join('')}`,
                'amr',
                1,
              ),
            ),
          ]
        : original;
    };
    const rows = [
      row('Inquiry AMR', 'section'),
      ...graphRows(
        state.ix.recording.inquiry.amrId,
        state.ix.recording.inquiry.graphId,
        queryMarks,
        'query',
        view.occurrence?.requiredRefs[0]?.eventNode,
      ),
    ];
    if (links.accepted) rows.push(row(), assumptionRow(acceptedLabel(links.accepted)));
    const bindings = bindingPresentation(view.occurrence, state.ix);
    if (bindings.length && !links.accepted?.proposal.binding)
      rows.push(
        row(),
        row('Proposed binding', 'section'),
        ...bindings.map((item) => ({ ...row(item.caption, 'plain', 1), spans: item.spans })),
      );
    const sources = view.occurrence ? [view.occurrence.sourceId] : view.node.sourceIds;
    for (const id of sources) {
      const source = state.ix.sources.get(id);
      rows.push(
        row(),
        row(`${view.node.label} - Source sentence`, 'section'),
        sourceRow(source),
        row(),
        { ...row('Source AMR', 'section'), continueSection: true },
        ...graphRows(
          source.amrId,
          source.graphId,
          id === links.sourceId ? sourceMarks : new Map(),
          'source',
          view.occurrence?.sourceEventNodeId,
        ),
      );
    }
    for (const item of carriedContext(
      links.effective,
      view.visits.map((visit) => links.effective.visits.get(visit.id)),
      view.occurrence?.sourceId,
    )) {
      const marks = new Map();
      for (const check of item.checks)
        for (const anchor of check.anchors ?? []) {
          for (const [pairs, status, tone] of [
            [anchor.shared, 'shared', 'located'],
            [unmatchedContextDifferences(anchor), 'different', 'open'],
          ]) {
            for (const pair of pairs)
              for (const relation of links.forSourceEdge(check.localSourceId, pair.sourceEdgeId)) {
                if (!marks.has(pair.fromEdgeId)) marks.set(pair.fromEdgeId, []);
                const refs = marks.get(pair.fromEdgeId);
                const linkedStatus = ['case', 'context'].includes(relation.basis)
                  ? `${status} (${relation.basis})`
                  : status;
                if (!refs.some((r) => r.ref === relation.ref && r.status === linkedStatus))
                  refs.push({ ref: relation.ref, status: linkedStatus, tone });
              }
          }
        }
      for (const connection of links.caseSupport.connections.filter(
        (entry) => entry.inheritedSourceId === item.source.id,
      )) {
        const ref = links.relations.find(
          (entry) => entry.queryEdgeId === connection.queryEdgeId,
        ).ref;
        for (const id of connection.scopePath) {
          if (!marks.has(id)) marks.set(id, []);
          if (!marks.get(id).some((entry) => entry.ref === ref && entry.status === 'scope'))
            marks.get(id).push({ ref, status: 'scope', tone: 'open' });
        }
      }
      rows.push(
        row(),
        row(`${item.node.label} - ${item.kind}`, 'section'),
        sourceRow(item.source),
        row(),
        ...graphRows(item.source.amrId, item.source.graphId, marks),
      );
    }
    return rows;
  }
  function pageRows(view) {
    const rawContent = state.help
      ? helpRows
      : state.page === 'setup'
        ? contextRows()
        : state.page === 'overview'
          ? overview(view)
          : state.page === 'context'
            ? carryRows(view)
            : state.page === 'source'
              ? amrRows(view)
              : state.page === 'provenance'
                ? [
                    ...(state.ix.recording.reasoning
                      ? [
                          row('Inquiry engine', 'section'),
                          labeledRow([
                            ['Run', state.ix.recording.reasoning.runId],
                            [
                              'Elapsed',
                              `${(state.ix.recording.reasoning.elapsedMs / 1000).toFixed(2)} s`,
                            ],
                          ]),
                          ...state.ix.recording.reasoning.calls.map((call) =>
                            labeledRow([
                              [
                                `${call.client} - ${call.stage}`,
                                `${call.status} - ${(call.durationMs / 1000).toFixed(2)} s`,
                              ],
                            ]),
                          ),
                          row(),
                        ]
                      : []),
                    ...provenanceSections(state.ix, view).flatMap(([title, lines], index) => [
                      ...(index ? [row()] : []),
                      row(title, 'section'),
                      ...lines.map((line) =>
                        title === 'Source sentence' ? row(line, 'plain', 1) : metadataRow(line),
                      ),
                    ]),
                    ...originRows(view),
                    ...routeRows(view),
                    ...conditionalReturnSections(
                      state.ix,
                      state.interpretationDecisions,
                      view.node.id,
                    )
                      .filter(([title]) => title === 'Return provenance')
                      .flatMap(([title, lines]) => [
                        row(),
                        row(title, 'section'),
                        ...lines.map(metadataRow),
                      ]),
                  ]
                : state.page === 'scope'
                  ? inquiryRows(view)
                  : [
                      ...view.detail.flatMap((text) => {
                        const tone =
                          text === 'Parse failed'
                            ? 'warning'
                            : text.startsWith('Parser reason:') ||
                                text.startsWith('Source text retained;')
                              ? 'muted'
                              : text.startsWith('? ')
                                ? 'open'
                                : text.startsWith('= ')
                                  ? 'located'
                                  : /^(≠ |ALTERNATIVE )/u.test(text)
                                    ? 'alternative'
                                    : /^(SOURCE MARKER |PARENT )/u.test(text)
                                      ? 'warning'
                                      : text.startsWith('PARSED EVENT')
                                        ? 'event-label'
                                        : /^(EMBEDDING |SOURCE GRAPH|SOURCE CONTEXT|SOURCE WITNESS|OCCURRENCE|SOURCE AMR|QUERY AMR|AMR )/u.test(
                                              text,
                                            )
                                          ? 'muted'
                                          : 'plain';
                        if (
                          text.startsWith('SOURCE ') &&
                          view.occurrence &&
                          text.slice(7) === state.ix.sources.get(view.occurrence.sourceId).text
                        )
                          return [
                            {
                              ...row(text, tone),
                              spans: bindingMarks('source').spans.map((span) => ({
                                ...span,
                                start: span.start + 7,
                                end: span.end + 7,
                              })),
                            },
                          ];
                        return [codeRow(text, tone, 0, 'query')];
                      }),
                    ];
    return rawContent.map((item) => ({
      ...item,
      ...(item.text && item.tone !== 'section' ? { indent: Math.max(1, item.indent) } : {}),
      ...(state.page === 'source' &&
      !state.help &&
      item.tone === 'section' &&
      ['Source AMR', 'Proposed binding'].includes(item.text)
        ? { continueSection: true }
        : {}),
    }));
  }

  return { pageRows, passageRows, bindingMarks, assumptionRow };
}
