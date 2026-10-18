/** Authored interpretation operations, preview, and scoped decisions. */
import {
  authorInterpretation,
  reviewInterpretation,
  acceptedInterpretation,
  interpretationStatus,
  projectInterpretations,
  saveInterpretationDecision,
} from '../../recording/interpretation.mjs';
import { graphRevision } from '../../recording/revisions.mjs';
import { reviseGraph } from '../../amr/revision.mjs';
import {
  storeMapping,
  storeSourceParse,
  resolveMapping,
} from '../../project/authoring/mappings.mjs';
import { textDigest, currentAsk } from '../../project/inquiries/investigation.mjs';
import { inquiryContextLinks, selectedMaterial } from '../recordings/view.mjs';
import { evidenceOpenings } from '../../recording/continuation.mjs';
import { caseReference } from '../../recording/case-support.mjs';
import {
  nodeReading,
  relationReading,
  nodeChoices,
  parseChanges,
  mappingReading,
} from '../shell/wording.mjs';
import { openGraphEditor } from './graph-editor.mjs';
import { evaluateAnswer } from '../../recording/answers.mjs';

export function createInterpretation({
  state,
  config = {},
  forms,
  projects,
  investigation,
  setNotice,
}) {
  const modified = (p) =>
    Boolean(
      p.mappings.length ||
      p.binding ||
      p.caseBinding ||
      p.queryEdits.length ||
      p.sourceEdits.length,
    );
  const applied = (editor) => editor.proposal.id === editor.appliedProposal?.id;
  const operationsKey = (p) =>
    JSON.stringify([
      p.mappings
        .map((item) => [item.queryNodeId, item.sourceNodeId, item.queryConcept, item.sourceConcept])
        .sort(),
      p.binding && [p.binding.queryNodeId, p.binding.sourceNodeId],
      p.caseBinding && [p.caseBinding.queryNodeId, p.caseBinding.caseNodeId],
      p.queryEdits,
      p.sourceEdits,
      p.scope.queryEvent,
      p.scope.sourceEvent,
    ]);
  const cmd = (key, description, run) => ({ pane: 'reading', key, description, run });
  const graphText = (graph) =>
    graph.id === state.ix.recording.inquiry.graphId
      ? state.ix.recording.inquiry.text
      : ([...state.ix.sources.values()].find((source) => source.graphId === graph.id)?.text ?? '');
  const nodeLabel = (graph, id) => nodeReading(graph, id, graphText(graph)).label;
  const edgeLabel = (graph, edge) => relationReading(graph, edge, graphText(graph)).label;
  const caseSources = () =>
    (state.ix.nodes.get(state.ix.recording.caseState?.rootNodeId)?.sourceIds ?? []).map(
      (id) => state.ix.sources.get(id).text,
    );
  function readingContext(form, editor, target = null) {
    const scope = editor.proposal.scope;
    const query = editor.preview?.query ?? state.ix.graphs.get(scope.queryGraphId);
    const source = editor.preview?.source ?? state.ix.graphs.get(scope.sourceGraphId);
    form.contextRows = [
      ...(form === editor ? [['Question', state.ix.recording.inquiry.text, 'input']] : []),
      ...(editor.proposal.scope.sourceId
        ? [['Source', state.ix.sources.get(editor.proposal.scope.sourceId).text, 'input']]
        : []),
      ...(form === editor && query && source && scope.queryEvent && scope.sourceEvent
        ? [
            [
              'Comparison',
              `${nodeLabel(query, scope.queryEvent)} ↔ ${nodeLabel(source, scope.sourceEvent)}`,
            ],
          ]
        : []),
      ...(target
        ? [[target.side === 'query' ? 'Question relation' : 'Source relation', target.label]]
        : []),
    ];
    const sentences = caseSources();
    form.contextGroups = sentences.length
      ? [
          [
            `Case - ${state.ix.nodes.get(state.ix.recording.caseState.rootNodeId).label}`,
            sentences,
            'plain',
          ],
        ]
      : [];
    form.highlights = target?.highlights ?? [];
  }
  function selectedSource() {
    const occurrence = state.ix.occurrences.get(state.selection.occurrenceId);
    const opening =
      state.page === 'scope'
        ? evidenceOpenings(state.ix, state.selection, state.interpretationDecisions)[
            state.openingIndex ?? 0
          ]
        : null;
    if (opening?.sourceId) return state.ix.sources.get(opening.sourceId);
    return state.ix.sources.get(
      occurrence?.sourceId ??
        state.ix.nodes
          .get(state.selection.nodeId)
          ?.sourceIds.find((id) => state.ix.sources.get(id).graphId),
    );
  }
  function rebuild(editor, patch = {}) {
    const previous = editor.proposal;
    editor.proposal = authorInterpretation(state.ix, {
      ...previous.scope,
      ...previous,
      ...patch,
      supersedes:
        interpretationStatus(previous, state.interpretationDecisions) === 'accepted'
          ? previous.id
          : previous.supersedes,
      occurrenceId: previous.scope.occurrenceId,
      sourceId: previous.scope.sourceId,
      queryEvent: patch.queryEvent ?? previous.scope.queryEvent,
      sourceEvent: patch.sourceEvent ?? previous.scope.sourceEvent,
    });
    if (
      editor.appliedProposal &&
      operationsKey(editor.proposal) === operationsKey(editor.appliedProposal)
    )
      editor.proposal = editor.appliedProposal;
    refresh(editor);
  }
  function refresh(editor) {
    const proposal = editor.proposal;
    let review;
    try {
      review = reviewInterpretation(state.ix, proposal);
      editor.error = '';
    } catch (error) {
      editor.error = error.message;
    }
    editor.preview = review ?? null;
    const query = review?.query ?? state.ix.graphs.get(proposal.scope.queryGraphId);
    const status = applied(editor)
      ? 'applied'
      : interpretationStatus(proposal, state.interpretationDecisions);
    const occurrence =
      state.ix.occurrences.get(proposal.scope.occurrenceId) ??
      [...state.ix.occurrences.values()].find((item) => item.sourceId === proposal.scope.sourceId);
    readingContext(editor, editor);
    editor.title = modified(proposal)
      ? `Interpretation - ${status === 'proposed' ? 'draft' : status}`
      : 'Interpretation';
    if (!modified(proposal)) {
      editor.move = targets(editor);
      editor.confirm = false;
      editor.interpretationView = null;
      editor.interpretationConnections = editor;
      editor.index = Math.min(editor.index, editor.move.length - 1);
      editor.submitLabel = 'details';
      return;
    }
    delete editor.move;
    delete editor.interpretationConnections;
    editor.confirm = true;
    editor.submitLabel = status === 'applied' ? null : 'accept';
    const before =
      review && occurrence
        ? inquiryContextLinks(state.ix, occurrence, state.interpretationDecisions)
        : null;
    const after =
      review && occurrence
        ? inquiryContextLinks(state.ix, occurrence, [
            ...state.interpretationDecisions,
            { id: 'preview', proposal, decision: 'accepted' },
          ])
        : null;
    const metric = (label, from, to) =>
      status === 'proposed' && from !== to ? [[label, `${from} → ${to}`]] : [];
    const open = after
      ? after.relations
          .filter((item) => ['open', 'unresolved'].includes(item.status))
          .map((item) =>
            edgeLabel(
              query,
              query.edges.find((edge) => edge.id === item.queryEdgeId),
            ),
          )
      : (review?.unresolved.map((edge) => edgeLabel(query, edge)) ?? []);
    const changedRelations = (from, to, graph) =>
      to.relations
        .filter(
          (item) =>
            item.status === 'matched' &&
            from.relations.find((other) => other.queryEdgeId === item.queryEdgeId)?.status !==
              'matched',
        )
        .map((item) =>
          edgeLabel(
            graph,
            graph.edges.find((edge) => edge.id === item.queryEdgeId),
          ),
        );
    const operationRows = (p, pair) => [
      ...p.mappings.map((item) => [
        'Map',
        mappingReading(item, {
          query: pair.query,
          source: pair.source,
          queryText: graphText(pair.query),
          sourceText: graphText(pair.source),
        }),
      ]),
      ...(p.binding
        ? [
            [
              'Answer',
              `${nodeLabel(pair.query, p.binding.queryNodeId)} → ${nodeLabel(pair.source, p.binding.sourceNodeId)}`,
            ],
          ]
        : []),
      ...(p.caseBinding
        ? [
            [
              'Bind case',
              `${nodeLabel(pair.query, p.caseBinding.queryNodeId)} → ${state.ix.nodes.get(p.caseBinding.caseNodeId).label}`,
            ],
          ]
        : []),
      ...parseChanges(state.ix.graphs.get(p.scope.queryGraphId), p.queryEdits).map((change) => [
        'Question parse',
        change,
      ]),
      ...parseChanges(state.ix.graphs.get(p.scope.sourceGraphId), p.sourceEdits).map((change) => [
        'Source parse',
        change,
      ]),
    ];
    const basis = editor.appliedProposal
      ? operationRows(
          editor.appliedProposal,
          reviewInterpretation(state.ix, editor.appliedProposal),
        )
      : [];
    const current = operationRows(proposal, review ?? graphs(editor));
    const includes = (rows, entry) =>
      rows.some((item) => JSON.stringify(item) === JSON.stringify(entry));
    editor.interpretationView = {
      basis,
      changes: [
        ...current.filter((entry) => !includes(basis, entry)),
        ...basis
          .filter((entry) => !includes(current, entry))
          .map(([label, value]) => [`Remove ${label.toLowerCase()}`, value]),
      ],
      changeLabel: status === 'accepted' ? 'Accepted changes' : 'Proposed changes',
      metrics: review
        ? [
            ...metric(
              'Matched',
              before?.assessment.matched ?? review.beforeCount,
              after?.assessment.matched ?? review.afterCount,
            ),
            ...(state.ix.recording.caseState
              ? metric(
                  'Case-supported',
                  before?.assessment.caseSupported ?? 0,
                  after?.assessment.caseSupported ?? 0,
                )
              : []),
            ...metric(
              'Open',
              before?.assessment.unsupported ?? review.before.queryOnly.length,
              open.length,
            ),
          ]
        : [],
      partial: review && !review.complete,
      groups: [
        [
          'Added',
          before && after
            ? changedRelations(before, after, query)
            : (review?.added.map((edge) => edgeLabel(query, edge)) ?? []),
          'located',
        ],
        [
          'Lost',
          before && after
            ? changedRelations(after, before, before.query)
            : (review?.lost.map((edge) =>
                edgeLabel(state.ix.graphs.get(proposal.scope.queryGraphId), edge),
              ) ?? []),
          'warning',
        ],
        [
          'Case-supported',
          after?.relations
            .filter((item) => item.status === 'case-supported')
            .map((item) =>
              edgeLabel(
                query,
                query.edges.find((edge) => edge.id === item.queryEdgeId),
              ),
            ) ?? [],
          'located',
        ],
        ['Open', open, 'plain'],
      ].filter(([, lines]) => lines.length),
    };
  }
  function chooseNode(title, graph, choose, editor, filter = () => true) {
    const contextLabel = graph.id === editor.proposal.scope.queryGraphId ? 'Question' : 'Source';
    investigation.picker(
      title,
      nodeChoices(graph, graphText(graph), contextLabel, filter),
      ({ node }) => choose(node),
      editor,
    );
    if (state.form !== editor) readingContext(state.form, editor, editor.target);
  }
  function graphs(editor) {
    return {
      query: reviseGraph(
        state.ix.graphs.get(editor.proposal.scope.queryGraphId),
        editor.proposal.queryEdits,
        false,
      ),
      source: editor.proposal.scope.sourceGraphId
        ? reviseGraph(
            state.ix.graphs.get(editor.proposal.scope.sourceGraphId),
            editor.proposal.sourceEdits,
            false,
          )
        : null,
    };
  }
  function map(editor, binding = false) {
    const { query, source } = graphs(editor);
    if (!source) return;
    const selected = (side, node) =>
      !editor.target || editor.target.side !== side || editor.target.nodeIds.includes(node.id);
    forms.selectPair(
      binding ? 'Interpretation - bind answer' : 'Interpretation - map wording',
      [
        {
          label: 'Question wording',
          choices: nodeChoices(
            query,
            graphText(query),
            'Question',
            (node) => selected('query', node) && (!binding || node.concept === 'amr-unknown'),
          ),
        },
        {
          label: 'Source wording',
          choices: nodeChoices(source, graphText(source), 'Source', (node) =>
            selected('source', node),
          ),
        },
      ],
      ([{ node: left }, { node: right }]) => {
        if (binding) rebuild(editor, { binding: { queryNodeId: left.id, sourceNodeId: right.id } });
        else
          rebuild(editor, {
            mappings: [
              ...editor.proposal.mappings.filter((item) => item.queryNodeId !== left.id),
              {
                queryNodeId: left.id,
                sourceNodeId: right.id,
                queryConcept: left.concept,
                sourceConcept: right.concept,
              },
            ],
          });
        state.form = editor;
        state.offset = 0;
      },
    );
    readingContext(state.form, editor, editor.target);
  }
  function anchors(editor) {
    const { query, source } = graphs(editor);
    if (!source) return;
    chooseNode(
      'Question anchor',
      query,
      (left) =>
        chooseNode(
          'Source anchor',
          source,
          (right) => rebuild(editor, { queryEvent: left.id, sourceEvent: right.id }),
          editor,
          (node) => node.concept === left.concept,
        ),
      editor,
    );
  }
  function bindCase(editor) {
    const { query } = graphs(editor);
    const occurrence = state.ix.occurrences.get(editor.proposal.scope.occurrenceId);
    const connections = occurrence
      ? inquiryContextLinks(state.ix, occurrence, state.interpretationDecisions).carriedSupport
          .connections
      : [];
    const ids = new Set(
      connections
        .filter(
          (item) =>
            item.rootCase &&
            item.status === 'linked' &&
            (!editor.target ||
              editor.target.side !== 'query' ||
              item.queryEdgeId === editor.target.edge?.id),
        )
        .map((item) => item.queryNodeId),
    );
    if (editor.proposal.caseBinding) ids.add(editor.proposal.caseBinding.queryNodeId);
    chooseNode(
      'Bind case - question wording',
      query,
      (node) =>
        rebuild(editor, {
          caseBinding: {
            queryNodeId: node.id,
            caseNodeId: state.ix.recording.caseState.rootNodeId,
          },
        }),
      editor,
      (node) => ids.has(node.id),
    );
  }
  function revise(editor) {
    const selectSide = ({ side }) => {
      const key = `${side}Edits`,
        original = state.ix.graphs.get(editor.proposal.scope[`${side}GraphId`]);
      const recording = state.ix.recording,
        knowledge = state.answerKnowledge?.knowledge ?? recording.knowledge ?? {};
      const baseline = evaluateAnswer(recording, knowledge);
      const form = openGraphEditor({
        state,
        forms,
        picker: investigation.picker,
        title: `Interpretation - ${side === 'query' ? 'question' : 'source'} parse`,
        original,
        sourceText: graphText(original),
        returnForm: editor,
        contextRows: [[side === 'query' ? 'Question' : 'Source', graphText(original), 'input']],
        getEdits: () => editor.proposal[key],
        setEdits: (edits) => rebuild(editor, { [key]: edits }),
        evaluate: () => {
          const proposal = editor.proposal,
            review = editor.preview;
          if (!review) throw new Error(editor.error || 'Comparison unavailable');
          const source = state.ix.sources.get(proposal.scope.sourceId);
          const draft = {
            ...knowledge,
            queryParses: proposal.queryEdits.length
              ? [
                  {
                    id: 'preview-query',
                    revision: proposal.scope.queryRevision,
                    edits: proposal.queryEdits,
                  },
                ]
              : knowledge.queryParses,
            parses: proposal.sourceEdits.length
              ? [
                  ...(knowledge.parses ?? []).filter(
                    (parse) =>
                      parse.sourceText !== source.text ||
                      (parse.placementId && parse.placementId !== source.nodeId),
                  ),
                  {
                    id: 'preview-source',
                    sourceText: source.text,
                    placementId: source.nodeId,
                    sourceRevision: proposal.scope.sourceRevision,
                    edits: proposal.sourceEdits,
                  },
                ]
              : knowledge.parses,
          };
          const result = evaluateAnswer(recording, draft);
          return [
            ['Local matches', String(review.beforeCount), String(review.afterCount)],
            [
              'Local openings',
              String(review.before.queryOnly.length),
              String(review.after.queryOnly.length),
            ],
            ['Inquiry state', baseline.status, result.status],
            ...(baseline.answers.length || result.answers.length
              ? [
                  [
                    'Answer',
                    baseline.answers.map((a) => a.text).join('; '),
                    result.answers.map((a) => a.text).join('; '),
                  ],
                ]
              : []),
          ];
        },
      });
      form.parseItems = { editor };
    };
    if (editor.target?.side) selectSide(editor.target);
    else {
      investigation.picker(
        'Graph',
        [
          { label: 'Question', side: 'query' },
          ...(editor.proposal.scope.sourceGraphId ? [{ label: 'Source', side: 'source' }] : []),
        ],
        selectSide,
        editor,
      );
      readingContext(state.form, editor);
    }
  }
  async function decide(editor, decision) {
    if (applied(editor)) return;
    if (decision === 'accepted' && !editor.preview?.complete) return;
    const proposal = editor.proposal;
    if (interpretationStatus(proposal, state.interpretationDecisions) === decision) return;
    if (!(
      proposal.mappings.length ||
      proposal.binding ||
      proposal.caseBinding ||
      proposal.queryEdits.length ||
      proposal.sourceEdits.length
    ))
      return;
    state.interpretationDecisions = await saveInterpretationDecision(
      state.activeRecordingPath,
      state.ix,
      proposal,
      decision,
      state.interpretationDecisions,
      { actor: config.actor ?? 'local-workbench-user', via: 'editor' },
    );
    if (proposal.caseBinding && state.investigation && state.project) {
      const data = structuredClone(state.investigation.data),
        ask =
          data.asks.find((item) => item.id === state.ix.recording.ask?.askId) ?? currentAsk(data);
      if (ask?.caseSelection && ask.question === state.ix.recording.inquiry.text) {
        ask.caseSelection.binding =
          decision === 'accepted'
            ? {
                ...proposal.caseBinding,
                graphDigest: graphRevision(editor.preview.query),
                questionDigest: textDigest(state.ix.recording.inquiry.text),
                decisionId: state.interpretationDecisions.at(-1).id,
              }
            : null;
        await investigation.persist(data);
      }
    }
    state.ix = projectInterpretations(state.ix, state.interpretationDecisions);
    if (!state.selection.occurrenceId && proposal.scope.sourceId)
      state.selection.occurrenceId =
        [...state.ix.occurrences.values()].find((item) => item.sourceId === proposal.scope.sourceId)
          ?.id ?? null;
    if (!state.ix.occurrences.has(state.selection.occurrenceId))
      state.selection.occurrenceId = null;
    refresh(editor);
    setNotice(decision);
  }
  function open(chosenSource = null, operation = null) {
    const occurrence = state.ix.occurrences.get(state.selection.occurrenceId),
      source = chosenSource ?? selectedSource();
    const sources = state.ix.nodes
      .get(state.selection.nodeId)
      .sourceIds.map((id) => state.ix.sources.get(id))
      .filter((item) => item.graphId);
    if (!occurrence && !chosenSource && state.page !== 'scope' && sources.length > 1) {
      investigation.picker(
        'Source',
        sources.map((source) => ({ label: source.text, source })),
        ({ source }) => open(source, operation),
      );
      return;
    }
    const accepted = acceptedInterpretation(
      state.ix,
      occurrence ?? { id: null, sourceId: source?.id ?? null },
      state.interpretationDecisions,
    );
    const options =
      accepted?.proposal.kind === 'local-interpretation-v2'
        ? { ...accepted.proposal, ...accepted.proposal.scope, supersedes: accepted.proposal.id }
        : { sourceId: source?.graphId ? source.id : null, occurrenceId: occurrence?.id ?? null };
    const proposal =
      accepted?.proposal.kind === 'local-interpretation-v2'
        ? accepted.proposal
        : authorInterpretation(state.ix, options);
    forms.startForm(
      'Interpretation',
      [],
      () =>
        state.form.move
          ? (state.form.detailsOpen = !state.form.detailsOpen)
          : decide(state.form, 'accepted'),
      { submitLabel: 'accept' },
    );
    const editor = state.form;
    Object.assign(editor, {
      interpretationEditor: true,
      proposal,
      confirm: true,
      appliedProposal: accepted?.publicationIds?.length ? proposal : null,
    });
    refresh(editor);
    if (operation === 'case') {
      bindCase(editor);
      state.form.back = editor.back;
    } else if (state.page === 'scope' && !modified(proposal)) {
      const opening = evidenceOpenings(state.ix, state.selection, state.interpretationDecisions)[
        state.openingIndex ?? 0
      ];
      let target = editor.move.find(
        (item) =>
          item.edge?.id === opening?.edge?.id &&
          item.side === (opening?.kind === 'query' ? 'query' : 'source'),
      );
      if (!target && opening?.edge) {
        const side = opening.kind === 'query' ? 'query' : 'source',
          graph = graphs(editor)[side];
        const reading = relationReading(graph, opening.edge, graphText(graph));
        target = {
          side,
          edge: opening.edge,
          nodeIds: [opening.edge.from, opening.edge.to],
          label: reading.label,
          highlights: reading.spans.map((span) => ({
            label: side === 'query' ? 'Question' : 'Source',
            ...span,
          })),
        };
      }
      if (target) {
        selectTarget(editor, target);
        state.form.back = editor.back;
      }
    }
  }
  function remove(editor) {
    const p = editor.proposal;
    investigation.picker(
      'Remove',
      [
        ...p.mappings.map((item, index) => ({
          label: `${item.queryConcept} ↔ ${item.sourceConcept}`,
          kind: 'mapping',
          index,
        })),
        ...(p.binding ? [{ label: 'Answer binding', kind: 'binding' }] : []),
        ...(p.caseBinding ? [{ label: 'Case binding', kind: 'caseBinding' }] : []),
        ...['queryEdits', 'sourceEdits'].flatMap((kind) =>
          parseChanges(
            state.ix.graphs.get(
              kind === 'queryEdits' ? p.scope.queryGraphId : p.scope.sourceGraphId,
            ),
            p[kind],
          ).map((label, index) => ({
            label,
            group: kind === 'queryEdits' ? 'Question parse' : 'Source parse',
            kind,
            index,
          })),
        ),
      ],
      (choice) =>
        rebuild(
          editor,
          choice.kind === 'mapping'
            ? { mappings: p.mappings.filter((_, index) => index !== choice.index) }
            : choice.index !== undefined
              ? { [choice.kind]: p[choice.kind].filter((_, index) => index !== choice.index) }
              : { [choice.kind]: null },
        ),
      editor,
    );
  }
  async function saveMapping(editor, sourceParse = false) {
    const accepted = state.interpretationDecisions.findLast(
      (item) => item.proposal.id === editor.proposal.id && item.decision === 'accepted',
    );
    if (!accepted || !state.project) return;
    forms.startForm(
      sourceParse ? 'Save source parse' : 'Save mapping',
      [['Name']],
      async ([name]) => {
        state.project = await projects.persistProject(
          state.project,
          sourceParse
            ? storeSourceParse(state.project, {
                name,
                proposal: editor.proposal,
                decisionId: accepted.id,
                actor: accepted.actor,
                source:
                  state.ix.baseIndex?.graphs.get(editor.proposal.scope.sourceGraphId) ??
                  state.ix.graphs.get(editor.proposal.scope.sourceGraphId),
                sourceText: state.ix.sources.get(editor.proposal.scope.sourceId).text,
              })
            : storeMapping(state.project, {
                name,
                proposal: editor.proposal,
                actor: accepted.actor,
                decisionId: accepted.id,
                query: editor.preview.query,
                source: editor.preview.source,
              }),
        );
        forms.cancelForm();
        setNotice('Saved');
      },
    );
    state.form.returnForm = editor;
    readingContext(state.form, editor);
    state.form.contextRows.push([
      'Scope',
      sourceParse ? 'Same source text and parser graph' : 'Project mapping',
    ]);
  }
  function reuse(editor) {
    const { query, source } = graphs(editor);
    investigation.picker(
      'Saved interpretations',
      availableMappings(editor).map((entry) => ({
        label: entry.name,
        entry,
        details:
          entry.kind === 'source-parse'
            ? [
                ['Source', [entry.sourceText]],
                ['Scope', ['Same source text and parser graph']],
                ['Parse changes', parseChanges(source, entry.edits)],
              ]
            : [
                [
                  'Mappings',
                  entry.pairs.map((pair) => `${pair.queryConcept} ↔ ${pair.sourceConcept}`),
                ],
              ],
      })),
      ({ entry }) => {
        const resolved = resolveMapping(entry, query, source, { sourceText: graphText(source) });
        if (resolved.some((item) => item.status === 'absent')) {
          editor.error = 'Mapping absent';
          return;
        }
        if (entry.kind === 'source-parse') {
          rebuild(editor, {
            sourceEdits: structuredClone(entry.edits),
            reusedFrom: {
              mappingId: entry.id,
              projectId: state.project.data.id,
              projectRevision: state.project.digest,
              decisionId: entry.origin.decisionId,
            },
          });
          return;
        }
        const pick = (title, graph, concept, done) => {
          const candidates = graph.nodes.filter((node) => node.concept === concept);
          if (candidates.length === 1) done(candidates[0]);
          else chooseNode(title, graph, done, editor, (node) => node.concept === concept);
        };
        pick('Question anchor', query, entry.queryEvent, (left) =>
          pick('Source anchor', source, entry.sourceEvent, (right) => {
            const next = (index, mappings = []) => {
              if (index === entry.pairs.length) {
                rebuild(editor, {
                  queryEvent: left.id,
                  sourceEvent: right.id,
                  mappings,
                  reusedFrom: {
                    mappingId: entry.id,
                    projectId: state.project.data.id,
                    projectRevision: state.project.digest,
                    decisionId: entry.origin.decisionId,
                  },
                });
                return;
              }
              const pair = entry.pairs[index];
              pick('Question node', query, pair.queryConcept, (q) =>
                pick('Source node', source, pair.sourceConcept, (s) => {
                  next(index + 1, [
                    ...mappings,
                    { queryNodeId: q.id, sourceNodeId: s.id, ...pair },
                  ]);
                }),
              );
            };
            next(0);
          }),
        );
      },
      editor,
    );
    if (state.form !== editor) readingContext(state.form, editor, editor.target);
  }
  function availableMappings(editor) {
    const { query, source } = graphs(editor);
    return source
      ? (state.project?.data.interpretationMappings ?? []).filter((entry) =>
          resolveMapping(entry, query, source, { sourceText: graphText(source) }).every(
            (item) => item.status !== 'absent',
          ),
        )
      : [];
  }
  function targets(editor) {
    const { query, source } = graphs(editor),
      review = editor.preview;
    const occurrence = state.ix.occurrences.get(editor.proposal.scope.occurrenceId);
    const links = occurrence
      ? inquiryContextLinks(
          state.ix,
          occurrence,
          modified(editor.proposal) && review
            ? [
                ...state.interpretationDecisions,
                { id: 'preview', proposal: editor.proposal, decision: 'accepted' },
              ]
            : state.interpretationDecisions,
        )
      : null;
    const queryChoices = query.edges.map((edge) => {
      const reading = relationReading(query, edge, graphText(query));
      const status =
        links?.relations.find((item) => item.queryEdgeId === edge.id)?.status ??
        (review?.after.shared.some((item) => item.queryEdge.id === edge.id) ? 'matched' : 'open');
      const answer =
        edge.role === ':polarity' &&
        query.nodes.some((node) => node.id === edge.to && node.concept === 'amr-unknown');
      return {
        label: reading.label,
        tone: status === 'matched' || status === 'case-supported' ? 'located' : 'plain',
        group: answer
          ? 'Answer'
          : status === 'matched'
            ? 'Matched'
            : status === 'case-supported'
              ? 'Case-supported'
              : 'Open',
        side: 'query',
        edge,
        nodeIds: [edge.from, edge.to],
        details: [['Parse', [reading.parse]]],
        highlights: reading.spans.map((span) => ({ label: 'Question', ...span })),
      };
    });
    const groups = ['Open', 'Answer', 'Case-supported', 'Matched'];
    queryChoices.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group));
    const sourceChoices = (review?.after.sourceOnly ?? source?.edges ?? []).map((edge) => {
      const reading = relationReading(source, edge, graphText(source));
      return {
        label: reading.label,
        tone: 'muted',
        group: 'Source relations',
        side: 'source',
        edge,
        nodeIds: [edge.from, edge.to],
        details: [['Parse', [reading.parse]]],
        highlights: reading.spans.map((span) => ({ label: 'Source', ...span })),
      };
    });
    return [
      ...queryChoices,
      ...sourceChoices,
      ...(!queryChoices.length && !sourceChoices.length
        ? nodeChoices(query, graphText(query), 'Question').map((item) => ({
            ...item,
            side: 'query',
            nodeIds: [item.node.id],
          }))
        : []),
    ];
  }
  function selectTarget(editor, target) {
    editor.target = target;
    edit(editor);
    state.form.index = Math.max(
      0,
      state.form.move.findIndex(
        (item) => item.side === target.side && item.edge?.id === target.edge?.id,
      ),
    );
  }
  function operations(editor) {
    const { query, source } = graphs(editor);
    const occurrence = state.ix.occurrences.get(editor.proposal.scope.occurrenceId);
    const target = editor.target;
    const connections =
      occurrence && state.ix.recording.caseState
        ? inquiryContextLinks(state.ix, occurrence, state.interpretationDecisions).carriedSupport
            .connections
        : [];
    const canBindCase =
      target?.side === 'query' &&
      connections.some(
        (item) => item.rootCase && item.status === 'linked' && item.queryEdgeId === target.edge?.id,
      );
    const anchored =
      source && editor.proposal.scope.queryEvent && editor.proposal.scope.sourceEvent;
    const answer =
      target?.side === 'query' &&
      query.nodes.find(
        (node) => target.nodeIds.includes(node.id) && node.concept === 'amr-unknown',
      );
    return [
      ...(canBindCase ? [cmd('c', 'bind case', () => bindCase(editor))] : []),
      ...(anchored && answer
        ? [cmd('b', `bind answer (${nodeLabel(query, answer.id)})`, () => map(editor, true))]
        : []),
      ...(anchored ? [cmd('m', 'map wording', () => map(editor))] : []),
      ...((!anchored ||
        (target &&
          !target.nodeIds.includes(
            target.side === 'query'
              ? editor.proposal.scope.queryEvent
              : editor.proposal.scope.sourceEvent,
          ))) &&
      source?.nodes.some((node) => query.nodes.some((other) => other.concept === node.concept))
        ? [cmd('a', 'compare from', () => anchors(editor))]
        : []),
      cmd('p', 'revise parse', () => revise(editor)),
      ...(availableMappings(editor).length
        ? [cmd('u', 'reuse interpretation', () => reuse(editor))]
        : []),
      ...(editor.proposal.mappings.some((item) =>
        target?.nodeIds.includes(target.side === 'query' ? item.queryNodeId : item.sourceNodeId),
      ) ||
      (editor.proposal.binding &&
        target?.nodeIds.includes(
          target.side === 'query'
            ? editor.proposal.binding.queryNodeId
            : editor.proposal.binding.sourceNodeId,
        )) ||
      (editor.proposal.caseBinding &&
        target?.side === 'query' &&
        target.nodeIds.includes(editor.proposal.caseBinding.queryNodeId))
        ? [cmd('r', 'remove change', () => remove(editor))]
        : []),
    ];
  }
  function edit(editor, openingsOnly = false) {
    forms.startForm(
      openingsOnly ? 'Interpretation - openings' : 'Interpretation - connections',
      [],
      () => {
        state.form.detailsOpen = !state.form.detailsOpen;
      },
      { submitLabel: 'details' },
    );
    state.form.move = targets(editor).filter((item) => !openingsOnly || item.group === 'Open');
    state.form.returnForm = editor;
    state.form.interpretationConnections = editor;
    readingContext(state.form, editor);
  }
  function actions() {
    if (state.help || state.quitPrompt || state.mode !== 'recording') return [];
    const editor = state.form;
    if (editor?.parseItems) return [];
    if (editor?.interpretationConnections) {
      const proposalEditor = editor.interpretationConnections;
      proposalEditor.target = editor.move[editor.index];
      return operations(proposalEditor);
    }
    if (editor?.interpretationEditor) {
      if (editor.move)
        return availableMappings(editor).length
          ? [cmd('u', 'reuse interpretation', () => reuse(editor))]
          : [];
      const p = editor.proposal,
        status = applied(editor)
          ? 'applied'
          : interpretationStatus(p, state.interpretationDecisions);
      return [
        ...(editor.preview?.complete && !['accepted', 'applied'].includes(status)
          ? [cmd('ENTER', 'accept', () => decide(editor, 'accepted'))]
          : []),
        ...(editor.interpretationView.groups.some(([label]) => label === 'Open')
          ? [cmd('o', 'openings', () => edit(editor, true))]
          : []),
        cmd('e', 'edit', () => edit(editor)),
        ...(status === 'accepted'
          ? [cmd('u', 'revoke', () => decide(editor, 'revoked'))]
          : !['rejected', 'applied'].includes(status)
            ? [cmd('x', 'reject', () => decide(editor, 'rejected'))]
            : []),
        ...(status === 'accepted' && p.mappings.length && state.project
          ? [cmd('s', 'save mapping', () => saveMapping(editor))]
          : []),
        ...(status === 'accepted' && p.sourceEdits.length && state.project
          ? [
              cmd(p.mappings.length ? 'S' : 's', 'save source parse', () =>
                saveMapping(editor, true),
              ),
            ]
          : []),
      ];
    }
    if (editor) return [];
    const material = selectedMaterial(state.ix, state.selection);
    return [
      ...(['source', 'scope', 'interpretation'].includes(state.page) && selectedSource()?.graphId
        ? [cmd('t', 'interpret', () => open())]
        : []),
      ...(['overview', 'context'].includes(state.page) &&
      material.occurrence &&
      state.ix.recording.caseState &&
      caseReference(state.ix, state.interpretationDecisions)?.status !== 'bound' &&
      inquiryContextLinks(state.ix, material.occurrence, state.interpretationDecisions)
        .carriedSupport.linked > 0
        ? [cmd('r', 'bind case', () => open(null, 'case'))]
        : []),
    ];
  }
  return { actions, open };
}
