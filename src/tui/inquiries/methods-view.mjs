/** The workbench's sections for the Socratic methods (docs/methods.md), from
 * their reports: the corpus-wide methods at the root role, a statement's
 * elenchus and counterexamples, and a saved question's missing premises.
 * Read-only: each finding is a question or a proposal for a person. */

/** A finding: what it is and asks, then the statements it rests on. */
const findingRows = (finding) => [
  [finding.kind, finding.question ?? finding.proposal ?? finding.summary, 'warning'],
  ...finding.statements.map((item) => [
    '',
    `“${item.statement}” [${item.role}]${item.author ? ` (${item.author})` : ''}`,
    'muted',
  ]),
];

const methods = [
  ['aporia', 'Aporia: where the statements cannot hold together', 'They hold together.'],
  ['dilemma', 'Dilemma: what follows either way', 'Nothing follows from an alternative.'],
  ['analogy', 'Analogy: what holds here, asked there', 'No rule applies to one and not the other.'],
  ['dialogue', 'Dialogue: where authors clash or agree', 'No author clashes with another.'],
  [
    'equivocation',
    'Equivocation: words in more than one sense or structure',
    'Each word is read in one sense and one structure.',
  ],
  [
    'division',
    'Collection and division: the role tree',
    'Each role holds together; no statement leans elsewhere.',
  ],
];

/** The root role: each corpus-wide method, its findings or that it found none. */
export function corpusMethodsGroups(reports) {
  return methods.map(([name, heading, none]) => {
    const findings = reports[name].findings;
    return {
      heading,
      rows: findings.length
        ? findings.flatMap((finding) =>
            name === 'equivocation'
              ? [
                  [finding.kind, finding.summary, 'warning'],
                  ...(finding.senses ?? []).map((sense) => [
                    sense.concept,
                    sense.gloss ?? '',
                    'muted',
                  ]),
                  ...(finding.structures ?? []).map((item) => [
                    item.reading,
                    item.statements.map((entry) => `“${entry.statement}”`).join(' '),
                    'muted',
                  ]),
                  ['', finding.question],
                ]
              : findingRows(finding),
          )
        : [['', none, 'muted']],
    };
  });
}

/** A statement: asked of the others (elenchus), and its counterexamples. */
export function statementMethodsGroups(elenchus, counterexample) {
  const verdicts = {
    refuted: 'Refuted by the other statements.',
    contested: 'The other statements support it and refute it.',
    supported: 'The other statements support it; nothing refutes it.',
    open: 'Nothing in the other statements refutes or supports it.',
  };
  const counter = counterexample.statement.rule
    ? counterexample.applies
      ? `It applies ${counterexample.applies} ${counterexample.applies === 1 ? 'time' : 'times'}${counterexample.findings.length ? '.' : ', and nothing says otherwise.'}`
      : `It never applies: ${counterexample.never.charAt(0).toLowerCase()}${counterexample.never.slice(1)}`
    : counterexample.findings.length
      ? null
      : 'Nothing the other statements say opposes it.';
  return [
    {
      heading: 'Elenchus: asked of the others',
      rows: [
        ['', verdicts[elenchus.verdict] ?? 'It has no usable reading.', 'muted'],
        ...elenchus.findings.flatMap((finding) => [
          [
            finding.kind === 'refutes' ? 'refuted' : 'supported',
            finding.via === 'directly' ? 'directly' : `through “${finding.via.rule}”`,
            finding.kind === 'refutes' ? 'warning' : 'plain',
          ],
          ...finding.statements.map((item) => [
            '',
            `“${item.statement}” [${item.role}] (${item.author})`,
            'muted',
          ]),
        ]),
      ],
    },
    {
      heading: 'Counterexamples',
      rows: [
        ...(counter ? [['', counter, 'muted']] : []),
        ...counterexample.findings.flatMap(findingRows),
      ],
    },
  ];
}

/** A saved question left open: the premises an author could complete. */
export function questionMaieuticsGroups(report) {
  return [
    {
      heading: 'Maieutics: questions for authors',
      rows: report.findings.length
        ? report.findings.flatMap((finding) => [
            [
              finding.kind,
              finding.kind === 'missing premise'
                ? `${finding.premise} (then: ${finding.answers.join('; ')})`
                : finding.statements[0].statement,
              'warning',
            ],
            ['', `ask ${finding.author}: ${finding.ask}`],
            ...(finding.kind === 'missing premise'
              ? finding.statements.map((item) => [
                  '',
                  `through “${item.statement}” [${item.role}]`,
                  'muted',
                ])
              : []),
          ])
        : [['', 'No premise or connection found to ask about.', 'muted']],
    },
  ];
}
