/** The workbench's sections for recoil, tension lines, probes and authorship,
 * from the shared inspection reports. Read-only: nothing here checks again. */
import { effectSummary } from '../../project/inquiries/inspection.mjs';

const table = (headers, entries) => ({
  headers,
  widths: headers.map(() => null),
  minWidth: 0,
  repeatColumns: 0,
  entries,
});
const kinds = {
  statement: 'Statement',
  case: 'Case',
  rule: 'Rule',
  role: 'Role',
  question: 'Question',
};
const named = (row) => `${kinds[row.kind] ?? row.kind}: ${row.label}`;

/** While a report loads, when it is left to be asked for, or when it cannot be read. */
export function pendingGroups(heading, entry) {
  if (entry.status === 'ready') return null;
  return [
    {
      heading,
      rows: [
        [
          '',
          entry.status === 'loading'
            ? 'Reading the saved checks.'
            : entry.status === 'deferred'
              ? entry.note
              : entry.error,
          entry.status === 'error' ? 'warning' : 'muted',
        ],
      ],
    },
  ];
}

const frontierGroup = (report) =>
  report.frontier.length
    ? [
        {
          heading: 'Beyond the walk',
          table: table(
            ['What', 'Why it is not seen'],
            report.frontier.map((row) => ({ cells: [named(row), row.meaning] })),
          ),
        },
      ]
    : [];

/** A saved question: down (what its answer rests on), sideways (other
 * questions resting on the same statements) and the branches it brings
 * together. */
export function questionGroups(recoil, tensions, { text, caseText }) {
  const down = recoil.down.filter((row) => row.kind !== 'role');
  const own = tensions.questions.find(
    (item) => item.question === text && (item.case ?? null) === (caseText ?? null),
  );
  const roles = [
    ...new Set(recoil.down.filter((row) => row.kind === 'role').map((row) => row.label)),
  ];
  return [
    {
      heading: 'What the answer rests on',
      ...(down.length
        ? {
            table: table(
              ['How', 'What'],
              down.map((row) => ({ cells: [row.relation, named(row)] })),
            ),
          }
        : { rows: [['', 'The check cites no statement.', 'muted']] }),
      ...(roles.length ? { rows: [['Placed at', roles.join(', ')]] } : {}),
    },
    {
      heading: 'Other questions resting on the same statements',
      ...(recoil.sideways.length
        ? {
            table: table(
              ['Question', 'Through'],
              recoil.sideways.map((row) => ({
                cells: [row.label, row.through.join('\n')],
              })),
            ),
          }
        : { rows: [['', 'None at this revision.', 'muted']] }),
    },
    {
      heading: 'Juxtaposition: what it brings together',
      rows: own
        ? own.effect === 'juxtaposition'
          ? own.lines.map((line) => [
              line.between.join(' ↔ '),
              {
                resolved: 'resolved: one answer composes both',
                gathered: 'gathered: each gives its own answer',
                open: 'open: reached, not yet answered',
              }[line.status],
            ])
          : [
              [
                '',
                own.effect === 'branch'
                  ? `One branch: ${own.branches.join(', ')}.`
                  : 'It cites no statement.',
                'muted',
              ],
            ]
        : [['', 'Not checked at this revision.', 'muted']],
    },
    ...frontierGroup(recoil),
  ];
}

/** A statement: up (what rests on it), sideways (what is carried with it),
 * its probes and who wrote it. */
