# The methods on the demo

Every [Socratic method](methods.md) on the bundled demo, Payments On-Call: what
each command prints, how to read it, and what it asks of a person. The demo
replays offline, and every example runs as written.

```sh
npm run demo -- --reset                              # the demo, in .proj/payments-demo
```

Five of its thirty statements were written for the methods, and one story runs
through them, a leaked payment key:

- "If a payment key leaks, Morgan, the release manager, ships a release." It
  meets the freeze rule, "If a major incident is open, Morgan … does not ship a
  release."
- "If a payment key leaks, Priya, the security engineer, renews the
  certificate." A second way into the certificate chain, where Priya's renewal
  leads Sam to notify the customers.
- "Either a certificate expires or a payment key leaks."
- "If Priya reviews access logs, she files an audit note." Alex, the on-call
  engineer, reviews access logs too.
- "On Friday payment failures lasted more than ten minutes, and Maya, the
  incident commander, did not declare a major incident." Maya's own rule says
  she declares one when failures last that long.

## 1. Supposing

### Hypothesis: what would follow

```
$ npx tendora suppose --project .proj/payments-demo --offline \
    --text "A major incident is open, and a payment key leaks."
Supposing “A major incident is open, and a payment key leaks.” at Incident Commander; nothing is saved.
…
What follows (2 rules)
  only with it: “If a payment key leaks, Morgan, the release manager, ships a release.” [Release Manager]
  only with it: “If a major incident is open, Morgan, the release manager, does not ship a release.” [Release Manager]
…
  conflict: Does Morgan ship a release? (case: A major incident is open.)  No → conflict: …
  34 unchanged
```

The supposition stands beside the statements and is never saved. Two rules
apply only with it, and they disagree: one ships a release, the other forbids
one. The saved question "Does Morgan ship a release?", No under a major
incident alone, would be answered both ways. Supposing finds the tension; the
next three methods take it apart.

## 2. Opposition

### Elenchus: is the thesis refuted?

```
$ npx tendora elenchus --project .proj/payments-demo --offline \
    --text "If a major incident is open, Morgan ships a release."
Elenchus of “If a major incident is open, Morgan ships a release.”: refuted.

Refuted directly, by 1 statement:
  “If a major incident is open, Morgan, the release manager, does not ship a release.” [Release Manager] (Claude)
```

Under its own condition, the statements answer the thesis the other way: one
statement refutes it, named with its role and author. A thesis can also fall
through a rule it makes apply:

```
$ npx tendora elenchus --project .proj/payments-demo --offline \
    --text "A major incident is open, and Morgan ships a release."
Elenchus of “A major incident is open, and Morgan ships a release.”: refuted.

Refuted through “If a major incident is open, Morgan, the release manager, does not ship a release.” [Release Manager], by 1 statement:
…
```

Supposed, its first half makes the freeze rule apply, and the rule denies its
second half. A statement is asked of the others:

```
$ npx tendora elenchus --project .proj/payments-demo --offline \
    --statement "If a payment key leaks, Morgan"
Elenchus of “If a payment key leaks, Morgan, the release manager, ships a release.” [Release Manager]: open: nothing in the statements refutes or supports it.
```

Open is a result. Under its own condition (a key leaks) nothing opposes the key
rule: the freeze rule needs a major incident as well. Where both conditions
meet is aporia's to find.

### Aporia: where the statements cannot hold together

```
$ npx tendora aporia --project .proj/payments-demo --offline
Aporia over 30 statements (7 rules): 2 places where they cannot hold together.

in its case: When payment failures last more than ten minutes, both cannot hold: which is meant?
  “Maya, the incident commander, declares a major incident when payment failures last more than ten minutes.” [Incident Commander] (unrecorded)
  “On Friday payment failures lasted more than ten minutes, and Maya, the incident commander, did not declare a major incident.” [Incident Commander] (Claude)

joint case: When a major incident is open and a payment key leaks, both rules apply and oppose: which is meant?
  “If a major incident is open, Morgan, the release manager, does not ship a release.” [Release Manager] (Claude)
  “If a payment key leaks, Morgan, the release manager, ships a release.” [Release Manager] (Claude)
```

