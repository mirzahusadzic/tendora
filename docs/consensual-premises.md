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
  -> the premise is read, and its reading and consequence are shown
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

## First test (2026-10-22)

A person-written premise, on a disposable copy of the independent-domain
project, with the frozen source and question readings unchanged:

- "The archive keeps manuscripts in a vault if it stores them in that vault."
  made "Where does the archive keep manuscripts?" supported, answering
  "climate-controlled vault" with both the source and the premise as
  evidence. False support stayed at 0 and the unknown stayed open.
- The premise has to be read correctly. Of about ten natural wordings, one
  parsed into the needed shape. The others dropped the shared location from
  the conclusion, used `have-condition-91` (which the engine does not yet read
  as a rule), failed to decode, or read "curator" as `curmudgeon`.

So the loop needs one more step before saving: show the person how their
premise was read and what it would let the engine conclude.

## The decision this needs

[The agent guide](../AGENTS.md) currently says: "Do not add a second generative pass
for source interpretation, paraphrases or alignment." This proposal leaves
source interpretation and alignment untouched but puts a generative model
inside the authoring loop. Adopting it means adding an exception such as:

> A model may propose a premise at a located opening. It becomes authored
> material only when a person saves it, and every proposal, accepted or not,
> is retained with its provenance.
