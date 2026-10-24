/** Human-readable engine records; exact client payloads remain inspectable. */
import { graphPenmanLines } from '../recordings/graph-preview.mjs';
import { meaningConcepts } from '../../engine/concepts.mjs';
import { assessmentMarks, relationMeaning } from '../concepts/meaning.mjs';
import { readingNote } from '../../recording/answer-output.mjs';

// Contributions retain the composed graph separately from their language acquisitions.
// Read the saved snapshot; displaying evidence must not acquire or recompose anything.
const inputAmr = (input) =>
  input.graph
    ? graphPenmanLines(input.graph)
        .map((line) => line.text)
        .join('\n')
    : (input.acquisition?.penman ?? input.penman ?? 'Not captured');
const time = (ms) => `${((ms ?? 0) / 1000).toFixed(2)} s`;
const clientStage = (stage) => (stage === 'unknown' ? 'candidate matching' : stage);
const sourceKind = (source) =>
  source?.development
    ? source.development.partId === 'question'
      ? 'Saved question'
      : source.development.asserted
        ? 'Statement'
        : 'Wording'
    : source?.kind === 'question'
      ? 'Asked question'
      : source?.kind === 'case'
        ? 'Case'
        : source?.kind === 'declaration'
          ? 'Declaration'
          : 'Source';
const table = (headers, entries, widths = headers.map(() => null)) => ({
  headers,
  widths,
  minWidth: 0,
  repeatColumns: 0,
  entries,
});
const listed = (values, selected, cells) =>
  values.map((value, i) => ({
    cells: [`${i === selected ? '>' : ' '} ${cells(value)[0]}`, ...cells(value).slice(1)],
    choiceIndex: i,
    cellTones: { 0: i === selected ? 'selected' : 'plain' },
  }));

