/** The question's actual visits, with local matches kept separate from answer proofs. */
import { relationMeaning } from '../concepts/meaning.mjs';
import { placementLabel } from '../concepts/placement-label.mjs';
import { readingNote } from '../../recording/answer-output.mjs';
import { questionExplanation } from './question-explanation.mjs';
import { frameLineageRows } from '../../recording/frame.mjs';

const unique = (values) => [...new Set(values)];
const count = (n, label) => `${n} ${label}${n === 1 ? '' : 's'}`;
const section = (heading, rows = [], groups = []) => ({ heading, rows, groups });
const relationRows = (graph, text) =>
  new Map(
    relationMeaning(graph, { text, question: true }).relations.map((row) => [row.edgeId, row]),
  );

// A partial graph retains query labels, which can describe an omitted relation.
// Label its bound nodes from witnessed source instances, never from that query.
function supportedPartGraph(part, sources) {
  const sourceNodes = new Map(
    sources
      .filter((source) => part.sourceIds.includes(source.id))
      .flatMap((source) =>
        (source.graph?.nodes ?? []).map((node) => [`${source.id}#${node.id}`, node]),
      ),
  );
  const bindings = new Map((part.bindings ?? []).map((binding) => [binding.nodeId, binding.id]));
  const witnesses = new Set(part.witnesses ?? []);
  return {
    ...part.graph,
    nodes: part.graph.nodes.map((node) => {
      const { authoredLabel, surfaceLabel, ...display } = node;
      const boundId = bindings.get(node.id);
      const source = sourceNodes.get(boundId);
      if (
        source?.concept === node.concept &&
        witnesses.has(JSON.stringify([boundId, ':instance', node.concept]))
      ) {
        if (source.authoredLabel) display.authoredLabel = source.authoredLabel;
        if (source.surfaceLabel) display.surfaceLabel = source.surfaceLabel;
      }
      return display;
    }),
  };
}

const indexes = new WeakMap();
function journeyIndex(result, recording, answer) {
  const saved = indexes.get(result);
  if (saved?.recording === recording && saved.answer === answer) return saved;
  const sources = result.inputs.filter(
    (entry) => entry.kind !== 'question' && entry.development?.asserted !== false,
  );
  const byId = new Map(sources.map((source) => [source.id, source]));
  const byIdentity = new Map();
  const local = new Map();
  const branch = new Map();
  const answerIds = new Set((answer?.answers ?? []).flatMap((item) => item.sourceIds));
  const candidateIds = new Set((answer?.candidates ?? []).flatMap((item) => item.sourceIds));
  const partIds = new Set((answer?.partial?.parts ?? []).flatMap((item) => item.sourceIds));
  for (const source of sources) {
    byIdentity.set(JSON.stringify([source.placementId, source.sentenceId]), source);
    byIdentity.set(JSON.stringify([source.placementId, source.text]), source);
    if (!local.has(source.placementId)) local.set(source.placementId, []);
    local.get(source.placementId).push(source);
    const contribution = answerIds.has(source.id)
      ? 1
      : partIds.has(source.id)
        ? 2
        : candidateIds.has(source.id)
          ? 8
          : 0;
    branch.set(source.placementId, (branch.get(source.placementId) ?? 0) | contribution);
  }
  const recorded = new Map((recording?.sources ?? []).map((source) => [source.id, source]));
  const sourceFor = (occurrence) => {
    const source = recorded.get(occurrence.sourceId);
    return (
      byId.get(occurrence.sourceId) ??
      (source &&
        (byIdentity.get(JSON.stringify([source.nodeId, source.sentenceId])) ??
          byIdentity.get(JSON.stringify([source.nodeId, source.text]))))
    );
  };
  const occurrences = new Map();
  for (const occurrence of recording?.occurrences ?? []) {
    if (!occurrences.has(occurrence.nodeId)) occurrences.set(occurrence.nodeId, []);
    occurrences.get(occurrence.nodeId).push(occurrence);
    if (sourceFor(occurrence))
      branch.set(occurrence.nodeId, (branch.get(occurrence.nodeId) ?? 0) | 4);
  }
  const visits = new Map((recording?.visits ?? []).map((visit) => [visit.id, visit]));
  // Recorded hierarchy visits enter parents before children.
  for (const visit of [...visits.values()].reverse()) {
    const parent = visits.get(visit.parentVisitId);
    if (parent)
      branch.set(parent.nodeId, (branch.get(parent.nodeId) ?? 0) | (branch.get(visit.nodeId) ?? 0));
  }
  const index = {
    recording,
    answer,
    sources,
    local,
    branch,
    occurrences,
    sourceFor,
    visits,
    byNode: new Map([...visits.values()].map((visit) => [visit.nodeId, visit])),
    nodes: new Map((recording?.nodes ?? []).map((node) => [node.id, node])),
    steps: new Map((result.exploration?.visits ?? []).map((visit) => [visit.nodeId, visit])),
  };
  indexes.set(result, index);
  return index;
}

