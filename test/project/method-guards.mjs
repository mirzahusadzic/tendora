/** What the review of the Socratic methods found, kept from coming back. Each
 * case is a copy of the demo with a role or two whose readings are written
 * here, so the corpus says exactly what the case needs. A finding the
 * statements do not support is worse than one missed: a conditional denial,
 * a namesake, a necessary condition, an unrelated occasion, an unread
 * statement, a bounded search or a statement outside the scope never makes
 * one. Nothing is saved or acquired; the copies are left in tmp/. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openProject } from '../../src/project/authoring/project.mjs';
import { yesNo } from '../../src/project/inquiries/corpus.mjs';
import { elenchusReport } from '../../src/project/inquiries/elenchus.mjs';
import { aporiaReport, formatAporia } from '../../src/project/inquiries/aporia.mjs';
import { counterexampleReport } from '../../src/project/inquiries/counterexample.mjs';
import { divisionReport, formatDivision } from '../../src/project/inquiries/division.mjs';
import { dialogueReport } from '../../src/project/inquiries/dialogue.mjs';
import { hypothesisReport } from '../../src/project/inquiries/hypothesis.mjs';
import { maieuticsReport } from '../../src/project/inquiries/maieutics.mjs';
import { definitionReport, formatDefinition } from '../../src/project/inquiries/definition.mjs';
import {
  equivocationReport,
  formatEquivocation,
} from '../../src/project/inquiries/equivocation.mjs';
import { shape } from '../../src/project/inquiries/analogy.mjs';
import { methodInWorker } from '../../src/project/inquiries/methods.mjs';
import { fidelityInWorker } from '../../src/project/inquiries/fidelity.mjs';
import { methodsDemo } from '../support/methods-demo.mjs';

globalThis.fetch = () => {
  throw new Error('NETWORK_FORBIDDEN');
};
const person = (id, name) => `(${id} / person :name (${id}n / name :op1 "${name}"))`;
const texts = (finding) => finding.statements.map((item) => item.statement).sort();
const open = (prefix, options) => methodsDemo(prefix, options).then(openProject);

// 1. A denial that holds only at night refutes nothing outright.
const night = await open('guard-conditional', {
  roles: { Backups: ['At night, the backup does not run.'] },
  extra: {
    'At night, the backup does not run.':
      '(r / run-01 :polarity - :ARG1 (b / backup) :time (n / night))',
    'The backup runs.': '(r / run-01 :ARG1 (b / backup))',
  },
});
const runs = await elenchusReport(night, { text: 'The backup runs.', offline: true });
assert.deepEqual([runs.verdict, runs.findings.length], ['open', 0], 'only at night: no refutation');

// 2. Two Alexes told apart by their employee IDs are two people.
const ids = {
  'Alex with employee ID 123 approves the release.': `(a / approve-01 :ARG0 (x / person :name (xn / name :op1 "Alex") :mod (i / identifier :value 123)) :ARG1 (r / release-01))`,
  'Alex with employee ID 456 does not approve the release.': `(d / approve-01 :polarity - :ARG0 (y / person :name (yn / name :op1 "Alex") :mod (j / identifier :value 456)) :ARG1 (rr / release-01))`,
};
const namesakes = await aporiaReport(
  await open('guard-namesakes', { roles: { People: Object.keys(ids) }, extra: ids }),
  { role: 'People' },
);
assert.deepEqual(namesakes.findings, [], 'different IDs, no contradiction');

// 3. "Only if the alarm sounds, the backup runs": that the alarm sounds and
// the backup does not run is no refutation; that the backup runs and the
// alarm does not sound is.
const onlyIf = {
  'Only if the alarm sounds, the backup runs.':
    '(r / run-01 :ARG1 (b / backup) :condition (s / sound-01 :ARG0 (a / alarm) :mod (o / only)))',
  'The alarm sounds.': '(s / sound-01 :ARG0 (a / alarm))',
  'The backup does not run.': '(r / run-01 :polarity - :ARG1 (b / backup))',
  'The backup runs.': '(r / run-01 :ARG1 (b / backup))',
  'The alarm does not sound.': '(s / sound-01 :polarity - :ARG0 (a / alarm))',
};
const kept = await elenchusReport(
  await open('guard-necessary-kept', {
    roles: { Alarm: ['The alarm sounds.', 'The backup does not run.'] },
    extra: onlyIf,
  }),
  { text: 'Only if the alarm sounds, the backup runs.', offline: true },
);
assert.equal(
  kept.verdict,
  'open',
  'a necessary condition is not refuted by its failing conclusion',
);
const broken = await elenchusReport(
  await open('guard-necessary-broken', {
    roles: { Alarm: ['The backup runs.', 'The alarm does not sound.'] },
    extra: onlyIf,
  }),
  { text: 'Only if the alarm sounds, the backup runs.', offline: true },
);
assert.equal(broken.verdict, 'refuted');
assert.deepEqual(broken.findings.map(texts), [['The alarm does not sound.', 'The backup runs.']]);

// 4. Robin and Kim both review logs and file no note: two counterexamples,
// each one occasion, never Robin's review with Kim's missing note.
const audit = {
  'If someone reviews logs, they file a note.':
    '(f / file-01 :ARG0 (e / person) :ARG1 (n / note) :condition (r / review-01 :ARG0 e :ARG1 (l / log)))',
  'Robin reviews logs.': `(r / review-01 :ARG0 ${person('p', 'Robin')} :ARG1 (l / log))`,
  'Kim reviews logs.': `(r / review-01 :ARG0 ${person('k', 'Kim')} :ARG1 (l / log))`,
  'Robin files no note.': `(f / file-01 :polarity - :ARG0 ${person('p', 'Robin')} :ARG1 (n / note))`,
  'Kim files no note.': `(f / file-01 :polarity - :ARG0 ${person('k', 'Kim')} :ARG1 (n / note))`,
};
const audited = await counterexampleReport(
  await open('guard-occasions', { roles: { Audit: Object.keys(audit) }, extra: audit }),
  { statement: 'If someone reviews logs, they file a note.' },
);
assert.deepEqual(audited.findings.map(texts).sort(), [
  ['Kim files no note.', 'Kim reviews logs.'],
  ['Robin files no note.', 'Robin reviews logs.'],
]);

// 5. A statement without a reading is not asked, and the report says so
// rather than that nothing opposes.
const unreadPath = await methodsDemo('guard-unread', {
  roles: { Approvals: ['Jo approves the change.', 'Jo does not approve the change.'] },
  extra: {
    'Jo approves the change.': `(a / approve-01 :ARG0 ${person('j', 'Jo')} :ARG1 (c / change-01))`,
  },
});
const unread = await aporiaReport(await openProject(unreadPath), { role: 'Approvals' });
assert.deepEqual(
  unread.unread.map((item) => item.statement),
  ['Jo does not approve the change.'],
);
assert.match(
  formatAporia(unread),
  /nothing found among what was read\.\n\nNot asked: 1 statement has no reading\./u,
);
const unreadCli = spawnSync(
  process.execPath,
  ['src/cli/engine.mjs', 'aporia', '--project', unreadPath, '--offline', '--role', 'Approvals'],
  { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
);
assert.equal(unreadCli.status, 1, 'a statement left unread: needs a reading, exit 1');

// 6. A search that stopped at its bound proves nothing either way.
assert.deepEqual(
  yesNo({ status: 'limited', answers: [], candidates: [{ text: 'No', sourceIds: ['x'] }] }),
  { status: 'limited', limited: true, yes: [], no: [], qualified: [] },
);

// 7. Within a role, a statement outside it is withheld.
const scoped = await open('guard-scope', {
  roles: {
    Inside: ['The database backup completes.'],
    Outside: ['The database backup does not complete.'],
  },
  extra: {
    'The database backup completes.': '(c / complete-01 :ARG1 (b / backup :mod (d / database)))',
    'The database backup does not complete.':
      '(c / complete-01 :polarity - :ARG1 (b / backup :mod (d / database)))',
  },
});
assert.deepEqual((await aporiaReport(scoped, { role: 'Inside' })).findings, []);
assert(
  (await aporiaReport(scoped)).findings.some(
    (finding) =>
      JSON.stringify(texts(finding)) ===
      JSON.stringify(['The database backup completes.', 'The database backup does not complete.']),
  ),
  'at the root both are asked',
);

// 9. A rule said again in other words follows also without the supposition.
const vault = {
  'The vault opens.': '(o / open-01 :ARG1 (v / vault))',
  'If the vault opens, Sam notifies the customers.': `(n / notify-01 :ARG0 ${person('s', 'Sam')} :ARG1 (c / customer) :condition (o / open-01 :ARG1 (v / vault)))`,
  'Sam notifies the customers if the vault opens.': `(n / notify-01 :ARG0 ${person('s', 'Sam')} :ARG1 (c / customer) :condition (o / open-01 :ARG1 (v / vault)))`,
};
const again = await hypothesisReport(
  await open('guard-again', {
    roles: { Vault: ['The vault opens.', 'If the vault opens, Sam notifies the customers.'] },
    extra: vault,
  }),
  { text: 'Sam notifies the customers if the vault opens.', offline: true },
);
assert.deepEqual(
  again.follows.map((rule) => [rule.rule, rule.ofSupposition, rule.onlyWith]),
  [['Sam notifies the customers if the vault opens.', true, 0]],
  'its own rule applies, and follows also without it',
);
assert.equal(again.nothingFollows, true);

// 10. The same words at two roles are two commitments.
const twice = {
  'The nightly backup completes.': '(c / complete-01 :ARG1 (b / backup :mod (n / nightly)))',
  'The nightly backup does not complete.':
    '(c / complete-01 :polarity - :ARG1 (b / backup :mod (n / nightly)))',
};
const two = await aporiaReport(
  await open('guard-twice', {
    roles: { North: Object.keys(twice), South: Object.keys(twice) },
    extra: twice,
  }),
);
const roles = new Set(
  two.findings
    .filter((finding) => finding.statements.some((item) => item.statement in twice))
    .flatMap((finding) => finding.statements.map((item) => item.role)),
);
assert.deepEqual([...roles].sort(), ['North', 'South'], 'both roles keep their contradiction');

// 11, 12, 16, 18: on the demo as bundled.
await mkdir('tmp', { recursive: true });
const plain = join(await mkdtemp(resolve('tmp/guard-plain-')), 'payments-demo');
await cp(resolve('demo/payments-on-call'), plain, { recursive: true });
const demo = await openProject(plain);
const changes = await definitionReport(demo, { term: 'changes' });
assert.deepEqual(
  changes.species.map((row) => row.statement),
  ['A deployment is a change.'],
  'a plural term is its singular',
);
const major = await definitionReport(demo, { term: 'major change' });
assert.deepEqual([major.term, major.asked], ['change', 'major change']);
assert.match(
  formatDefinition(major),
  /^Definition of “change” \(the last word of “major change”\)/u,
);
assert.match(formatDefinition(changes), /\[Release Manager\] \(Claude\)/u, 'authors shown');
assert.match(
  formatEquivocation(await equivocationReport(demo)),
  /\[Database Administrator\] \(unrecorded\)/u,
);
const invoice = await maieuticsReport(demo, {
  question: 'Who approves the database vendor invoice?',
});
assert(
  invoice.findings.length &&
    invoice.findings.every((finding) => finding.scope === 'Release Manager'),
);
await assert.rejects(
  maieuticsReport(demo, { question: 'Which zebra gallops?' }),
  /No such saved question/u,
);

// 14. Negated under a modal frame is negated: "must not" and "must" differ.
const must = (negated) => ({
  top: 'o',
  nodes: [
    { id: 'o', concept: 'obligate-01' },
    { id: 'p', concept: 'promise-01' },
    { id: 's', concept: 'person' },
    { id: 't', concept: 'time' },
    ...(negated ? [{ id: 'n', concept: '-', literal: '-' }] : []),
  ],
  edges: [
    { from: 'o', role: ':ARG1', to: 'p' },
    { from: 'o', role: ':ARG2', to: 's' },
    { from: 'p', role: ':ARG0', to: 's' },
    { from: 'p', role: ':ARG1', to: 't' },
    ...(negated ? [{ from: 'p', role: ':polarity', to: 'n' }] : []),
  ],
});
assert.notEqual(shape(must(true)).key, shape(must(false)).key);

// 13. A worker stopped at once settles its promise.
const stop = new AbortController();
const corpus = methodInWorker(demo, 'corpus', {}, { signal: stop.signal });
const fidelity = fidelityInWorker(demo, { signal: stop.signal });
stop.abort();
await assert.rejects(corpus, /Stopped\./u);
await assert.rejects(fidelity, /Stopped\./u);

// The second review: what the fixes still let through.
const cli = (path, ...args) =>
  spawnSync(process.execPath, ['src/cli/engine.mjs', ...args, '--project', path, '--offline'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

// "Only if" in a dialogue: whoever says the backup runs, or denies it,
// neither shares nor opposes "only if the alarm sounds, the backup runs".
const onlyIfVoices = await dialogueReport(
  await open('guard-dialogue-necessary', {
    roles: {
      Ops: ['Only if the alarm sounds, the backup runs.', 'The backup runs.'],
      Night: ['The backup does not run.'],
    },
    extra: onlyIf,
    authors: {
      'Only if the alarm sounds, the backup runs.': 'Dana',
      'The backup runs.': 'Eli',
      'The backup does not run.': 'Fay',
    },
  }),
);
assert(
  !onlyIfVoices.findings.some((finding) =>
    finding.statements.some((item) => item.statement.startsWith('Only if')),
  ),
  'a necessary claim is neither shared nor opposed by its conclusion',
);

// A necessary thesis is refuted on one occasion only: Alex 123 running the
// backup and Alex 456 not sounding the alarm are two Alexes; one Alex is one.
const alexes = (second) => ({
  'Only if Alex sounds the alarm, Alex runs the backup.':
    '(r / run-01 :ARG0 (x / person :name (xn / name :op1 "Alex")) :ARG1 (b / backup) :condition (s / sound-01 :ARG0 x :ARG1 (a / alarm) :mod (o / only)))',
  'Alex with employee ID 123 runs the backup.':
    '(r / run-01 :ARG0 (x / person :name (xn / name :op1 "Alex") :mod (i / identifier :value 123)) :ARG1 (b / backup))',
  [`Alex with employee ID ${second} does not sound the alarm.`]: `(s / sound-01 :polarity - :ARG0 (x / person :name (xn / name :op1 "Alex") :mod (i / identifier :value ${second})) :ARG1 (a / alarm))`,
});
for (const [second, verdict] of [
  [456, 'open'],
  [123, 'refuted'],
]) {
  const readings = alexes(second);
  const report = await elenchusReport(
    await open(`guard-necessary-${second}`, {
      roles: { Alarm: Object.keys(readings).slice(1) },
      extra: readings,
    }),
    { text: 'Only if Alex sounds the alarm, Alex runs the backup.', offline: true },
  );
  assert.equal(report.verdict, verdict, `IDs 123 and ${second}`);
}

// A counterexample at the place the rule links: the reviewer is the one who
// files. Priya reviewing Morgan's log is no occasion for Morgan's note; an
// unnamed condition ("the vault opens") pairs with its denial.
const linked = await counterexampleReport(
  await open('guard-linked', {
    roles: {
      Audit: [
        'If someone reviews logs, they file a note.',
        "Priya reviews Morgan's log.",
        'Morgan files no note.',
      ],
    },
    extra: {
      'If someone reviews logs, they file a note.':
        audit['If someone reviews logs, they file a note.'],
      "Priya reviews Morgan's log.": `(r / review-01 :ARG0 ${person('p', 'Priya')} :ARG1 (l / log :poss ${person('m', 'Morgan')}))`,
      'Morgan files no note.': `(f / file-01 :polarity - :ARG0 ${person('m', 'Morgan')} :ARG1 (n / note))`,
    },
  }),
  { statement: 'If someone reviews logs, they file a note.' },
);
assert.deepEqual(linked.findings, [], 'Morgan owns the log; Priya is the one who files');
const unnamed = await counterexampleReport(
  await open('guard-unnamed', {
    roles: {
      Vault: [
        'If the vault opens, Sam notifies the customers.',
        'The vault opens.',
        'Sam does not notify the customers.',
      ],
    },
    extra: {
      ...vault,
      'Sam does not notify the customers.': `(n / notify-01 :polarity - :ARG0 ${person('s', 'Sam')} :ARG1 (c / customer))`,
    },
  }),
  { statement: 'If the vault opens, Sam notifies the customers.' },
);
assert.deepEqual(unnamed.findings.map(texts), [
  ['Sam does not notify the customers.', 'The vault opens.'],
]);

// A consequence bound to a new participant is new: Priya reviewed and filed,
// so Robin's note follows only with "Robin reviews logs".
const robin = await hypothesisReport(
  await open('guard-new-participant', {
    roles: {
      Audit: [
        'If someone reviews logs, they file a note.',
        'Priya reviews logs.',
        'Priya files a note.',
      ],
    },
    extra: {
      'If someone reviews logs, they file a note.':
        audit['If someone reviews logs, they file a note.'],
      'Priya reviews logs.': `(r / review-01 :ARG0 ${person('p', 'Priya')} :ARG1 (l / log))`,
      'Priya files a note.': `(f / file-01 :ARG0 ${person('p', 'Priya')} :ARG1 (n / note))`,
      'Robin reviews logs.': audit['Robin reviews logs.'],
    },
  }),
  { text: 'Robin reviews logs.', offline: true },
);
assert(
  robin.follows.some(
    (rule) => rule.rule === 'If someone reviews logs, they file a note.' && rule.onlyWith > 0,
  ),
  'Robin filing a note follows only with the supposition',
);

// A level is no identifier: Alex 123 at level 5 and at level 6 is one Alex.
const levels = {
  'Alex with employee ID 123, at level 5, approves the release.':
    '(a / approve-01 :ARG0 (x / person :name (xn / name :op1 "Alex") :mod (i / identifier :value 123) :mod (l / level :value 5)) :ARG1 (r / release-01))',
  'Alex with employee ID 123, at level 6, does not approve the release.':
    '(a / approve-01 :polarity - :ARG0 (x / person :name (xn / name :op1 "Alex") :mod (i / identifier :value 123) :mod (l / level :value 6)) :ARG1 (r / release-01))',
};
const levelled = await aporiaReport(
  await open('guard-levels', { roles: { People: Object.keys(levels) }, extra: levels }),
  { role: 'People' },
);
assert.equal(levelled.findings.length, 1, 'one Alex, two answers: a contradiction');

// Two roles with one name are two placements: their clashes stay apart.
const named = await aporiaReport(
  await open('guard-same-name', {
    roles: [
      ['North', Object.keys(twice)],
      ['North', Object.keys(twice)],
    ],
    extra: twice,
  }),
);
const pairs = (report) =>
  report.findings.filter((finding) => finding.statements.some((item) => item.statement in twice))
    .length;
assert.equal(pairs(named), pairs(two), 'as many as two roles with two names');

// Dialogue keeps clashes apart by statement, not by words.
const voices = await dialogueReport(
  await open('guard-dialogue-roles', {
    roles: { North: Object.keys(twice), South: Object.keys(twice) },
    extra: twice,
    authors: {
      'The nightly backup completes.': 'Dana',
      'The nightly backup does not complete.': 'Eli',
    },
  }),
);
assert(voices.findings.filter((finding) => finding.kind === 'clash').length > 1);

// Alias and aliases are one term.
const alias = await definitionReport(
  await open('guard-alias', {
    roles: { Names: ['An alias is a name.'] },
    extra: { 'An alias is a name.': '(n / name :domain (a / alias))' },
  }),
  { term: 'aliases' },
);
assert.deepEqual(
  alias.genus.map((row) => row.statement),
  ['An alias is a name.'],
);

// Too many type combinations to ask is a bound reached, said in the verdict.
const six = ['Ann', 'Ben', 'Cara', 'Dana', 'Eve', 'Fay'];
const crowd = {
  'Ann, Ben, Cara, Dana, Eve, and Fay approve the release.': `(a / approve-01 :ARG0 (g / and ${six
    .map((name, i) => `:op${i + 1} (p${i} / person :name (n${i} / name :op1 "${name}"))`)
    .join(' ')}) :ARG1 (r / release-01))`,
  ...Object.fromEntries(
    six.map((name, i) => [
      `${name} reports.`,
      `(r / report-01 :ARG0 (c${i} / company :name (m${i} / name :op1 "${name}")))`,
    ]),
  ),
};
const crowdPath = await methodsDemo('guard-variants', {
  roles: { Crowd: Object.keys(crowd) },
  extra: crowd,
});
const crowded = await elenchusReport(await openProject(crowdPath), {
  statement: 'Ann, Ben, Cara, Dana, Eve, and Fay approve the release.',
  offline: true,
});
assert.equal(crowded.limited, true, 'sixty-four combinations: limited');
const crowdText = cli(crowdPath, 'elenchus', '--statement', 'Ann, Ben, Cara').stdout;
assert.match(crowdText, /among (?:what was|the statements) read/u);
assert.match(crowdText, /Limited: a search stopped at its bound/u);

// The CLI: a report's JSON on stdout, a miss on stderr with exit 2, a text
// without a reading exits 1 with the documented keys.
const json = cli(plain, 'aporia', '--json');
assert.equal(json.status, 0);
assert.deepEqual(Object.keys(JSON.parse(json.stdout)).sort(), [
  'findings',
  'limited',
  'revision',
  'rules',
  'statements',
  'unread',
]);
const miss = cli(plain, 'maieutics', '--question', 'Which zebra gallops?');
assert.deepEqual([miss.status, miss.stdout], [2, '']);
assert.match(miss.stderr, /No such saved question: Which zebra gallops\?\nAsk it first/u);
const unreadText = cli(plain, 'elenchus', '--text', 'Zebras gallop at midnight.', '--json');
assert.equal(unreadText.status, 1);
assert.deepEqual(Object.keys(JSON.parse(unreadText.stdout)).sort(), [
  'findings',
  'limited',
  'revision',
  'thesis',
  'unread',
]);

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
// Aporia: Kim's case is one finding (whichever kind holds it), Lee's none.
const puzzle = (await aporiaReport(ledger, { role: 'Audit' })).findings;
assert(!puzzle.some(lee) && puzzle.some(kim), 'aporia: Kim, never Lee');
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

console.log('ok method guards: what the three reviews found stays fixed');