/** Result, evidence and execution share ordinary reading tabs. */
export function inquirySections(
  run,
  input,
  result,
  selected = {},
  changes = [],
  { earlierRevision = false, historical = false } = {},
) {
  const all = engineSections(run, input, result, selected, changes);
  for (const section of all) section.key = section.label;
  const [outcome, trace, missing, sources, clients] = all;
  trace.label = 'Execution';
  trace.heading = 'Saved execution details';
  const entries =
    result?.inputs ??
    input?.entries ??
    (input ? [...input.sources, ...input.cases, input.question] : []);
  const graph = result?.inputs?.find((e) => e.kind === 'question')?.graph ?? input?.question?.graph;
  const meaning = graph
    ? meaningConcepts(graph, { sourceId: 'question', text: input?.question?.text })
    : null;
  const edgeReading = (opening) => {
    if (opening.kind === 'condition') {
      const conditional = meaningConcepts(
        {
          top: 'from',
          nodes: [
            { id: 'from', concept: opening.from },
            { id: 'to', concept: opening.to },
          ],
          edges: [{ id: 'condition', from: 'from', role: opening.role, to: 'to' }],
        },
        { sourceId: opening.id },
      );
      const [from, to] = conditional.entries;
      return `${from.name}: ${to.relation} → ${to.name}`;
    }
    const edge = graph?.edges.find((e) => e.id === opening.id);
    const location =
      edge && meaning?.entries.find((e) => e.nodeId === edge.to && e.role === edge.role);
    const from = edge && meaning?.entries.find((e) => e.nodeId === edge.from);
    const name = (id) => {
      const retained = meaning?.entries.find((e) => e.nodeId === id);
      if (retained) return retained.name;
      const node = graph.nodes.find((n) => n.id === id);
      return node?.literal !== undefined
        ? String(node.literal).replace(/^"|"$/gu, '')
        : (node?.authoredLabel ??
            node?.surfaceLabel ??
            node?.concept.replace(/-\d+$/u, '').replaceAll('-', ' ') ??
            'Unknown participant');
    };
    return location && from
      ? `${from.name}: ${location.relation} → ${location.name}`
      : edge
        ? `${name(edge.from)}: ${edge.role.slice(1)} → ${name(edge.to)}`
        : (opening.text ?? opening.label ?? opening.concept ?? 'Unresolved connection');
  };
  const gaps = run?.openings ?? [];
  // Lexical metadata stays in the source AMR. Lead with the missing work,
  // followed by meaningful relations which have no common assertion yet.
  let openingChoices = gaps
    .map((opening, index) => ({ opening, index }))
    .filter(({ opening }) => {
      const edge = graph?.edges.find((e) => e.id === opening.id);
      return (
        opening.state !== 'unjoined' ||
        !edge ||
        !(
          [':wiki', ':name'].includes(edge.role) ||
          (/^:op\d+$/u.test(edge.role) &&
            graph.nodes.find((n) => n.id === edge.from)?.concept === 'name')
        )
      );
    });
  if (!openingChoices.length) openingChoices = gaps.map((opening, index) => ({ opening, index }));
  openingChoices.sort(
    (a, b) => Number(a.opening.state === 'unjoined') - Number(b.opening.state === 'unjoined'),
  );
  const openingIndex = selected.Openings ?? openingChoices[0]?.index;
  const opening = gaps[openingIndex];
  const candidates = run?.answer?.candidates ?? [];
  const partial = run?.answer?.partial;
  const clarifications = run?.status === 'open' ? (run.answer?.clarifications ?? []) : [];
  const alternatives = candidates.length && ['ambiguous', 'conflict'].includes(run?.status);
  const earlier = earlierRevision || changes.length;
  const stateLabel = historical
    ? 'Saved assessment (history)'
    : earlier
      ? 'Checking the current corpus'
      : ({
          supported: 'Supported by the corpus',
          conditional: 'Supported with qualifications',
          ambiguous: 'Several possible bindings; no single answer selected',
          conflict: 'Sources disagree',
          open: partial?.parts?.length
            ? 'Partly supported; open connections remain'
            : 'Not established by this corpus',
          'needs-amr': 'Some text has no retained reading',
          'needs-reading': 'This question needs a current domain reading',
          'invalid-amr': 'A reading could not be prepared',
          running: 'Checking the corpus',
          failed: 'The check did not finish',
          limited: 'The check reached a limit',
          cancelled: 'Check cancelled',
          stale: 'Corpus changed during this check',
        }[run?.status] ?? 'Loading saved result');
  const actionable = run && !['running', 'supported', 'conditional'].includes(run.status);
  outcome.label = 'Result';
  outcome.heading = 'Question and result';
  outcome.rows = [
    ['Question', input?.question?.text ?? run?.questions?.[0]?.text ?? '', 'input'],
    ['State', stateLabel, actionable || earlier ? 'warning' : 'plain'],
    ...(historical ? [['Saved result', run.status, 'muted']] : []),
    ...(run?.error ? [['Problem', run.error, 'warning']] : []),
    ...(run?.semantic
      ? [
          [
            'Earlier assessment',
            'This saved result used a retired interpretation pipeline.',
            'warning',
          ],
        ]
      : []),
    ...(run?.answer?.answers ?? []).flatMap((answer) => [
      ['Answer', answer.text, 'input'],
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
      ...(answer.dependsOn ?? answer.qualifications ?? []).map((q) => ['Qualification', q]),
    ]),
    ...(run?.case ? [['Case', run.case, 'input']] : []),
    ...(openingChoices.length
      ? [['Missing', `${openingChoices.length} connections`, 'warning']]
      : []),
    ...(clarifications.length
      ? [
          [
            historical ? 'Recorded proposals' : 'Clarification',
            historical
              ? `${clarifications.length} unconfirmed source connections`
              : `${clarifications.length} possible source connections need your interpretation`,
            'warning',
          ],
        ]
      : []),
    ...(historical ? [['Assessment', 'Historical snapshot; read only', 'muted']] : []),
    ...(run?.lexicalAudit?.items.length
      ? [
          [
            'Reading review',
            `${run.lexicalAudit.items.length} inputs with unverified vocabulary`,
            'warning',
          ],
        ]
      : []),
    ...changes.map((c) => ['Changed input', c.currentText ?? c.text, 'warning']),
  ];
  outcome.tables = [];
  outcome.groups = [];
  if (alternatives)
    outcome.groups.push(
      ...candidates.map((candidate, i) => ({
        heading: `Candidate ${i + 1}: ${candidate.text}`,
        rows: entries
          .filter((e) => candidate.sourceIds.includes(e.id))
          .map((e) => ['Source', e.text, 'input']),
      })),
    );
  const supporting = new Set((run?.answer?.answers ?? []).flatMap((a) => a.sourceIds));
  if (supporting.size)
    outcome.groups = [
      {
        heading: 'Supporting material',
        rows: entries.filter((e) => supporting.has(e.id)).map((e) => ['Source', e.text, 'input']),
      },
    ];
  if (partial?.parts?.length)
    outcome.groups.push(
      ...partial.parts.map((part) => ({
        heading: 'Supported part',
        rows: [
          ...[
            ...new Set(
              entries
                .filter((entry) => part.sourceIds.includes(entry.id))
                .map((entry) => entry.text),
            ),
          ].map((text) => ['Source', text, 'input']),
          ...(part.qualifications ?? []).map((qualification) => [
            'Context',
            typeof qualification === 'string'
              ? qualification
              : (qualification.text ?? qualification.reason ?? 'Retained source qualifications'),
          ]),
        ],
        table: table(
          ['Subject', 'Relationship', 'Participant', 'State'],
          relationMeaning(part.graph, {
            text: input?.question?.text,
            sourceId: part.id,
            marks: new Map(
              part.graph.edges.map((edge) => [edge.id, { label: 'Supported', tone: 'located' }]),
            ),
          }).relations,
        ),
      })),
    );
  missing.label = 'Missing';
  missing.heading = 'Connections to develop';
  missing.rows = [];
  missing.table = table(
    ['Needed connection', 'State'],
    openingChoices.map(({ opening: o, index }) => ({
      cells: [
        `${index === openingIndex ? '>' : ' '} ${edgeReading(o)}`,
        o.state === 'unjoined' ? 'Context not joined' : 'Not established',
      ],
      choiceIndex: index,
      cellTones: { 0: index === openingIndex ? 'selected' : 'plain' },
    })),
  );
  missing.groups = opening
    ? [
        {
          heading: 'Selected connection',
          rows: [
            ['Needed', edgeReading(opening), 'input'],
            ['Why', opening.reason],
            ...(opening.kind === 'condition' ? [['Requires', 'Case observation', 'warning']] : []),
            ...entries
              .filter((e) => opening.sourceIds?.includes(e.id))
              .map((e) => ['Related source', e.text, 'input']),
          ],
        },
      ]
    : [];
  if (clarifications.length) {
    const proposals = clarifications.map((candidate) => ({
      heading: historical ? 'Recorded proposal' : 'Connection to clarify',
      rows: [
        ['Source', candidate.source.text, 'input'],
        ['Proposed answer', candidate.answerLabel, 'input'],
        [
          'Why',
          historical
            ? 'This source connection was proposed in the saved assessment.'
            : candidate.sharedWording
              ? `The question and the source both say “${candidate.sharedWording}”, but each was read differently. Confirm they mean the same to retain the connection.`
              : 'The source may answer this question through a different wording. Confirm its meaning to retain the connection.',
        ],
        [
          'State',
          historical
            ? 'Unconfirmed in this assessment'
            : 'Proposed interpretation; no answer established',
          'warning',
        ],
      ],
    }));
    outcome.groups.push(...proposals);
    missing.groups.push(...proposals);
  }
  return [
    outcome,
    ...((gaps.length || clarifications.length) && !alternatives ? [missing] : []),
    ...(entries.length ? [sources] : []),
    trace,
    ...(run?.calls?.length ? [clients] : []),
  ];
}

