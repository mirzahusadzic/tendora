# Proposal: consensual premises at openings

Status: **proposal awaiting a decision; not implemented.** It touches an
existing rule, so it changes nothing until that rule is deliberately amended.

## The gap it addresses

On independently worded questions the engine usually stops at a located
opening: the sources do not connect the question to an answer. Today the only
way forward is for a person to notice what is missing and write it. The frozen
independent-domain benchmark supports 0 of 4 warranted answers this way.

## The loop

```text
located opening
  -> a model proposes one bridging premise in plain language
  -> the person accepts, edits, rejects or asks again
  -> only a saved statement becomes authored material
  -> ordinary acquisition, then the unchanged deterministic check
  -> the opening closes only if the check now supports it
```

The proposal enters through the existing anchored-statement editor, the same
path a person already uses from an opening. The engine and its checking rules
stay as they are.

## Consent guards

- **Every proposal is retained**, including rejected ones and every re-ask,
  bound to the opening and the model, prompt and revision that produced it. A
  "yes" chosen from many attempts stays visible as such.
- **Saving is the only consent.** Silence, closing the editor or a timeout
  means no. Rejecting costs nothing and leaves no mark on the corpus.
- **Authorship stays exact.** A saved statement records that it was proposed
  by the model and accepted (or edited) by the person. Neither can be passed
  off as the other's.
- **The model never saves, edits sources, rephrases the question, aligns
  graphs or answers.** Offline mode makes no proposals.

## What would show it failing

Run on the independent-domain benchmark, predeclared before any proposal is
seen:

1. any false support, at any point: stop;
2. accepted premises that only restate the question's expected answer rather
   than supply domain knowledge, judged by someone other than the acceptor;
3. acceptance rates near 100%, which would suggest rubber-stamping rather
   than judgment;
4. no gain over a person writing premises unaided, measured by edits and time
   to reach support.

## The decision this needs

[AGENTS.md](../AGENTS.md) currently says: "Do not add a second generative pass
for source interpretation, paraphrases or alignment." This proposal leaves
source interpretation and alignment untouched but puts a generative model
inside the authoring loop. Adopting it means adding an exception such as:

> A model may propose a premise at a located opening. It becomes authored
> material only when a person saves it, and every proposal, accepted or not,
> is retained with its provenance.