export function readingWarnings(audit) {
  const seen = new Set();
  const findings = (audit?.findings ?? []).filter((finding) => {
    const key = JSON.stringify([finding.predicate, finding.description]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return findings.length
    ? [
        {
          heading: 'Meaning to review',
          table: {
            headers: ['Reading', 'Meaning', 'Why flagged'],
            widths: [
              Math.min(24, Math.max(12, ...findings.map((item) => item.predicate.length))),
              null,
              null,
            ],
            minWidth: 76,
            repeatColumns: 0,
            entries: findings.map((finding) => ({
              cells: [
                finding.predicate,
                finding.description ?? 'Not in the retained PropBank vocabulary.',
                finding.description
                  ? 'No matching expression was found in the text.'
                  : 'Unknown predicate.',
              ],
              cellTones: { 0: 'warning' },
            })),
          },
          groups: [
            section('', [
              ['', 'This is a vocabulary warning; the expression may be implicit.', 'muted'],
            ]),
          ],
        },
      ]
    : [];
}

const sense = (predicate) => predicate.replace(/-\d+$/u, '').replaceAll('-', ' ');
/** What selecting a statement shows: why its reading is flagged, or how it was read. */
function readingPreview(source, findings) {
  if (!source.graph) return ['No reading retained for this text yet.'];
  const repaired = (source.repairs ?? []).map(
    (repair) => `Repaired: read ${repair.from}, used ${repair.to}. ${repair.reason}`,
  );
  if (repaired.length || findings.length)
    return [
      ...repaired,
      ...findings.map((finding) =>
        finding.status === 'unlisted' && finding.evidence?.text
          ? `“${finding.evidence.text}” is read in a sense the vocabulary does not list.`
          : finding.status === 'unverified' && finding.description
            ? `Read as “${finding.description}” (${sense(finding.predicate)}), but no word in the text says so.`
            : (finding.reason ?? `Check how “${sense(finding.predicate)}” was read.`),
      ),
    ];
  // The main clause: the root's own participants, not every nested relation.
  const top = source.graph.top;
  const main = relationMeaning(source.graph, { text: source.text }).relations.filter(({ edgeId }) =>
    source.graph.edges.some((edge) => edge.id === edgeId && edge.from === top),
  );
  return main.length
    ? [
        `Read as ${main[0].cells[0]}: ${main.map(({ cells }) => `${cells[1]} ${cells[2]}`).join('; ')}`,
      ]
    : [];
}

/** Sources stay beside their contribution and the action that opens that exact reading. */
export function sourceStatements(
  sources,
  { audit, contribution, choice = (i) => -i - 1, readings = false } = {},
) {
  const readable = sources.some((source) => source.graph);
  return {
    headers: [
      readings ? 'Text' : 'Source statement',
      ...(readings ? ['Kind'] : []),
      ...(contribution ? ['Contribution'] : []),
      ...(readable ? ['Reading'] : []),
    ],
    widths: [
      null,
      ...(readings ? [16] : []),
      ...(contribution ? [22] : []),
      ...(readable ? [12] : []),
    ],
    minWidth: contribution ? 70 : 48,
    repeatColumns: 0,
    rowSpacing: 1,
    entries: sources.map((source, i) => {
      const support = contribution?.(source);
      const findings = (audit?.(source) ?? source.lexicalAudit)?.findings ?? [];
      const flagged = Boolean(findings.length);
      const readingColumn = (contribution ? 2 : 1) + (readings ? 1 : 0);
      return {
        cells: [
          source.text,
          ...(readings
            ? [
                source.kind === 'question'
                  ? 'Question'
                  : source.kind === 'case'
                    ? 'Case statement'
                    : 'Source statement',
              ]
            : []),
          ...(support ? [support.text] : []),
          ...(readable
            ? [
                source.graph
                  ? flagged
                    ? 'Review'
                    : source.repairs?.length
                      ? 'Repaired'
                      : 'Read'
                  : 'Not read yet',
              ]
            : []),
        ],
        cellTones: {
          0: 'input',
          ...(support ? { 1: support.tone } : {}),
          [readingColumn]: flagged ? 'warning' : 'muted',
        },
        choiceIndex: choice(i),
        source,
        preview: readingPreview(source, findings),
      };
    }),
  };
}

function supportedPartSections({ parts, sources, nodes, project, choice }) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return parts.flatMap((part, index) => {
    const dependencies = unique(part.sourceIds ?? [])
      .map((id) => byId.get(id))
      .filter(Boolean);
    if (!dependencies.length) return [];
    const roles = unique(
      dependencies.map((source) =>
        source.kind === 'case'
          ? 'this case'
          : (nodes.get(source.placementId)?.label ??
            placementLabel(project.data, source.placementId)),
      ),
    );
    const rows = [];
    const rowChoices = [];
    for (const source of dependencies) {
      rowChoices.push({ rowIndex: rows.length, source, choiceIndex: choice() });
      rows.push(['Source', source.text, 'input']);
    }
    rows.push(['State', 'Supported part; question remains open.', 'warning']);
    return [
      {
        heading: `Supported part${parts.length > 1 ? ` ${index + 1}` : ''} at ${roles.join(' / ')}`,
        rows,
        rowChoices,
      },
    ];
  });
}

export function journeySection({ project, run, input, result, recording }, placementId) {
  const question = input.question.text;
  const inputs = result.inputs;
  const index = journeyIndex(result, recording, run.answer);
  const { sources, visits, nodes, sourceFor } = index;
  const answers = run.answer?.answers ?? [];
  const parts = run.answer?.partial?.parts ?? [];
  const answerIds = new Set(answers.flatMap((answer) => answer.sourceIds));
  const partIds = new Set(parts.flatMap((part) => part.sourceIds));
  const graph = inputs.find((entry) => entry.kind === 'question')?.graph;
  const answerRows = graph ? relationRows(graph, question) : new Map();
  // The retained walk and answer compiler each number their own graph edges.
  // A visit's paths must be labelled from the walk's graph, not the compiler's.
  const walkedGraph = recording?.graphs.find((item) => item.id === recording.inquiry.graphId);
  const walkedRows = walkedGraph ? relationRows(walkedGraph, question) : new Map();
  const visit = index.byNode.get(placementId);
  const exploration = result.exploration;
  const step = index.steps.get(placementId);
  const incoming = step?.incomingCheck != null ? exploration.checks[step.incomingCheck] : null;
  const outgoing = step?.outgoingCheck != null ? exploration.checks[step.outgoingCheck] : null;
  const parent = visits.get(visit?.parentVisitId);
  const local = index.local.get(placementId) ?? [];
  const reading = (entry) =>
    entry?.lexicalAudit ??
    result.lexicalAudit?.items?.find((item) => item.inputId === entry?.id) ??
    run.lexicalAudit?.items?.find((item) => item.inputId === entry?.id);
  let sourceChoice = 0;
  const sourceTable = (items, contribution, readings = false) =>
    sourceStatements(items, {
      audit: reading,
      contribution,
      readings,
      choice: () => --sourceChoice,
    });
  const matching = (id) => index.occurrences.get(id) ?? [];
  const queryAudit = reading(inputs.find((entry) => entry.kind === 'question'));
  const groups = [];
  const lineage = frameLineageRows(recording?.continuation);
  if (lineage.length) groups.push(section('How this question was reached', lineage));
  const candidateSourceIds = new Set(
    !answers.length
      ? (run.answer?.candidates ?? []).flatMap((candidate) => candidate.sourceIds ?? [])
      : [],
  );
  const outcome = answers.length
    ? answers.flatMap((answer) => [
        ['Answer', answer.text, 'located'],
        ...(answer.readAs === 'requirement'
          ? [['Read as', 'A source says it must be done; that answers “should”.']]
          : []),
        ...(answer.readAs === 'reference'
          ? [
              [
                'Read as',
                `“${answer.reference.pronoun}” is the ${answer.reference.antecedent} the question names.`,
              ],
            ]
          : []),
        ...(answer.readAs === 'shared-wording'
          ? [
              [
                'Read as',
                `The question and a source both say “${answer.sharedWording.join('”, “')}”; read as in the source.`,
              ],
            ]
          : []),
        ...(readingNote(answer) ? [['Read as', readingNote(answer)]] : []),
        // A source's clause qualifies the answer; it is a condition only when
        // the source says so (“in the incident channel” is where, not if).
        ...(answer.dependsOn ?? answer.qualifications ?? []).map((text) => [
          'Qualified by',
          text,
          'input',
        ]),
      ])
    : [
        [
          'Answer',
          run.status === 'conflict'
            ? 'Sources disagree.'
            : run.status === 'ambiguous'
              ? 'Several answers remain possible.'
              : 'Still open.',
          'warning',
        ],
      ];
  if (run.error) outcome.push(['Problem', run.error, 'warning']);
  if (run.status === 'limited')
    outcome.push([
      'Check stopped',
      'The search reached its limit; some connections were not examined.',
      'warning',
    ]);
  const top = section(
    '',
    [
      ['Question', question, 'input'],
      ['Asked at', placementLabel(project.data, run.scopePlacementId)],
      ...(input.caseSelection ? [['Case', input.caseSelection.label, 'input']] : []),
      ['', ''],
      ...outcome,
      ...(exploration
        ? [
            [
              'Checked',
              [
                count(exploration.visits.length, 'role'),
                count(
                  sources.filter((source) => source.kind === 'source').length,
                  'source statement',
                ),
                ...(input.caseSelection
                  ? [
                      count(
                        sources.filter((source) => source.kind === 'case').length,
                        'case statement',
                      ),
                    ]
                  : []),
              ].join(', ') + '.',
            ],
          ]
        : []),
      ...(queryAudit?.findings?.length
        ? [
            [
              'Reading',
              'A word may have been read with another meaning; select the question to review.',
              'warning',
            ],
          ]
        : []),
      ...(recording?.routing?.status === 'unavailable'
        ? [
            [
              'Role matching',
              'Language ranking unavailable; roles follow their original order.',
              'muted',
            ],
          ]
        : []),
    ],
    groups,
  );
  const questionSource = inputs.find((source) => source.kind === 'question');
  if (questionSource)
    top.rowChoices = [{ rowIndex: 0, source: questionSource, choiceIndex: --sourceChoice }];
  if (parts.length && !answers.length)
    groups.push(
      ...supportedPartSections({
        parts,
        sources,
        nodes,
        project,
        choice: () => --sourceChoice,
      }),
    );
  if (!answers.length) {
    const explanation = questionExplanation(run, answerRows);
    for (const entry of explanation.table.entries) {
      const ids = new Set((entry.openings ?? []).flatMap((opening) => opening.sourceIds ?? []));
      const touching = sources.filter((source) => ids.has(source.id));
      // Only statements the gap records; no preview claims an absence.
      entry.preview = touching.map(
        (source) =>
          `${nodes.get(source.placementId)?.label ?? placementLabel(project.data, source.placementId)}: ${source.text}`,
      );
    }
    groups.push(explanation);
    for (const candidate of run.answer?.candidates ?? []) {
      const ids = new Set(candidate.sourceIds ?? []);
      groups.push({
        heading: run.status === 'conflict' ? 'Conflicting answer' : 'Possible answer',
        rows: [
          ['Candidate', candidate.text, 'warning'],
          ...(candidate.dependsOn ?? candidate.qualifications ?? []).map((text) => [
            'Qualified by',
            text,
            'input',
          ]),
        ],
        table: sourceTable(sources.filter((source) => ids.has(source.id))),
      });
    }
    const relatedIds = new Set(
      (run.answer?.openings ?? run.openings ?? []).flatMap((opening) => opening.sourceIds ?? []),
    );
    const related = sources.filter(
      (source) =>
        relatedIds.has(source.id) && !candidateSourceIds.has(source.id) && source.kind !== 'case',
    );
    if (related.length) {
      const table = sourceTable(related);
      groups.push({
        heading: 'Related statements',
        rows: [
          [
            '',
            'These contain matching relationships, but do not establish a complete answer.',
            'muted',
          ],
        ],
        table: {
          ...table,
          headers: ['Role', ...table.headers],
          widths: [20, ...table.widths],
          minWidth: 76,
          entries: table.entries.map((entry, i) => ({
            ...entry,
            cells: [nodes.get(related[i].placementId)?.label ?? 'Source', ...entry.cells],
            cellTones: { 1: 'input', 2: entry.cellTones[1] },
          })),
        },
      });
    }
  }
  const proofSources = () =>
    sources
      .filter((source) => answerIds.has(source.id) && source.placementId !== placementId)
      .map((source) => ({
        heading:
          source.kind === 'case' ? 'This case' : placementLabel(project.data, source.placementId),
        table: sourceTable([source]),
      }));
  const rules = new Set(answers.flatMap((answer) => answer.ruleIds ?? []));
  const interpretations = (project.data.contributions ?? []).flatMap((contribution) =>
    contribution.wordings.filter(
      (wording) =>
        !wording.withdrawn &&
        wording.kind === 'clarification' &&
        [...rules].some((id) => id.includes(contribution.id) && id.includes(wording.id)),
    ),
  );
  if (!visit) {
    groups.push(
      section('Outside this question', [
        ['', 'This role is outside the source branch checked for this question.'],
      ]),
    );
    return top;
  }
  const localFindings = matching(placementId);
  const localIds = new Set(local.map((source) => source.id));
  // The role the question was asked at shows every proposal in its scope.
  const asked = placementId === run.scopePlacementId;
  const proposals = (run.answer?.clarifications ?? []).filter(
    (candidate) => asked || candidate.source.nodeId === placementId,
  );
  const arriving = exploration
    ? unique(
        (incoming?.openings ?? []).map((opening) => answerRows.get(opening.id)).filter(Boolean),
      )
    : parent
      ? unique(
          (recording.openings ?? [])
            .filter((opening) => parent.openingIds.includes(opening.id))
            .flatMap((opening) =>
              opening.paths.flatMap((path) =>
                path.steps.map((step) => walkedRows.get(step.edgeId)).filter(Boolean),
              ),
            ),
        )
      : [];
  const localSection = section(`At ${nodes.get(placementId)?.label ?? 'this role'}`, [
    ...(answers.length &&
    outgoing?.nodeId === placementId &&
    outgoing.answers.some((answer) => answer.sourceIds.some((id) => localIds.has(id))) &&
    !incoming?.answers.length
      ? [['Here', 'These sources complete the answer with the support found earlier.', 'located']]
      : []),
  ]);
  // Display inherited source context with attribution. A structural match remains
  // provisional even if its paths cover the complete question.
  const carried = [];
  for (let ancestor = parent; ancestor; ancestor = visits.get(ancestor.parentVisitId)) {
    const relevant = unique(matching(ancestor.nodeId).map(sourceFor).filter(Boolean));
    for (const source of relevant)
      carried.unshift([nodes.get(ancestor.nodeId).label, source.text, 'input']);
  }

  const localSupport = parts.filter((part) => part.sourceIds.some((id) => localIds.has(id)));
  const relevantLocal = local.filter(
    (source) =>
      answerIds.has(source.id) ||
      partIds.has(source.id) ||
      localFindings.some((item) => sourceFor(item)?.id === source.id),
  );
  relevantLocal.sort(
    (a, b) =>
      Number(answerIds.has(b.id) || partIds.has(b.id)) -
      Number(answerIds.has(a.id) || partIds.has(a.id)),
  );
  const localStatements = relevantLocal.filter((source) => !candidateSourceIds.has(source.id));
  if (localStatements.length)
    localSection.table = sourceTable(localStatements, (source) => ({
      text: answerIds.has(source.id)
        ? 'Used in the answer proof.'
        : partIds.has(source.id)
          ? 'Supports part of the question.'
          : 'Related; not used in an answer.',
      tone: answerIds.has(source.id) || partIds.has(source.id) ? 'located' : 'muted',
    }));
  // Lead with the evidence: when this role holds none of it, show where it is first.
  const supporting = answerIds.size ? proofSources() : [];
  const evidence = supporting.length ? section('Answer comes from', [], supporting) : null;
  if (evidence && !localStatements.some((source) => answerIds.has(source.id)))
    groups.push(evidence);
  if (localSection.table || localSection.rows.length) groups.push(localSection);
  for (const source of relevantLocal) {
    if (answerIds.has(source.id) || partIds.has(source.id) || candidateSourceIds.has(source.id))
      continue;
    const found = localFindings.filter((item) => sourceFor(item)?.id === source.id);
    const relations = unique(
      found.flatMap((item) =>
        item.requiredRefs
          .filter((ref) => item.alignedRefs.some((match) => match.queryPathId === ref.id))
          .flatMap((ref) => ref.steps.map((step) => walkedRows.get(step.edgeId)).filter(Boolean)),
      ),
    );
    if (relations.length)
      groups.push({
        heading: 'Related connections',
        table: {
          headers: ['Subject', 'Relationship', 'Participant'],
          widths: [null, null, null],
          minWidth: 40,
          repeatColumns: 0,
          entries: relations.map((row) => ({ ...row, cells: row.cells.slice(0, 3) })),
        },
      });
  }
  if (arriving.length)
    groups.push({
      heading: 'Needed on arrival',
      table: {
        headers: ['Subject', 'Relationship', 'Participant'],
        widths: [null, null, null],
        minWidth: 40,
        repeatColumns: 0,
        entries: arriving.map((row) => ({ ...row, cells: row.cells.slice(0, 3) })),
      },
    });
  for (const part of localSupport)
    groups.push({
      heading: 'Supported relationship',
      table: {
        headers: ['Subject', 'Relationship', 'Participant'],
        widths: [null, null, null],
        minWidth: 0,
        repeatColumns: 0,
        entries: relationMeaning(supportedPartGraph(part, sources)).relations.map((row) => ({
          ...row,
          cells: row.cells.slice(0, 3),
        })),
      },
    });
  const contributes = (child) => Boolean((index.branch.get(child.nodeId) ?? 0) & 3);
  const visited = (visit.return?.childVisitIds ?? []).map((id) => visits.get(id));
  // Roles holding evidence come first; the rest keep the checked order.
  const children = [...visited.filter(contributes), ...visited.filter((c) => !contributes(c))];
  const reordered = children.some((child, i) => child !== visited[i]);
  if (children.length) {
    groups.push({
      heading:
        recording.routing?.status === 'matched'
          ? 'Roles matched to the question'
          : 'Continue through the roles',
      table: {
        headers: ['Role', 'Contribution'],
        widths: [null, null],
        minWidth: 0,
        repeatColumns: 0,
        entries: children.map((child, choiceIndex) => {
          const contribution = index.branch.get(child.nodeId) ?? 0;
          const supported = contribution & 1,
            partial = contribution & 2,
            candidate = contribution & 8,
            related = contribution & 4;
          const localSources = index.local.get(child.nodeId) ?? [];
          const localSupported = localSources.some((source) => answerIds.has(source.id));
          const localPartial = localSources.some((source) => partIds.has(source.id));
          return {
            cells: [
              nodes.get(child.nodeId).label,
              supported
                ? localSupported
                  ? 'Source used in the answer'
                  : 'Answer source in a child role'
                : partial
                  ? localPartial
                    ? 'Supported part; question remains open'
                    : 'Supported part in a child role'
                  : candidate
                    ? 'Possible answer; not resolved'
                    : related
                      ? 'Related wording; no answer proof'
                      : 'No contribution',
            ],
            choiceIndex,
            placementId: child.nodeId,
            tone: supported || partial ? 'located' : 'plain',
          };
        }),
      },
    });
  }
  if (children.length && recording.routing?.status === 'matched')
    groups.push(
      section('', [
        [
          '',
          reordered
            ? 'Roles with evidence first, then by language similarity.'
            : 'Ordered by language similarity.',
          'muted',
        ],
      ]),
    );
  if (carried.length) groups.push(section('Carried from above', carried));
  if (evidence && !groups.includes(evidence)) groups.push(evidence);
  for (const wording of interpretations)
    groups.push(
      section('Uses your confirmed connection', [
        ['Confirmed question', wording.text, 'input'],
        ...(wording.basisSources ?? []).map((source) => ['Source', source.text, 'input']),
      ]),
    );
  for (const candidate of proposals)
    groups.push(
      section('A connection needs your interpretation', [
        ['Question', candidate.question.text, 'input'],
        ['Source', candidate.source.text, 'input'],
        ...(asked && candidate.source.nodeId !== placementId
          ? [['At', placementLabel(project.data, candidate.source.nodeId)]]
          : []),
        ...(candidate.sharedWording
          ? [['Read differently', `Both say “${candidate.sharedWording}”.`, 'warning']]
          : []),
        ...(candidate.answerNodeId
          ? [['Possible participant', candidate.answerLabel, 'warning']]
          : []),
      ]),
    );
  const cases = inputs.filter(
    (source) =>
      source.kind === 'case' && !answerIds.has(source.id) && !candidateSourceIds.has(source.id),
  );
  if (cases.length)
    groups.push({
      heading: 'Case readings',
      table: sourceTable(cases, undefined, true),
    });
  return top;
}