export function engineSections(run, input, result, selected = {}, changes = []) {
  const inputs =
      result?.inputs ??
      input?.entries ??
      (input ? [...input.sources, ...input.cases, input.question] : []),
    openings = run?.openings ?? [],
    calls = run?.calls ?? [];
  const sourceAt = Math.min(selected.Sources ?? 0, Math.max(0, inputs.length - 1));
  const openingAt = Math.min(selected.Openings ?? 0, Math.max(0, openings.length - 1));
  const callAt = Math.min(selected.Clients ?? 0, Math.max(0, calls.length - 1));
  const source = inputs[sourceAt],
    opening = openings[openingAt],
    call = calls[callAt];
  const lexicalItems = run?.lexicalAudit?.items ?? [];
  const sourceAudit = lexicalItems.find((item) => item.inputId === source?.id);
  const unverifiedInputs = new Set(
    lexicalItems.filter((item) => item.findings.length).map((item) => item.inputId),
  );
  const inputChoices = listed(inputs, sourceAt, (item) => [
    `${sourceKind(item)} ${inputs.filter((other) => sourceKind(other) === sourceKind(item)).indexOf(item) + 1}`,
    item.text,
  ]).map((entry, index) => ({
    ...entry,
    cellTones: {
      ...entry.cellTones,
      1: unverifiedInputs.has(inputs[index].id) ? 'warning' : 'plain',
    },
  }));
  const inputStart = Math.max(0, Math.min(sourceAt - 2, inputs.length - 5));
  const visibleInputs = inputChoices.slice(inputStart, inputStart + 5);
  const questions = input
    ? inputs.filter((item) => item.kind === 'question')
    : (run?.questions ?? []);
  const openingSource =
    opening &&
    inputs.find(
      (item) =>
        item.id === (opening.sourceId ?? opening.inputId) ||
        (item.index === opening.source && opening.source !== undefined),
    );
  const openingQuestion = input?.question ?? questions[0];
  const state = changes.length ? 'stale inputs' : (run?.status ?? 'ready');
  return [
    {
      label: 'Outcome',
      heading: 'Inquiry outcome',
      rows: [
        [
          'State',
          state,
          ['failed', 'limited', 'stale inputs', 'needs-amr', 'invalid-amr'].includes(state)
            ? 'warning'
            : 'plain',
        ],
        [
          'Case',
          inputs
            .filter((item) => item.kind === 'case')
            .map((item) => item.text)
            .join('\n') ||
            run?.case ||
            'Not selected',
          'input',
        ],
        [
          'Inputs',
          input
            ? `${inputs.filter((item) => ['source', 'declaration'].includes(item.kind)).length} corpus sentences; ${calls.some((call) => call.client === 'AMR') ? 'AMRs acquired for this run; deterministic reasoning' : 'retained AMRs; no model calls'}`
            : 'Loading saved input snapshot',
        ],
        ...(run
          ? [
              ['Elapsed', time(run.elapsedMs)],
              ['Saved run', run.id],
              ['Project snapshot', run.projectDigest.slice(0, 12)],
            ]
          : []),
        ...(run?.error ? [['Detail', run.error, 'warning']] : []),
        ...(lexicalItems.length
          ? [
              [
                'AMR vocabulary',
                `${lexicalItems.length} inputs have unverified readings. Graph answers depend on the acquired AMRs; inspect Sources.`,
                'warning',
              ],
            ]
          : []),
        ...changes.map((change) => [
          'Input needs review',
          `${change.reason}: ${change.currentText ?? change.text}`,
          'warning',
        ]),
      ],
      tables: [
        table(
          ['Question', 'Outcome'],
          questions.map((question) => ({
            cells: [
              question.text,
              run?.answer?.answers.length
                ? `${run.answer.status}: ${run.answer.answers.map((answer) => answer.text).join(', ')}`
                : run?.candidates.length
                  ? `Structural candidates: ${[...new Set(run.candidates.map((item) => item.text))].join(', ')}. Complete question remains ${run.status}.`
                  : !run
                    ? 'Not run'
                    : run.status === 'running'
                      ? 'Running'
                      : run.status === 'open'
                        ? 'Open: no justified answer yet'
                        : run.status,
            ],
            cellTones: { 0: 'input' },
          })),
        ),
        ...(openings.length
          ? [
              table(
                ['Remaining connection', 'Why it stays open'],
                openings.map((item) => ({
                  cells: [item.label ?? item.text ?? item.kind, item.reason],
                })),
              ),
            ]
          : []),
      ],
    },
    {
      label: 'Trace',
      heading: 'Execution',
      rows: [
        ['Engine', run?.answer?.engine ?? run?.profile ?? input?.profile ?? 'fragment-chain-v1'],
        ...(run?.answer?.grammar
          ? [
              [
                'Corpus grammar',
                `${run.answer.grammar.corpora.at(-1)?.rules ?? 0} productions; extracted automatically`,
              ],
              [
                'Grammar reuse',
                run.answer.grammar.compilations
                  ? 'Compiled changed material'
                  : 'Reused retained material',
              ],
            ]
          : []),
        ...(run?.coverage?.maximumFragmentNodes !== undefined
          ? [
              ['Candidate comparisons', String(run.coverage.pairs)],
              [
                'Fragment bound',
                `${run.coverage.maximumFragmentNodes} nodes; candidate search is not exhaustive`,
              ],
            ]
          : []),
      ],
      tables: [
        table(
          ['Stage', 'State', 'Elapsed'],
          (run?.stages ?? []).map((stage) => ({
            cells: [stage.label, stage.status, time(stage.durationMs)],
          })),
        ),
        ...(result?.chains?.length
          ? [
              table(
                ['Source', 'Linked source', 'Checks'],
                result.chains.map((chain) => ({
                  cells: [
                    inputs.find((item) => item.id === chain.sourceId)?.text,
                    inputs.find((item) => item.id === chain.otherSourceId)?.text,
                    'Exact interface; both envelopes retained; lossless expansion',
                  ],
                })),
              ),
            ]
          : []),
      ],
    },
    {
      label: 'Openings',
      heading: 'Open connections',
      rows: !openings.length
        ? [
            [
              'State',
              run?.status === 'running'
                ? 'The engine is still tracing the graphs'
                : 'No recorded openings yet',
            ],
          ]
        : [],
      table: table(
        ['Connection', 'State'],
        listed(openings, openingAt, (item) => [item.label ?? item.text ?? item.kind, 'Open']),
      ),
      groups: opening
        ? [
            {
              heading: 'Selected connection',
              rows: [
                ['Selected', opening.label ?? opening.text ?? opening.kind],
                ['Corpus supplies', opening.corpus ?? 'See retained inputs', 'input'],
                ['Question requires', opening.required ?? opening.reason, 'input'],
                ['Gap', opening.reason],
                ...(openingSource
                  ? [
                      ['Source', openingSource.text, 'input'],
                      ['Source AMR', inputAmr(openingSource), 'amr'],
                    ]
                  : []),
              ],
              groups: [
                ...(openingQuestion
                  ? [
                      {
                        heading: 'Question AMR',
                        rows: [
                          ['Question', openingQuestion.text, 'input'],
                          ['', inputAmr(openingQuestion), 'amr'],
                        ],
                      },
                    ]
                  : []),
                { rows: [['Continuation', 'No semantic repair has been applied.']] },
              ],
            },
          ]
        : [],
    },
    {
      label: 'Sources',
      heading:
        inputs.length > 5
          ? `Assessment inputs ${inputStart + 1}–${inputStart + visibleInputs.length} of ${inputs.length}`
          : 'Assessment inputs',
      table: table(['Input', 'Sentence'], visibleInputs, [
        Math.max(5, ...inputChoices.map((item) => item.cells[0].length)),
        null,
      ]),
      groups: [
        {
          heading: `${source?.kind === 'question' ? 'Inquiry' : source?.kind === 'case' ? 'Case' : 'Source'} sentence - ${sourceAt + 1}/${inputs.length}`,
          rows: source
            ? [
                ['Kind', sourceKind(source)],
                ['Sentence', source.text, unverifiedInputs.has(source.id) ? 'warning' : 'input'],
                ['Revision', (source.revision ?? source.textRevision)?.slice(0, 12) ?? 'retained'],
                [
                  'Acquisition',
                  source.acquisition
                    ? `${source.acquisition.acquisition?.model ?? source.acquisition.model ?? 'retained'}; ${source.acquisition.status ?? 'capture'}`
                    : 'Recorded AMR',
                ],
                ...(source.semanticReading
                  ? [
                      [
                        'Domain reading',
                        `Automatically acquired with ${source.semanticReading.acquisition?.model ?? 'the configured language model'}; source-dependent interpretation`,
                      ],
                    ]
                  : []),
                ...(sourceAudit?.findings.map((finding) => [
                  'Vocabulary check',
                  finding.reason,
                  'warning',
                ]) ?? []),
                ...(sourceAudit?.candidates.map((candidate) => [
                  'Lexical hint',
                  `${candidate.evidence.text}: ${candidate.predicate} (${candidate.description}); ${candidate.evidence.method === 'propbank-inflection' ? 'inflection of ' : ''}PropBank alias “${candidate.evidence.lexeme}”. A candidate only; predicate roles need review.`,
                ]) ?? []),
              ]
            : [['State', 'Input snapshot unavailable']],
          groups: [
            ...(source?.graph
              ? [
                  relationMeaning(source.graph, {
                    text: source.text,
                    sourceId: source.id,
                    marks: assessmentMarks(source, run?.answer),
                    question: source.kind === 'question' || source.development?.asserted === false,
                  }),
                ]
              : source
                ? [{ rows: [['AMR', inputAmr(source), 'amr']] }]
                : []),
            ...(source?.originalGraph
              ? [
                  {
                    heading: 'Original reading',
                    rows: [['Language', source.text, 'input']],
                    groups: [
                      relationMeaning(source.originalGraph, {
                        text: source.text,
                        sourceId: `${source.id}/original`,
                        question: source.kind === 'question',
                      }),
                    ],
                  },
                ]
              : []),
            ...(source?.acquisition?.inputs?.length
              ? [
                  {
                    heading: 'Original language AMRs',
                    groups: source.acquisition.inputs.map((capture, index) => ({
                      heading: `Input ${index + 1}`,
                      rows: [
                        ['Text', capture.text, 'input'],
                        ['AMR', inputAmr(capture), 'amr'],
                      ],
                    })),
                  },
                ]
              : []),
          ],
        },
      ],
    },
    {
      label: 'Clients',
      heading: 'Client calls',
      table: table(
        ['Client / stage', 'Work', 'State', 'Elapsed'],
        listed(calls, callAt, (item) => [
          `${item.client} / ${clientStage(item.stage)}`,
          String(item.count),
          item.status,
          time(item.durationMs),
        ]),
      ),
      groups: [
        {
          heading: `Client call - ${callAt + 1}/${calls.length}`,
          rows: call
            ? [
                ['Selected', `${call.client} - ${clientStage(call.stage)}`],
                ['State', call.status],
                ['Elapsed', time(call.durationMs)],
                ['Work', call.summary ?? `${call.count} inputs`],
                ...(call.versions
                  ? [
                      [
                        'Versions',
                        Object.entries(call.versions)
                          .map(([key, value]) => `${key} ${value}`)
                          .join(', '),
                      ],
                    ]
                  : []),
                ...(call.source
                  ? [
                      [
                        'Runtime',
                        `${call.source.repository} @ ${call.source.runtimeCommit ?? call.source.upstreamCommit}`,
                      ],
                      [
                        'Runtime fingerprint',
                        call.source.runtimeFingerprint ?? call.source.patchFingerprint,
                      ],
                      ['Installed source', call.source.fingerprint],
                    ]
                  : []),
                ...(call.error ? [['Error', call.error, 'warning']] : []),
              ]
            : [['State', 'No client calls recorded']],
        },
      ],
    },
  ];
}

