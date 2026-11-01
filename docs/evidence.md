# Evidence: what each answer rests on

The payments demo's 31 questions, each answered by two readers and tried by [Gadfly](https://github.com/mirzahusadzic/gadfly). A trial asks again with the material changed, and the verdict is read from the trials by fixed rules. The [README](../README.md#evidence) has the totals.

## The trials

| Trial      | What changes                                       |
| ---------- | -------------------------------------------------- |
| Baseline   | Nothing: the question over the statements in scope |
| Repeat     | Nothing: asked again                               |
| Cited cut  | The statements the answer cites are removed        |
| Random cut | As many other statements are removed, twice        |
| Reordered  | The same statements, in another order              |
| Control    | Statements whose removal must move any reader      |

## The verdicts

| Verdict    | Read from the trials                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| Carried    | The cited cut moved the answer the right way; the repeat, the random cuts and the reordering did not |
| Unresolved | A trial gave no agreed answer, the repeat differed, or a random cut moved it                         |
| Misaligned | The reordering moved it, or the cited cut moved it the wrong way                                     |
| Cooled     | The cited cut left the answer as it was: it did not rest on the cited statements                     |

Two further checks Gadfly can run were not declared in these frames, so every report lists them as open: a bypass trial (the material withheld entirely; the reader should say it cannot answer) and a presentation trial (the material renamed one-to-one; the answer should hold). A verdict here is read under the trials above.

## The readers

| Reader                   | What it is                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Tendora                  | The deterministic engine of this repository's bundle (`dist/`), offline            |
| Gemma 4, temperature 0.7 | gemma-4-26B-A4B-it (QAT q4_0) through eGemma at its default: how steadily it reads |
| Gemma 4, temperature 0   | The same model, near-deterministic: whether a cut moves its answer                 |

## Every question

Each cell is the verdict and the baseline answer ("conditional" is an answer that holds on a condition the statements state; "open" is no answer).

| Question                                                                                                                                   | Tendora                          | Gemma 4, 0.7                     | Gemma 4, 0                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | -------------------------------- | -------------------------------- |
| Are access logs reviewed?                                                                                                                  | carried: conditional             | unresolved: open                 | misaligned: open                 |
| Does Jordan test a backup before restoring it?                                                                                             | carried: Yes                     | unresolved: conditional          | unresolved: another answer       |
| Does Morgan ship a release? _(case: A major incident is open.)_                                                                            | carried: No                      | carried: conditional             | carried: conditional             |
| May Jordan, the database administrator, restore the database from a backup?                                                                | carried: conditional             | unresolved: open                 | unresolved: open                 |
| May Jordan, the database administrator, restore the database from a backup? _(case: The incident commander has approved the restore.)_     | carried: Yes                     | unresolved: open                 | carried: conditional             |
| May Jordan, the database administrator, restore the database from a backup? _(case: The incident commander has not approved the restore.)_ | carried: No                      | carried: conditional             | carried: conditional             |
| What does Sam collects?                                                                                                                    | carried: conditional             | unresolved: another answer       | unresolved: another answer       |
| What does the database administrator keep in the password vault?                                                                           | carried: break-glass credentials | unresolved: break-glass credentials | carried: break-glass credentials |
| What does the on-call engineer check after acknowledging a page?                                                                           | carried: conditional             | unresolved: payment error rate   | unresolved: payment error rate   |
| What does the release manager freeze during a major incident?                                                                              | carried: deployments             | misaligned: deployments          | misaligned: deployments          |
| What does the security engineer report?                                                                                                    | carried: conditional             | unresolved: another answer       | unresolved: open                 |
| What does the support lead post after the incident commander declares a major incident?                                                    | carried: customer updates        | unresolved: another answer       | unresolved: another answer       |
| What Sam collects?                                                                                                                         | carried: conditional             | carried: another answer          | unresolved: another answer       |
| When does the release manager freeze deployments?                                                                                          | carried: major incident          | unresolved: open                 | unresolved: open                 |
| Where does the support lead collect affected customer reports?                                                                             | carried: incident channel        | unresolved: incident channel     | carried: incident channel        |
| Which engineer acknowledges every page within ten minutes?                                                                                 | carried: Alex                    | unresolved: open                 | unresolved: open                 |
| Which engineer acknowledges every page within five minutes?                                                                                | carried: Alex                    | carried: Alex                    | carried: Alex                    |
| Which engineer must rotate a leaked payment key?                                                                                           | carried: conditional             | carried: Priya                   | carried: Priya                   |
| Which key must the security engineer rotate?                                                                                               | carried: conditional             | unresolved: open                 | unresolved: open                 |
| Which manager freezes deployments during a major incident?                                                                                 | carried: conditional             | unresolved: Morgan               | cooled: Morgan                   |
| Who approves the database vendor invoice?                                                                                                  | carried: Maya                    | unresolved: Maya                 | carried: Maya                    |
| Who confirms that payments are healthy?                                                                                                    | carried: conditional             | carried: Morgan, Maya            | carried: Morgan, Maya            |
| Who freezes changes during a major incident?                                                                                               | carried: Morgan                  | unresolved: Morgan, Maya         | misaligned: Morgan, Maya         |
| Who freezes deployments during a major incident, and who approves the database vendor invoice?                                             | carried: Morgan, Maya            | unresolved: another answer       | unresolved: another answer       |
| Who freezes deployments during a major incident? _(all 30 statements)_ | carried: Morgan | cooled: Morgan, Maya     | cooled: Morgan, Maya |
| Who freezes deployments during a major incident? _(the release manager's 6 statements)_ | carried: Morgan | cooled: Morgan, Maya | cooled: Morgan, Maya |
| Who may fail over the primary database?                                                                                                    | carried: conditional             | unresolved: Jordan               | carried: Jordan                  |
| Who notifies the customers? _(case: A certificate expires.)_                                                                               | carried: Sam                     | carried: Sam                     | carried: Sam                     |
| Who renews the certificate? _(case: A certificate expires.)_                                                                               | carried: Priya                   | carried: Priya                   | carried: Priya                   |
| Who reports a leaked payment key to the incident commander?                                                                                | carried: Priya                   | carried: Priya                   | carried: Priya                   |
| Who should rotate a leaked payment key?                                                                                                    | carried: conditional             | carried: Priya                   | carried: Priya                   |
