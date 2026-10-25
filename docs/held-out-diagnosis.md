# Where held-out answers are lost

Diagnosis of the 18 warranted answers in the held-out benchmarks
(`node test/acceptance/independent-domain.mjs`), as of 2026-10-23. Each
question's retained reading was compared with the readings of its expected
evidence, offline and with the frozen acquisitions unchanged. After this
diagnosis the benchmarks serve as development sets; their behaviour is
recorded in `test/support/development-snapshot.json`.

| Where it is lost                                                      | Questions | One confirmation away |
| --------------------------------------------------------------------- | --------- | --------------------- |
| The same words are read differently in the question and the source    | 5         | 4                     |
| Different words for the same meaning                                  | 3         | 0                     |
| The question's own form: "should", "if …"                             | 2         | 0                     |
| A compound question with a part no source reaches                     | 1         | 0                     |
| Case reasoning: rules applied to circumstances, codes, numbers, times | 7         | 0                     |

For the four answers in the first group the engine proposes the right source
connection, and confirming it gives the expected answer. From 2026-10-24 they
were answered without a person; since the 2026-10-25 review they are proposals
again (see below). The evaluator confirms every proposal on a disposable copy
and reports those trials separately.

## The groups

- **Same words, different readings.** "Crates scheduled for freezing" is
  read as `freeze-01 :ARG1-of schedule-01` in the question and as
  `schedule-01 :ARG3 freeze-01` in the source. "Intake registrar" is read with
  `admit-02` once and `intake` once. "Damaged bindings" is a
  `thing :ARG3-of bind-01` in the question and a `binding` in the source.
- **Different words.** "Keep" and "store", and "makes a catalog" for
  "catalogs". These need a premise or a confirmed wording.
- **Question form.** "Whom should the custodian ask …" adds `recommend-01`,
  which no source asserts. "If the custodian follows the procedure, …" adds
  a condition the sources never state.
- **Compound parts.** "Who may authorize use of the drying room, and who
  keeps its key?" reads both "who" as one participant and "its key" as a
  possession, while the source says the key _to_ the room.
- **Case reasoning.** All seven seed-packing answers need rules applied to
  the question's circumstances, often with arithmetic (42 kilograms less a
  2-kilogram reserve) or clock times.

## Reading errors seen along the way

These are acquisition errors, retained as acquired. The vocabulary check now
flags a number or clock time the text does not give, so the first two are shown
for review:

- "four in the afternoon" read as `14:00`, and "six in the evening" as `16:00`;
- "sixty-four percent" read as `60.4`;
- "8.0 percent or less" read once as `at-least` 8.0, the opposite bound;
- "curator" read as `curmudgeon`, and "manuscripts" as `document`;
- lot and order codes read as named entities: "Aster-17" as the spaceship
  "Ariane 4", "Reed-26" as a school.

## What changed with this diagnosis

- Proposals and answers name an abstract participant by the word its source
  used, when the vocabulary check attests it: "collections conservator"
  rather than "person".
- A proposal is no longer offered when the source describes the participant
  by a different action in the same role. The intake registrar is not
  answered by what the collections conservator keeps.
- When a proposal's source shares the question's words but was read
  differently, the gap and the confirmation say so: "A source says “crates
  scheduled for freezing” too, but each was read differently." This holds
  for the four answers that were one confirmation away, and for no other proposal.
  Proposals in scope are shown, and can be confirmed, at the role the
  question was asked at.
- Questions with "should" follow three rules. A requirement ("must") answers
  "should"; the answer says it was read that way. A statement of what is done,
  or of what may be done, does not answer "should" or "must", and the gap says
  so. A confirmed wording still cannot cross modality; the person adds a
  statement instead. Neither development question with "should" changes, as
  both also need other capabilities (a case reference, different words, a
  numeric comparison).
- The engine repairs one kind of reading error itself, and records how: a
  number or clock time the text gives is used as the text gives it
  ("sixty-four percent" read as 60.4 is used as 64; "four in the afternoon"
  read as 14:00 is used as 16:00). The acquisition stays as read; the
  statement shows "Repaired" and why. A number the vocabulary check cannot
  read whole ("hundreds of", a value it does not parse) is neither flagged
  nor repaired.
- A question that uses its source's own words but was read differently is
  one confirmation away, not answered. From 2026-10-24 to 2026-10-25 the
  engine read such a question as in the source without a person, and later
  also read one word's forms as one (`roll-back-01` as `rollback`). The
  2026-10-25 review found both rewrite the question's meaning before it is
  checked: shared words bound a named participant in another role ("Who may
  reject a proposal of Ana?" answered "Ana", the one who rejects), and a
  word's senses were merged (`break-02`, "break into", read as `break-01`).
  Both are now proposals the person confirms; the confirmation says the
  question and its source share the words. A proposal that would answer with
  a participant the question itself names, by its concept or its name, is
  not offered. Shared words are lexical evidence, and they do not establish
  that the question asks what the source says.
- Role errors are not repaired. An action in a role PropBank describes as an
  agent looked like a signal, but both such cases in 294 stored readings
  were correct readings.
- One proposal remains that would give a wrong answer if confirmed:
  "Who had collected the key?" is offered "The freezer van collects booked
  crates". It maps one participant onto a different one and is left for the
  person to reject; the benchmark caps such proposals at their current count.

## Blind requestioning (2026-10-23)

Muse Spark 1.3 Contributor reworded the 25 questions from the questions alone,
with no tools or files (its event log shows only its reply). Of 50 rewordings,
four were rejected before any engine run because they asked something else:
Muse and Claude each checked every pair independently, and a rewording was
kept only when neither found a change in meaning. The run, the review and both
checks are in `test/support/requestioning/`.

On the 46 accepted rewordings the engine supports 1 of 34 warranted answers,
keeps all 9 unknowns open, supports nothing wrong, and proposes the right
connection for 5 more. On the original wording it supports 0 of 18 and
proposes the right connection for 4. Most of the shared-wording proposals
depend on the question reusing its source's words, as expected; one rewording
("What is stored in the intake cabinet by the intake registrar?") is answered
where the original was not. One answer is
right but underspecified: "crates", depending on "crates scheduled for
freezing", where the question asks which crates.
