/** What the third and fourth reviews of the Socratic methods found, kept
 * from coming back (the first two reviews' cases are in method-guards.mjs).
 * Who a finding is about comes from the engine's own match, and a rule's
 * findings stay on one occasion; a value that labels tells participants
 * apart; a term matches its own forms. Each case is a copy of the demo with
 * readings written here; nothing is saved or acquired, and the copies are
 * left in tmp/. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openProject } from '../../src/project/authoring/project.mjs';
import { elenchusReport } from '../../src/project/inquiries/elenchus.mjs';
import { aporiaReport } from '../../src/project/inquiries/aporia.mjs';
import { counterexampleReport } from '../../src/project/inquiries/counterexample.mjs';
import { divisionReport, formatDivision } from '../../src/project/inquiries/division.mjs';
import { dialogueReport } from '../../src/project/inquiries/dialogue.mjs';
import { definitionReport } from '../../src/project/inquiries/definition.mjs';
import { methodsDemo } from '../support/methods-demo.mjs';

globalThis.fetch = () => {
  throw new Error('NETWORK_FORBIDDEN');
};
const person = (id, name) => `(${id} / person :name (${id}n / name :op1 "${name}"))`;
const texts = (finding) => finding.statements.map((item) => item.statement).sort();
const open = (prefix, options) => methodsDemo(prefix, options).then(openProject);
const cli = (path, ...args) =>
  spawnSync(process.execPath, ['src/cli/engine.mjs', ...args, '--project', path, '--offline'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

// The third review: who a participant is comes from the engine's own match
// (the node that filled the question's), never from a statement's first
// mention or from two nodes the reader left apart.
const reviews = 'If someone reviews logs, they file a note.';
const logs = {
  [reviews]:
    '(f / file-01 :ARG0 (e / person) :ARG1 (n / note) :condition (r / review-01 :ARG0 e :ARG1 (l / log)))',
  'Kim reviews logs.': `(r / review-01 :ARG0 ${person('k', 'Kim')} :ARG1 (l / log))`,
  'Kim files no note.': `(f / file-01 :polarity - :ARG0 ${person('q', 'Kim')} :ARG1 (n / note))`,
  'Lee files no note.': `(f / file-01 :polarity - :ARG0 ${person('v', 'Lee')} :ARG1 (n / note))`,
};
const ledger = await open('guard-occasion', {
  roles: { Audit: Object.keys(logs) },
  extra: {
    ...logs,
    // Theses supposed below, read as a text is.
    'Lee reviews logs.': `(r / review-01 :ARG0 ${person('v', 'Lee')} :ARG1 (l / log))`,
    'Mo reviews logs.': `(r / review-01 :ARG0 ${person('m', 'Mo')} :ARG1 (l / log))`,
  },
  authors: {
    [reviews]: 'Robin',
    'Kim reviews logs.': 'Kim',
    'Kim files no note.': 'Kay',
    'Lee files no note.': 'Lee',
  },
});
const lee = (finding) => texts(finding).includes('Lee files no note.');
const kim = (finding) =>
  texts(finding).includes('Kim files no note.') && texts(finding).includes('Kim reviews logs.');
// Under its condition, a rule's answer is about whoever met it: Lee files no
// note, but nothing says Lee reviews logs. Kim does, and is cited.
const talk = (await dialogueReport(ledger)).findings.filter((finding) =>
  texts(finding).includes(reviews),
);
assert(!talk.some(lee), 'dialogue: no clash with Lee, who reviews no logs');
assert(
  talk.some((finding) => finding.kind === 'clash' && kim(finding)),
  'dialogue: Kim reviews logs and files no note',
);
// Aporia: Kim's case is one finding, named as the rule's case over a plain
// contradiction of the same statements (fourth review, #5); Lee's none.
const puzzle = (await aporiaReport(ledger, { role: 'Audit' })).findings;
assert(!puzzle.some(lee), 'aporia: never Lee');
assert(
  puzzle.some((finding) => kim(finding) && finding.kind === 'in its case'),
  "aporia: Kim's, in its case",
);
const tested = await elenchusReport(ledger, { statement: reviews });
assert(!tested.findings.some(lee) && tested.findings.some(kim), 'elenchus: Kim refutes, Lee not');
// Supposed, "Mo reviews logs" makes the rule apply to Mo: Kim's and Lee's
// missing notes deny nothing about Mo. Supposed of Lee, Lee's does.
const supposeOf = async (who) => {
  const report = await elenchusReport(ledger, { text: `${who} reviews logs.`, offline: true });
  assert.equal(report.thesis.reading, 'read', `${who}: the thesis is read`);
  return report.findings.filter((finding) => finding.via?.rule === reviews);
};
assert.deepEqual(await supposeOf('Mo'), [], "through the rule: no one else's note is Mo's");
const throughLee = await supposeOf('Lee');
assert(
  throughLee.length &&
    throughLee.every((finding) => lee(finding) && !texts(finding).includes('Kim files no note.')),
  "through the rule: Lee's missing note, not Kim's",
);

// Two mentions of Alex the reader gave two nodes are one Alex, linked by name:
// Alex 123 running the backup and Alex 456 not sounding the alarm are two.
const apart = (second) => ({
  'Only if Alex sounds the alarm, Alex runs the backup.':
    '(r / run-01 :ARG0 (x / person :name (xn / name :op1 "Alex")) :ARG1 (b / backup) :condition (s / sound-01 :ARG0 (y / person :name (yn / name :op1 "Alex")) :ARG1 (a / alarm) :mod (o / only)))',
  'Alex with employee ID 123 runs the backup.':
    '(r / run-01 :ARG0 (x / person :name (xn / name :op1 "Alex") :mod (i / identifier :value 123)) :ARG1 (b / backup))',
  [`Alex with employee ID ${second} does not sound the alarm.`]: `(s / sound-01 :polarity - :ARG0 (x / person :name (xn / name :op1 "Alex") :mod (i / identifier :value ${second})) :ARG1 (a / alarm))`,
});
for (const [second, verdict] of [
  [456, 'open'],
  [123, 'refuted'],
]) {
  const readings = apart(second);
  const report = await elenchusReport(
    await open(`guard-apart-${second}`, {
      roles: { Alarm: Object.keys(readings).slice(1) },
      extra: readings,
    }),
    { text: 'Only if Alex sounds the alarm, Alex runs the backup.', offline: true },
  );
  assert.equal(report.verdict, verdict, `two nodes, IDs 123 and ${second}`);
}
const alexId = (id, value) =>
  `(${id} / person :name (${id}n / name :op1 "Alex") :mod (${id}i / identifier :value ${value}))`;
const twoNodes = 'If Alex reviews logs, Alex files a note.';
const twoNodeReadings = {
  [twoNodes]:
    '(f / file-01 :ARG0 (a / person :name (an / name :op1 "Alex")) :ARG1 (n / note) :condition (r / review-01 :ARG0 (b / person :name (bn / name :op1 "Alex")) :ARG1 (l / log)))',
  'Alex with employee ID 123 reviews logs.': `(r / review-01 :ARG0 ${alexId('p', 123)} :ARG1 (l / log))`,
  'Alex with employee ID 123 files no note.': `(f / file-01 :polarity - :ARG0 ${alexId('s', 123)} :ARG1 (n / note))`,
  'Alex with employee ID 456 files no note.': `(f / file-01 :polarity - :ARG0 ${alexId('q', 456)} :ARG1 (n / note))`,
};
const twoNodePairs = (
  await counterexampleReport(
    await open('guard-two-nodes', {
      roles: { Audit: Object.keys(twoNodeReadings) },
      extra: twoNodeReadings,
    }),
    { statement: twoNodes },
  )
).findings.map(texts);
const pairOf = (a, b) => twoNodePairs.some((pair) => pair.includes(a) && pair.includes(b));
assert(
  !pairOf('Alex with employee ID 123 reviews logs.', 'Alex with employee ID 456 files no note.'),
  'counterexample: Alex 123 reviewing is no occasion for Alex 456',
);
assert(
  pairOf('Alex with employee ID 123 reviews logs.', 'Alex with employee ID 123 files no note.'),
  'counterexample: Alex 123 reviews and files no note',
);

// The conjunct that answers is the one compared, first or second.
const conjunct = {
  first: [
    'Robin files no note and Kim files a note.',
    `(a / and :op1 (f / file-01 :polarity - :ARG0 ${person('p', 'Robin')} :ARG1 (n / note)) :op2 (k / file-01 :ARG0 ${person('q', 'Kim')} :ARG1 (m / note)))`,
  ],
  second: [
    'Kim files a note and Robin files no note.',
    `(a / and :op1 (k / file-01 :ARG0 ${person('q', 'Kim')} :ARG1 (m / note)) :op2 (f / file-01 :polarity - :ARG0 ${person('p', 'Robin')} :ARG1 (n / note)))`,
  ],
};
for (const [order, [text, reading]] of Object.entries(conjunct)) {
  const report = await counterexampleReport(
    await open(`guard-conjunct-${order}`, {
      roles: { Audit: [reviews, 'Robin reviews logs.', text] },
      extra: {
        [reviews]: logs[reviews],
        'Robin reviews logs.': `(r / review-01 :ARG0 ${person('w', 'Robin')} :ARG1 (l / log))`,
        [text]: reading,
      },
    }),
    { statement: reviews },
  );
  assert(
    report.findings.some((finding) => texts(finding).includes(text)),
    `Robin's missing note found, said ${order}`,
  );
}
const coupled = 'Only if Alex sounds the alarm, Alex runs the backup.';
for (const [order, pair] of Object.entries({ first: ['u', 'v'], second: ['v', 'u'] })) {
  const who = { u: 'Alex', v: 'Kim' };
  const silent = `${who[pair[0]]} and ${who[pair[1]]} do not sound the alarm.`;
  const report = await elenchusReport(
    await open(`guard-silent-${order}`, {
      roles: { Alarm: ['Alex runs the backup.', silent] },
      extra: {
        [coupled]:
          '(r / run-01 :ARG0 (x / person :name (xn / name :op1 "Alex")) :ARG1 (b / backup) :condition (s / sound-01 :ARG0 x :ARG1 (a / alarm) :mod (o / only)))',
        'Alex runs the backup.': `(r / run-01 :ARG0 ${person('x', 'Alex')} :ARG1 (b / backup))`,
        [silent]: `(a / and :op1 (s1 / sound-01 :polarity - :ARG0 ${person(pair[0], who[pair[0]])} :ARG1 (a1 / alarm)) :op2 (s2 / sound-01 :polarity - :ARG0 ${person(pair[1], who[pair[1]])} :ARG1 (a2 / alarm)))`,
      },
    }),
    { text: coupled, offline: true },
  );
  assert.equal(report.verdict, 'refuted', `Alex said ${order} among those who do not sound it`);
}

// A name-like value tells two people apart, whatever its kind; the same
// value is one person.
for (const kind of ['passport', 'license', 'employee']) {
  for (const [second, count] of [
    [456, 0],
    [123, 1],
  ]) {
    const approves = `Alex with ${kind} 123 approves the release.`;
    const refuses = `Alex with ${kind} ${second} does not approve the release.`;
    const report = await aporiaReport(
      await open(`guard-${kind}-${second}`, {
        roles: { People: [approves, refuses] },
        extra: {
          [approves]: `(a / approve-01 :ARG0 (x / person :name (xn / name :op1 "Alex") :mod (i / ${kind} :value 123)) :ARG1 (r / release-01))`,
          [refuses]: `(d / approve-01 :polarity - :ARG0 (y / person :name (yn / name :op1 "Alex") :mod (j / ${kind} :value ${second})) :ARG1 (rr / release-01))`,
        },
      }),
      { role: 'People' },
    );
    assert.equal(report.findings.length, count, `${kind} 123 and ${second}`);
  }
}

// A counterexample to a statement without a reading was never asked: it says
// so and exits 1.
const vaultPath = await methodsDemo('guard-vault', { roles: { Vault: ['The vault opens.'] } });
const vaultCli = cli(vaultPath, 'counterexample', '--statement', 'The vault opens.', '--json');
assert.equal(vaultCli.status, 1, 'no reading: exit 1');
assert.deepEqual(
  JSON.parse(vaultCli.stdout).unread.map((item) => item.statement),
  ['The vault opens.'],
);

// A term matches itself however short, and a singular that ends in s is no
// plural: "alia" is not "alias".
const terms = await open('guard-terms', {
  roles: { Names: ['An ox is a beast.', 'An alias is a name.', 'A gas is a fluid.'] },
  extra: {
    'An ox is a beast.': '(b / beast :domain (o / ox))',
    'An alias is a name.': '(n / name :domain (a / alias))',
    'A gas is a fluid.': '(f / fluid :domain (g / gas))',
  },
});
for (const [term, genus] of [
  ['ox', ['An ox is a beast.']],
  ['alia', []],
  ['aliases', ['An alias is a name.']],
  ['gases', ['A gas is a fluid.']],
  ['ga', []],
]) {
  const report = await definitionReport(terms, { term });
  assert.deepEqual(
    report.genus.map((row) => row.statement),
    genus,
    `definition of ${term}`,
  );
}

// A division names whom to ask: every statement with its role and author.
const split = await divisionReport(
  await open('guard-split', {
    roles: { Split: ['The backup completes.', 'Priya reviews logs.'] },
    extra: {
      'The backup completes.': '(c / complete-01 :ARG1 (b / backup))',
      'Priya reviews logs.': `(r / review-01 :ARG0 ${person('p', 'Priya')} :ARG1 (l / log))`,
    },
    authors: { 'The backup completes.': 'Ada', 'Priya reviews logs.': 'Bo' },
  }),
);
const divided = split.findings.find((finding) => finding.kind === 'division');
assert(divided, 'the two statements share nothing: a division');
const splitText = formatDivision({ ...split, findings: [divided] });
assert.match(splitText, /“The backup completes\.” \[Split\] \(Ada\)/u);
assert.match(splitText, /“Priya reviews logs\.” \[Split\] \(Bo\)/u);

// The fourth review: "someone" and "they" read as two unnamed nodes are one
// participant; the rule's findings stay on one occasion all the same.
const unlinked = {
  [reviews]:
    '(f / file-01 :ARG0 (q / person) :ARG1 (n / note) :condition (r / review-01 :ARG0 (e / person) :ARG1 (l / log)))',
  'Kim reviews logs.': logs['Kim reviews logs.'],
  'Kim files no note.': logs['Kim files no note.'],
  'Lee files no note.': logs['Lee files no note.'],
};
const apartNodes = await open('guard-two-unnamed', {
  roles: { Audit: Object.keys(unlinked) },
  extra: unlinked,
  authors: { [reviews]: 'Robin', 'Lee files no note.': 'Lee', 'Kim files no note.': 'Kay' },
});
const apartCounter = (await counterexampleReport(apartNodes, { statement: reviews })).findings;
assert(!apartCounter.some(lee) && apartCounter.some(kim), 'two unnamed nodes: Kim, never Lee');
assert(
  !(await dialogueReport(apartNodes)).findings.some(lee),
  'two unnamed nodes: no clash with Lee',
);
assert(
  !(await aporiaReport(apartNodes, { role: 'Audit' })).findings.some(lee),
  'two unnamed nodes: aporia, never Lee',
);
// One identifier read as :value by one reading and :mod by another is one
// Alex; another value is another (fourth review, #4).
for (const [second, count] of [
  [123, 1],
  [456, 0],
]) {
  const approves = 'Alex with ID 123 approves the release.';
  const refuses = `Alex with ID ${second} does not approve the release.`;
  const report = await aporiaReport(
    await open(`guard-attached-${second}`, {
      roles: { People: [approves, refuses] },
      extra: {
        [approves]:
          '(a / approve-01 :ARG0 (x / person :name (xn / name :op1 "Alex") :mod (i / identifier :value 123)) :ARG1 (r / release-01))',
        [refuses]: `(d / approve-01 :polarity - :ARG0 (y / person :name (yn / name :op1 "Alex") :mod (j / identifier :mod ${second})) :ARG1 (rr / release-01))`,
      },
    }),
    { role: 'People' },
  );
  assert.equal(report.findings.length, count, `:value 123 and :mod ${second}`);
}
// Plurals a suffix rule misses: analyses, oxen (fourth review, #6).
const morph = await open('guard-morph', {
  roles: { Words: ['An analysis is a study.', 'An ox is a beast.'] },
  extra: {
    'An analysis is a study.': '(s / study :domain (a / analysis))',
    'An ox is a beast.': '(b / beast :domain (o / ox))',
  },
});
for (const [term, genus] of [
  ['analyses', ['An analysis is a study.']],
  ['oxen', ['An ox is a beast.']],
]) {
  const report = await definitionReport(morph, { term });
  assert.deepEqual(
    report.genus.map((row) => row.statement),
    genus,
    `definition of ${term}`,
  );
}

console.log('ok method guards, later: what the third and fourth reviews found stays fixed');
