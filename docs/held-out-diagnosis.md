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

"One confirmation away" means the engine already proposes a source connection
for the question, and confirming that one proposal, on a disposable copy,
gives the expected answer and evidence. The benchmark answers stay
unrepaired; the evaluator reports these trials separately.

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
  for all four answers one confirmation away, and for no other proposal.
  Proposals in scope are shown, and can be confirmed, at the role the
  question was asked at.
- One proposal remains that would give a wrong answer if confirmed:
  "Who had collected the key?" is offered "The freezer van collects booked
  crates". It maps one participant onto a different one and is left for the
  person to reject; the benchmark caps such proposals at their current count.
