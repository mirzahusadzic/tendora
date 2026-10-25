# Load-bearing as situated meaning

A semantic relation does not earn the designation by being important, repeated,
well sourced or highly connected. The test is local and counterfactual: at a
declared role, grain, purpose, trajectory, baseline, crossing and receiving
promise, does removing or changing the relation alter the observable that the
promise requires?

Let `I` be the selected semantic relation, `v` the transformation locus, `p` the
receiving promise, `F_v(x; I)` the behavior produced from encounter `x` while
`I` governs that locus, `o_p` the observable required by `p`, and `I'` a
controlled removal or relevant change in the declared intervention set. For a
declared test domain `X`, with the comparison and required direction fixed in
advance:

```text
candidateLB(I, v, p, o_p; X)
  iff exists x in X and I' in Delta_I:
      valid(x, I, I', v, p)
      and o_p(F_v(x; I)) is not equivalent to o_p(F_v(x; I'))
```

A prediction is only a proposed test. Missing, stale or incompatible
observations cannot establish a difference. A candidate becomes earned
load-bearing only when all five external checks pass:

1. the change follows the direction or distinction required by `p`;
2. an irrelevant presentation change preserves the behavior;
3. removing the required semantic-to-operative join exposes an opening rather
   than selecting a hidden fallback;
4. the result is traceable downward to source, selected asset, checked lowering
   and evidence, and upward through the receiving projection to the current
   surface; and
5. the required invariant is materialized in a compatible receiving span,
   field, program, state or projection, with inspectable evidence of that
   materialization.

Importance, repetition, source grounding and graph degree do not earn the hard
hat. They may appear in traceability evidence, but they never decide candidacy.

## In Tendora

| The essay's term        | In Tendora                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------ |
| The relation `I`        | A statement, through its reading's relations                                         |
| The locus `v`           | A check: the engine's answer to a question at a role, with its case                  |
| The promise `p`, `o_p`  | The question, and the answers it gets (their text, and whether they are conditional) |
| The intervention `I'`   | The statement withheld; changing a statement is not intervened                       |
| The test domain `X`     | A statement's own probes (corpus fidelity), or the saved questions                   |
| `valid(x, I, I', v, p)` | The same revision, role and case, and a complete check (never a limited one)         |

**Withholding.** A probe is checked again with statements left out
(`checkProbe` with `withhold`, in `src/engine/cloze.mjs`). When the saved
check's inference is complete, the view without them comes from its stored
proofs (`withheldBase`, in `src/recording/answers.mjs`): a least fixpoint in
which a derived fact holds only through a proof that uses no withheld statement
and whose premises hold. A bounded inference gives no view, and the probe is
checked again without the statements instead; both give the same outcomes,
which `test/recording/withheld.mjs` checks.

**Candidacy, per variable.** `tendora fidelity --withhold` asks each variable a
statement answers again without that statement: _borne alone_ when no other
statement then gives the same answer unconditionally (a candidate), _shared_
when another does. On the demo all 81 answerable variables are borne alone.

**The five checks.** The engine runs none of them as a gate; this is where each
stands:

| Check              | In Tendora                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| Direction          | Withholding only removes; whether the change has the promise's direction is not judged             |
| Presentation       | Measured by rewording a whole battery (the held-out diagnosis), not per relation                   |
| No hidden fallback | Every answer names its statements; withdrawing the one an answer rests on leaves it open           |
| Traceability       | Each answer names its statements and rules; recoil walks down to them and up to what rests on them |
| Materialization    | A check keeps its input, result and provenance, with the revision and the provenance file's digest |

**Retraction.** Withdrawing or editing a statement holds the saved checks that
read it as changed; a fresh check answers without it, and only what rested on
it goes open (the workbench test of paragraph authoring shows both). Recoil up
names what rests on a statement before it changes.

**Reporting.** [The research reporting helper](../tools/support/load-bearing.mjs)
accounts for supplied observations and external checks, comparing with
`canonical-json-equality-v1` (object key order ignored; array order and values
significant). An `earned` report needs all five checks recorded as passed, with
evidence tied to the same difference-producing intervention; otherwise it stays
`candidate-only`, and stale or missing observations stay invalid.
[Its offline contract](../test/acceptance/load-bearing.mjs) tests this
accounting. The helper is not an engine gate.

The designation applies to the declared promise, locus and tested domain.

© 2026 Mirza Husadzic. This essay is licensed under
[CC BY 4.0](../licenses/CC-BY-4.0.txt). The linked implementation follows the
[code license](../LICENSE).
