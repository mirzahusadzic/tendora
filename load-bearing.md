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

## Measurement in this repository

[The research reporting helper](tools/support/load-bearing.mjs) compares supplied
observations and accounts for external checks. A harness performs the interventions,
projects each result onto the declared observable and validates the five checks.
The helper uses `canonical-json-equality-v1`: object key order is ignored; array
order and JSON values are significant. Other comparison rules require a separate
profile.

An `earned` report requires all five recorded checks to pass, with evidence
references tied to the same difference-producing intervention. Missing checks
remain `candidate-only`; stale or unavailable observations remain invalid.
[The offline contract](test/acceptance/load-bearing.mjs) tests this accounting.
Engine answer checking and role attribution follow their own source proofs;
the reporting helper is not an engine gate.

The designation applies to the declared promise, locus and tested domain.

© 2026 Mirza Husadzic. This essay is licensed under
[CC BY 4.0](licenses/CC-BY-4.0.txt). The linked implementation follows the
[code license](LICENSE).
