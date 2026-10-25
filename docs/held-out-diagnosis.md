# Where held-out answers are lost

Three held-out domains, two of them blind with a sealed answer key, tested
questions worded independently of the statements. Each question's retained
reading was compared with the readings of its expected evidence, offline, as of
2026-10-23. The domains are development sets since; their behaviour is pinned
in `test/support/development-snapshot.json`
(`node test/acceptance/independent-domain.mjs`).

| Questions                                          | Answered | One confirmation away | Unknowns kept open | Wrong |
| -------------------------------------------------- | -------- | --------------------- | ------------------ | ----- |
| Original wording: 18 warranted, 5 unknown          | 0 of 18  | 4                     | 5 of 5             | 0     |
| Reworded blind: 34 warranted, 9 unknown, 3 partial | 1 of 34  | 5                     | 9 of 9             | 0     |

A partial question is compound with only one part supported ("Who books the
freezer van, and who pays the carrier's invoice?"). The 3 are left to review:
they count in neither the answered nor the unknown columns, nor in the
confirmation trials.

## Where the 18 are lost

| Where                                                                 | Questions | One confirmation away |
| --------------------------------------------------------------------- | --------- | --------------------- |
| The same words read differently in the question and the source        | 5         | 4                     |
| Different words for the same meaning                                  | 3         | 0                     |
| The question's own form: "should", "if …"                             | 2         | 0                     |
| A compound question with a part no source reaches                     | 1         | 0                     |
| Case reasoning: rules applied to circumstances, codes, numbers, times | 7         | 0                     |

- **Same words, different readings:** "crates scheduled for freezing" is
  `freeze-01 :ARG1-of schedule-01` in the question and
  `schedule-01 :ARG3 freeze-01` in the source.
- **Different words:** "keep" and "store"; "makes a catalog" and "catalogs".
  They need a premise or a confirmed wording.
- **Question form:** "Whom should the custodian ask …" adds `recommend-01`,
  which no source asserts; "If the custodian follows the procedure, …" adds a
  condition no source states.
- **Compound parts:** "Who may authorize use of the drying room, and who keeps
  its key?" reads both "who" as one participant.
- **Case reasoning:** the seven seed-packing answers apply rules to the
  question's circumstances, often with arithmetic (42 kilograms less a
  2-kilogram reserve) or clock times.

## What the engine does about them

| Situation                                                     | What the engine does                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A question shares a source's words but was read differently   | Proposes the connection, one confirmation away, and says so; never reads it in by itself      |
| A proposal would answer with a participant the question names | Does not offer it                                                                             |
| The source gives that participant a different action          | Does not offer it                                                                             |
| An answer is an abstract participant ("person")               | Names it by the source's word when the vocabulary check attests it: "collections conservator" |
| "Should"                                                      | "Must" answers it, and says so; what is done or may be done does not                          |
| A number or time read differently from the text               | Uses it as the text gives it, marked _Repaired_ with why; the reading stays as acquired       |
| A participant read in an unusual role                         | Leaves it: both such readings PropBank flagged, among 294, were correct                       |

One proposal would be wrong if confirmed: "Who had collected the key?" is
offered "The freezer van collects booked crates". It is left for the person to
reject, and the benchmark caps such proposals at their count.

## Reading errors seen

Kept as acquired; the vocabulary check flags the first two, and the engine
repairs them as above.

- "four in the afternoon" read as `14:00`, "six in the evening" as `16:00`
- "sixty-four percent" read as `60.4`
- "8.0 percent or less" read once as `at-least` 8.0
- "curator" read as `curmudgeon`, "manuscripts" as `document`
- lot codes read as names: "Aster-17" as the spaceship "Ariane 4"

## Blind rewording

Muse Spark 1.3 Contributor reworded the 25 questions from the questions alone,
with no tools or files. Of 50 rewordings, four asked something else and were
dropped: Muse and Claude each checked every pair, and a rewording stayed only
when neither found a change in meaning. The run, the review and both checks are
in `test/support/requestioning/`. One rewording is answered where its original
was not; one answer is right but underspecified ("crates", where the question
asks which crates).