export function statementGroups(recoil, probes, author) {
  const up = recoil.up.filter((row) => row.kind === 'question');
  return [
    {
      heading: 'What rests on it',
      rows: [
        ...(up.length ? [] : [['', 'No checked question rests on it yet.', 'muted']]),
        ['Unaffected', `${recoil.unaffected} checked questions do not rest on it.`],
      ],
      ...(up.length
        ? {
            table: table(
              ['How', 'Question'],
              up.map((row) => ({ cells: [row.relation, row.label] })),
            ),
          }
        : {}),
    },
    ...(recoil.sideways.length
      ? [
          {
            heading: 'Carried with it',
            table: table(
              ['Statement', 'Through'],
              recoil.sideways.map((row) => ({ cells: [row.label, row.through.join('\n')] })),
            ),
          },
        ]
      : []),
    {
      heading: 'Asked back from its reading',
      ...(probes.status === 'ready'
        ? {
            table: table(
              ['Asks', 'With the blank', 'Outcome'],
              probes.value.statements.flatMap((item) =>
                item.probes.map((probe) => ({
                  cells: [
                    probe.asks,
                    probe.blanked,
                    `${probe.outcome}${probe.answers.length ? `: ${probe.answers.join('; ')}` : ''}`,
                  ],
                  cellTones: {
                    2: ['recovered', 'also elsewhere'].includes(probe.outcome)
                      ? 'plain'
                      : 'warning',
                  },
                })),
              ),
            ),
          }
        : {
            rows: [['', probes.status === 'loading' ? 'Asking it back.' : probes.error, 'muted']],
          }),
    },
    {
      heading: 'Written by',
      rows: [
        ['Author', author.author],
        ...(author.via
          ? [['Through', author.via === 'editor' ? 'the workbench' : author.via]]
          : []),
        ...(author.at ? [['When', author.at]] : []),
        ...(author.declaredAuthor ? [['Declared author', author.declaredAuthor]] : []),
        ...(author.proposer ? [['Proposed by', JSON.stringify(author.proposer)]] : []),
        ['', 'Declared, not verified.', 'muted'],
      ],
    },
    ...frontierGroup(recoil),
  ];
}

/** A role with children: the tension lines between its branches. */
export function roleTensionGroups(tensions) {
  return [
    {
      heading: 'Juxtaposition: tension lines',
      rows: [['', effectSummary(tensions.effects), 'muted']],
      ...(tensions.lines.length
        ? {
            table: table(
              ['Between', 'Resolved', 'Gathered', 'Open'],
              tensions.lines.map((line) => ({
                cells: [
                  line.between.join(' ↔ '),
                  line.resolved.join('\n'),
                  line.gathered.join('\n'),
                  line.open.join('\n'),
                ],
              })),
            ),
          }
        : {}),
    },
  ];
}

/** The root role: corpus fidelity, what the statements can be asked back for
 * and what the checked questions rest on. */
export function fidelityGroups(report) {
  const t = report.totals,
    q = report.questions;
  const share = (part, whole) => (whole ? ` (${Math.round((100 * part) / whole)}%)` : '');
  const review = report.statements.filter((item) => item.review.length || !item.read);
  const reviewing = t.possible + t.otherwise + t.owed + t.conflict;
  return [
    {
      heading: 'Corpus fidelity',
      rows: [
        [
          'Asked back',
          `${t.variables} variables of ${t.statements} statements; answerable ${t.answerable}${share(t.answerable, t.variables)}: own ${t.own}, shared ${t.shared}, carried ${t.carried}`,
        ],
        ['Silent', `${t.silent}: a condition not given, or a necessary condition`, 'muted'],
        [
          'To review',
          `possible ${t.possible}, otherwise ${t.otherwise}, owed ${t.owed}, conflict ${t.conflict}`,
          reviewing ? 'warning' : 'muted',
        ],
        ['Settled', `${t.settled} of ${t.statements} statements`],
        [
          'Questions',
          `${q.total} checked: one statement ${q.one}, composed ${q.composed} (across roles ${q.composedAcrossRoles}), conditional ${q.conditional}, possible ${q.possible}, composition met ${q.met}, open ${q.open}`,
        ],
      ],
      table: table(
        ['Role', 'Statements', 'Variables', 'Answerable', 'Settled', 'Rested on'],
        report.roles.map((role) => ({
          cells: [
            role.role ?? '',
            ...[role.statements, role.variables, role.answerable, role.settled, role.restedOn].map(
              String,
            ),
          ],
        })),
      ),
    },
    ...(review.length
      ? [
          {
            heading: 'Corpus fidelity: to review',
            rows: review.flatMap((item) => [
              [item.role, item.statement],
              ...(item.read ? [] : [['', 'no reading: nothing can be asked back', 'warning']]),
              ...item.review.map((slot) => ['', `${slot.kind}: ${slot.asks}`, 'warning']),
            ]),
          },
        ]
      : []),
  ];
}
