# The Socratic methods

A check asks one question. A method asks something of the whole corpus: what
would follow if something were said, whether a thesis survives what the
statements commit to, where they cannot hold together, what is missing, which
words do two jobs, how the roles are organized, and where two authors meet. Each
method is a command, and each answers only from the statements and their
readings, like a check. The [methods tour](methods-tour.md) shows every one on
the bundled demo.

## What a method promises

- **It rests on statements.** Every finding names the statements it rests on,
  with their role and author.
- **It does not decide.** What it returns is a question for a person, or a
  proposal that waits for one. An author's answer becomes a statement only when
  it is saved.
- **Finding nothing is a result.** A method that finds nothing says so. It never
  makes up a relation to have something to report.
- **It saves nothing.** No statement, check or case is saved. A new text (a
  supposition, a thesis) is read once and its reading retained, like a
  question's.
- **It says what it could not ask.** Only what holds outright is evidence: an
  answer that holds under a clause ("at night") refutes nothing. A statement
  without a reading is named and never asked, and a search that stopped at its
  bound is said to have; then "nothing" reads "nothing found among what was
  read".

Two of these promises follow David Matta's _Juxtaposition as a Deliberate
Cognitive Method: The Value of Putting Things Together_ (2026,
[doi:10.5281/zenodo.21977249](https://doi.org/10.5281/zenodo.21977249),
CC BY 4.0). A relation is worth more when it can be derived again without the
arrangement that suggested it: every consequence of a supposition says whether
it follows only with it. And a search that may find nothing is honest, since
one that always finds something is ritual rather than inquiry.

## How they work

Every method stands on one move: a reading asked as a yes/no question. The
engine matches it as it matches any question, so statements meet through their
readings, not through their wording. The question can leave statements out (is
an answer borne by this statement alone?), set a statement beside the others
that is never saved (an overlay: what if this were said?) and give cases (one
check's circumstances: what if this held?). Asked over the whole corpus, that
one move supposes, refutes, finds contradictions, tries premises and compares
alternatives.

A named participant is identified by its name. A description that only names
its role ("Morgan, the release manager") is left out of the question, while one
carrying a value ("Alex with employee ID 123") stays, since it tells one Alex
from another. The question is asked under each type the statements give that
name, since a reader's type is a guess: the demo's readings make Morgan a
company in one statement and a person in another.

Like probes and corpus fidelity, the methods read the latest check at the root
role at the project's revision, so one must exist.

## The four families

| Family               | Method                  | Asks                                                       | Command          |
| -------------------- | ----------------------- | ---------------------------------------------------------- | ---------------- |
| Supposing            | Hypothesis              | What would follow if this were said?                       | `suppose`        |
| Opposition           | Elenchus                | Do the statements refute this thesis?                      | `elenchus`       |
|                      | Aporia                  | Where can the statements not hold together?                | `aporia`         |
|                      | Counterexample          | Does this rule or kind hold everywhere the corpus speaks?  | `counterexample` |
| Premises and words   | Maieutics               | What question, answered by an author, would complete this? | `maieutics`      |
|                      | Equivocation            | Is one word doing two jobs?                                | `equivocation`   |
|                      | Definition              | What is X, by what the statements say?                     | `definition`     |
| Structure and voices | Collection and division | Do these statements belong together, or apart?             | `division`       |
|                      | Dilemma                 | Does it follow whichever alternative holds?                | `dilemma`        |
|                      | Analogy                 | Does what holds here hold there?                           | `analogy`        |
|                      | Dialogue                | Where do two authors clash, or commit to the same?         | `dialogue`       |

**Supposing.** `suppose` sets one statement beside the others and reports what
it says (new, or said already), the rules that apply only with it, and every
saved question it would answer, change or bring into conflict.

**Opposition.** `elenchus` refutes a thesis directly, when the statements answer
it the other way, or through a rule, when supposed it makes a rule apply whose
conclusion they deny; each refutation names its commitments, the smallest set
standing. `aporia` searches the corpus for a statement the others deny, a rule
they deny under its own condition, and two rules with opposed conclusions whose
conditions meet. `counterexample` finds where a rule applies and is denied, and
says when a rule never applies: no statement meets its condition.

**Premises and words.** `maieutics` walks an open question back through the
rules that would answer it to the premise nothing brings about, and asks the
rule's author whether it holds, in the rule's own words. `equivocation` names a
predicate read in two senses across the statements, with each sense's PropBank
gloss, and the same words read as two structures. `definition` gives a term's genus, species and siblings from the kind
statements, what is said of it, and asks what nothing says.

**Structure and voices.** `division` finds a role whose statements fall into
groups that share nothing, and statements that lean on another role's (a
misplacement, or a tie between roles). `dilemma` splits a statement of
alternatives and gives each as a case: a conclusion under every one follows
either way. `analogy` pairs statements of one shape and asks whether a rule
that applies with one holds for the other. `dialogue` asks each statement of the
others and names where two authors, as recorded or declared, clash or agree.

## In the workbench

The root role shows the corpus-wide methods, each with its findings or that it
found none: aporia, dilemma, analogy, dialogue, equivocation, and collection and
division. They read every statement in a worker, by themselves up to 300
statements (a larger corpus names the commands instead), as corpus fidelity
does. A statement shows its elenchus, asked of the others, and its
counterexamples; a saved question left open, without a case, shows the
premises maieutics finds. `suppose`, `definition` and `elenchus --text` take
words of their own and are CLI commands.

## Reading a finding

`--json` gives a report with its `findings`, each in one shape, whatever the
method:

```json
{
  "method": "aporia",
  "kind": "joint case",
  "summary": "Two rules with opposed conclusions both apply when their conditions are met.",
  "statements": [{ "statement": "…", "role": "Release Manager", "author": "Claude" }],
  "case": ["a major incident is open", "a payment key leaks"],
  "question": "When a major incident is open and a payment key leaks, both rules apply and oppose: which is meant?"
}
```

`kind` names the finding within its method, and `statements` the commitments
it rests on. A finding that asks something of a person gives `question` (a
refutation, an aporia, a counterexample, a word in two senses, a transfer, a
clash; maieutics adds `ask`, addressed to an author) or `proposal` (a role to
split or join); one that only reports (a support, a conclusion that follows
either way, a shared commitment) gives neither. Each report also gives
`unread`, the statements in scope without a reading, and `limited`, whether a
search stopped at its bound. `suppose` reports in its own shape: what the
supposition says, what follows, and the questions it would change. The text
output says the same, one finding at a time.

## What they cannot do

- **They find what the readings support.** A reading can be wrong or
  inconsistent: on the demo, eGemma reads "payment key" three ways, and a case
  worded one way may not meet a rule worded another. `equivocation` names a
  word read in two senses and two concepts related two ways; a reading with a
  different head altogether (a verb "key" for the noun) it does not catch.
- **A conditional answer's clause is no premise.** An answer that holds "when a
  payment key is exposed" already names its clause, and a case does not
  discharge it; maieutics finds premises behind rules only.
- **Few rules, little to oppose.** A corpus of plain statements gives the
  methods of opposition little to search. The methods of words and structure
  find the most there.
- **An "only if" is tested by elenchus alone.** "Only if the alarm sounds, the
  backup runs" commits to the backup needing the alarm, not to the backup
  running: dialogue leaves such a claim out rather than compare its conclusion.
- **A name told apart by role words alone is one participant.** "Alex, the
  engineer" and "Alex, the manager" are asked as one Alex; give one of them a
  value (an ID) and they are two.
- **Commonness tells nothing.** Collection and division leaves out what nearly
  every statement mentions, quantifiers and measures; a name always counts.