export function clientSections(call, request, response, { itemIndex } = {}) {
  const at =
    itemIndex === undefined ? 0 : Math.max(0, Math.min(request.items.length - 1, itemIndex));
  const items = itemIndex === undefined ? request.items : request.items.slice(at, at + 1);
  const results =
    itemIndex === undefined
      ? (response?.results ?? response?.readings ?? (response?.graph ? [response] : []))
      : (response?.results ?? response?.readings ?? (response?.graph ? [response] : [])).slice(
          at,
          at + 1,
        );
  return [
    {
      label: 'Request',
      heading: `${call.client} request`,
      rows: [
        ['Client', call.client],
        ['Stage', clientStage(call.stage)],
        ['State', call.status],
        ...(itemIndex === undefined ? [] : [['Input', `${at + 1}/${request.items.length}`]]),
        [
          'Parameters',
          Object.entries(request.parameters ?? {})
            .map(([key, value]) => `${key}: ${value}`)
            .join('; '),
        ],
      ],
      table: table(
        call.client === 'SEMCAT'
          ? ['Reference AMR', 'Candidate AMR']
          : [['AMR', 'SEMANTIC'].includes(call.client) ? 'Input text' : 'Input AMR'],
        items.map((item) => ({
          cells:
            call.client === 'SEMCAT'
              ? [item.reference, item.hypothesis]
              : ['AMR', 'SEMANTIC'].includes(call.client)
                ? [item.text]
                : [
                    [
                      ...(item.operations ?? []).map(
                        (operation) =>
                          `${operation.kind}${operation.node ? `: ${operation.node}` : ''}`,
                      ),
                      item.penman ?? graphText(item.graph),
                    ].join('\n'),
                  ],
          cellTones: ['AMR', 'SEMANTIC'].includes(call.client)
            ? { 0: 'input' }
            : call.client === 'SEMCAT'
              ? { 0: 'amr', 1: 'amr' }
              : { 0: 'amr' },
        })),
      ),
    },
    {
      label: 'Response',
      heading: `${call.client} response`,
      rows: [
        ['Profile', response?.profile ?? 'No response'],
        ...(response?.source
          ? [
              [
                'Runtime',
                `${response.source.repository} @ ${response.source.runtimeCommit ?? response.source.upstreamCommit}`,
              ],
              [
                'Runtime fingerprint',
                response.source.runtimeFingerprint ?? response.source.patchFingerprint,
              ],
              ['Installed source', response.source.fingerprint],
            ]
          : []),
        ...(call.error ? [['Error', call.error, 'warning']] : []),
      ],
      table: table(
        call.client === 'SEMCAT'
          ? ['Pair', 'State / score', 'Correspondence']
          : ['Graph', 'State', 'Prepared AMR'],
        results.map((item, index) => ({
          cells:
            call.client === 'SEMCAT'
              ? [
                  String(index + at + 1),
                  item.complete
                    ? `Complete / ${item.score.toFixed(4)}`
                    : `${item.state ?? 'limited'}: ${item.reason ?? ''}`,
                  item.local?.correspondence.map((pair) => pair.join(' → ')).join('\n') ??
                    'Unavailable',
                ]
              : [
                  String(index + at + 1),
                  call.client === 'SEMANTIC'
                    ? (item.status ?? 'retained')
                    : call.client === 'AMR'
                      ? item.decode_status === 'ok'
                        ? 'Decoded'
                        : (item.decode_error ?? item.decode_status)
                      : item.ok
                        ? 'Prepared'
                        : (item.diagnostics ?? []).map((item) => item.message).join('; '),
                  item.penman ?? (item.graph ? graphText(item.graph) : 'Unavailable'),
                ],
          ...(['AMR', 'PENMAN'].includes(call.client) ? { cellTones: { 2: 'amr' } } : {}),
        })),
      ),
    },
  ];
}
const graphText = (graph) =>
  graph
    ? graph.nodes.map((node) => `${node.id} / ${node.concept}`).join('\n') +
      '\n' +
      graph.edges.map((edge) => `${edge.from} ${edge.role} ${edge.to}`).join('\n')
    : 'No graph';