Two places, each with both sides and a question for their authors. Maya's rule
is denied in its own case: Friday's failures met it, and she did not declare.
The two release rules each hold alone, and oppose when a key leaks during a
major incident. Asked as a check, that case is a conflict (the demo saves it:
"Does Morgan ship a release?" with "A major incident is open, and a payment key
leaks."). Which rule wins is a decision for the release manager and the
security engineer, written as a statement, not a judgment the engine makes.

### Counterexample: does the rule hold where it applies?

```
$ npx tendora counterexample --project .proj/payments-demo --offline \
    --statement "Maya, the incident commander, declares"
Counterexamples to “Maya, the incident commander, declares a major incident when payment failures last more than ten minutes.” [Incident Commander]
It applies 1 time.

The statements meet its condition (payment failures last more than ten minutes) and answer its conclusion the other way.
  “On Friday payment failures lasted more than ten minutes, and Maya, the incident commander, did not declare a major incident.” [Incident Commander] (Claude)
```

A counterexample is a case where the rule applies and the statements deny its
conclusion. A rule that never applies has none, and says why:

```
$ npx tendora counterexample --project .proj/payments-demo --offline \
    --statement "If a certificate expires"
Counterexamples to “If a certificate expires, Priya, the security engineer, renews the certificate.” [Security Engineer]
It never applies: nothing the statements say meets its condition (a certificate expires).
```

No statement says a certificate expires, so the rule has not been tested:
that it holds is not shown.

## 3. Premises and words

### Maieutics: what an author could complete

```
$ npx tendora maieutics --project .proj/payments-demo --offline \
    --question "Who notifies the customers?"
Maieutics over 1 open or conditional question: 3 questions for authors.

“Who notifies the customers?” (open)
  missing premise: a certificate expires (then: Sam)
    ask Claude: Is it so that a certificate expires?
    through “If a certificate expires, Priya, the security engineer, renews the certificate.” [Security Engineer]
    through “If Priya renews the certificate, Sam, the support lead, notifies the customers.” [Support Lead]
  missing premise: a payment key leaks (then: Sam)
    ask Claude: Is it so that a payment key leaks?
…
  missing premise: Priya renews the certificate (then: Sam)
…
```

The question stays open because the rules that would answer it hang on a
condition no statement gives. Maieutics walks back through them to the
premises nothing brings about, tries each as the question's case, and asks the
rule's author, in the rule's own words: the deepest first. Both deepest premises
are the alternatives of the dilemma below. Without its answer, the question
stays open; with it, the answer is Sam, resting on what the author said.

### Equivocation: one word, two senses

```
$ npx tendora equivocation --project .proj/payments-demo --offline
Equivocation over 58 predicate lemmas: 1 word doing more than one job.

“restore” is read in 2 senses.
  restore-01 (give back):
    “Jordan, the database administrator, restores a backup only after the incident commander approves the restore.” [Database Administrator]
  restore-02 (make like new, restore to previous state):
    “Jordan, the database administrator, tests a backup before restoring it.” [Database Administrator]
  Is “restore” one meaning here, or 2? If one, reword so they read alike.
```

Jordan restores a backup in both statements, and they are read in two PropBank
senses. A question worded with one sense does not meet a statement read in the
other. If both mean the same, a rewording reads them alike; if not, the two
meanings are now explicit.

### Definition: what a term is

```
$ npx tendora definition --project .proj/payments-demo --offline --term change
Definition of “change”, by what the statements say

Genus: what it is said to be
  nothing

Species: what is said to be one
  deploy-01: “A deployment is a change.” [Release Manager]

Nothing says what kind of thing a change is. What is a change?
```

A deployment is said to be a change, so "change" has a species but no genus.
`--term deployment` gives the other side: its genus, and what is said of a
deployment (Morgan freezes them during a major incident). With siblings (other
kinds of the same genus), it adds what tells the term from each.

## 4. Structure and voices

### Collection and division: together, or apart?

```
$ npx tendora division --project .proj/payments-demo --offline
Collection and division over 30 statements in 6 roles: 1 proposal.

collection: Do they say one thing from two roles (the tie between Release Manager and Incident Commander), or does one belong with the other?
  shares: confirm, healthy, close
  “Morgan, the release manager, confirms that payments are healthy before the incident commander closes a major incident.” [Release Manager]
  “Maya, the incident commander, must close a major incident after the release manager confirms that payments are healthy.” [Incident Commander]
```

The release manager confirms before the incident commander closes, and the
incident commander closes after the release manager confirms: each statement
shares more with the other than with its own role. They may say one
coordination from two sides, which ties the roles, or one belongs with the
other. No role's statements fall apart into unconnected groups, so nothing is
proposed for division.

### Dilemma: either way

```
$ npx tendora dilemma --project .proj/payments-demo --offline
Dilemma over 1 statement with alternatives: 2 conclusions.

either way: Whichever holds (a certificate expires; a payment key leaks), Priya, the security engineer, renews the certificate.
…
either way: Whichever holds (a certificate expires; a payment key leaks), Sam, the support lead, notifies the customers.
…
```

"Either a certificate expires or a payment key leaks" does not say which. Each
alternative is given as a case: both lead into the certificate chain, so Priya
renews the certificate and Sam notifies the customers whichever holds. A
conclusion that followed under one alternative only would come with a question
instead: which is it?

### Analogy: does it hold there too?

```
$ npx tendora analogy --project .proj/payments-demo --offline
Analogy over 10 pairs of statements of one shape: 1 proposed transfer.

Does “If Priya reviews access logs, she files an audit note.” hold for Alex as for Priya?
…
```

Priya and Alex both review access logs, in statements of one shape. The
audit-note rule names Priya, so it applies with hers and not with his. The
method asks whether it should; it never applies the rule to Alex itself.

### Dialogue: where authors meet

```
$ npx tendora dialogue --project .proj/payments-demo --offline
Dialogue between 2 authors (unrecorded, Claude): 1 clash, 0 shared commitments.

clash: an unrecorded author and Claude answer it the other way: “Maya, the incident commander, declares a major incident when payment failures last more than ten minutes.”
  An unrecorded author and Claude disagree here: which is meant?
…
```

Maya's rule predates recorded authorship; Friday's statement was written by
Claude. Asked of each other, they disagree. With authors declared in
`provenance.json`, the clashes and the shared commitments come by person.

## What the findings feed

Each finding is a place to act, by a person. An aporia or a counterexample asks
for a decision written as a statement; a missing premise asks an author a
question; an equivocation asks for a rewording; a collection or a division
proposes a change to the role tree; an analogy asks whether a rule should
reach further. After the change, the methods run again, and the checks show
what it did.
