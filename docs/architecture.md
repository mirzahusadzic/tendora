# Architecture

A project is statements organized by roles. A question is checked against the
statements in its scope (a role and its children), by a deterministic engine
that retains its sources, intermediate artifacts and dependencies, so an answer
can be inspected and revisited as the statements change.

## Reading

eGemma reads text into an Abstract Meaning Representation (AMR); the PENMAN
graph, the model and its revision are retained, so a text is read once. Local
PENMAN processing normalizes roles and keeps the original variables. PropBank
supplies lexical checks (an unlisted sense, a number or time the text does not
give, a dropped negation); it does not certify a reading. A reading's `:wiki`
link is the parser's guess at a real-world referent and is not used in
reasoning; names keep their parts. The
[AMR guidelines](https://github.com/amrisi/amr-guidelines/blob/master/amr.md)
were the reference for notation.

## Checking

The engine compiles the statements' readings into hyperedge replacement grammar
(HRG) material, matches the question through a query chart and checks
attributed answers. A question never supplies its own evidence, and grammar
recognition alone is not entailment.

- **Boundaries:** conditions, modality, polarity, reference and scope constrain
  what holds. An answer that holds under a source's clause is _conditional_ and
  names the clause. A participant the question names is identified; what a
  source adds about it qualifies nothing.
- **Cases:** a case states one check's circumstances. Rules apply to it and an
  answer may rest on it, which the answer says; it never becomes a statement.
- **Rules from statements:** a condition ("If a certificate expires, …") applies
  to whatever meets it, and rules chain; a negated conclusion answers No under
  its condition. A kind statement ("A deployment is a change.") extends every
  node its subject fits, one way. Identity across statements comes from authored
  language, never from a shared word.
- **Read in, and said:** "must" answers "should"; one modal word read two ways
  is read as in the source; a question's unresolved pronoun reads as the one
  entity it names. Each answer read that way says so.
- **Proposals:** where the question and a source share words but were read
  differently, or a source denies what a yes/no question asks, the connection
  is proposed, never read in. It answers once a person confirms it.
- **Open:** an open answer says why and names the closest statements; several
  answers leave it ambiguous. Search and alignment have budgets and report
  when one is reached (_limited_, never open). A statement or case in scope
  without a usable reading could deny an answer, so the check is incomplete
  (_needs-reading_), never supported.

SEMCAT supplies bounded local Smatch++ and RoSE comparisons; similarity and
embeddings help compare and navigate, and never establish an answer. There is no
second generative pass.

## Inspecting

Read-only views over the saved checks at the project's revision (CLI `recoil`,
`tensions`, `probe`; the workbench's question, statement and role views):

| View          | Shows                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recoil        | From a statement, role or question: what it rests on (down), what rests on it (up), what shares its place (sideways); the frontier is what the walk cannot see, never absence |
| Tension lines | Which role branches a question's answer draws on: resolved by one composed answer, gathered by separate ones, or open                                                         |
| Probes        | Each participant of a statement asked back from its own reading, and its truth                                                                                                |

## Attribution

| Record                 | `actor`                                                     | `via`                         |
| ---------------------- | ----------------------------------------------------------- | ----------------------------- |
| A statement            | who wrote or last edited it; `unrecorded` before recording  | `editor`, `library`           |
| A confirmed connection | who confirmed it                                            | `editor`, `library`           |
| A check (engine run)   | the workbench's actor, the CLI's `--actor`, or `unrecorded` | `workbench`, `cli`, `library` |
| A case                 | the check's                                                 | the check's                   |

A project may also declare authorship in `provenance.json` beside its manifest,
for statements written elsewhere or proposed by a model. A check keeps, for
every statement its answer rests on, the recorded author, then what
`provenance.json` adds, with the project id, the revision digest and the digest
of the `provenance.json` it read. An exported answer (`--json`, a recording)
carries that; a later edit changes only later checks. An actor is a label, not
a verified identity.

## Retained work

Supported parts are kept beside unresolved relations (aporias), at a relation
or a participant. A changed source invalidates what depends on it without
erasing its history. An ask keeps a versioned frame (reading, purpose, scope,
case, source revisions); following an opening creates a linked frame that
records who carried it and why. Scope, case, source or project changes require
a fresh check; a purpose-only change keeps the assessment.

`project.json` is the manifest. `material.sqlite` holds compressed,
hash-checked blocks: authored records, readings, role vectors and questions,
their decoded bytes and references preserved. sqlite-vec stores 128-dimension
vectors for ranking, rebuildable from the readings. Engine artifacts and
recordings are rebuildable; the demo bundles its 36 answers with their
evidence. Storage inside a project (its stores, leases and directories) is
refused when it is a symbolic link; the project directory may be one. A stored
block, run or artifact decodes within 256 MiB, before its hash is checked.

| Location               | Responsibility                                                    |
| ---------------------- | ----------------------------------------------------------------- |
| `src/amr/`             | Graphs, fragments, grammar, correspondences and answer structure  |
| `src/engine/`          | Preparation, compilation, checking, cloze probes and explanations |
| `src/models/`          | eGemma clients, PENMAN and SEMCAT transports                      |
| `src/project/`         | Authored records, scope, inquiries, inspection and storage        |
| `src/tui/`, `src/cli/` | Interactive authoring and scriptable checks                       |
| `test/`, `tools/`      | Regressions, fixtures, demo tools and PTY capture                 |
| `python/semcat/`       | Python adapter and pinned SEMCAT integration                      |
| `vendor/propbank/`     | Pinned lexical resources                                          |
| `bench/lean-core/`     | The trim benchmark (JS, Swift, Metal); not part of the engine     |

## Present limits

Readings can be wrong; lexical checks and source inspection help review them.
Answers rest on shared vocabulary: a question worded differently from its
sources usually stays open or becomes a proposal. Offline replay uses retained
wording. The cooperative frame is a first slice: no hypothetical-premise
overlay, branch merging or neural answer realization; those remain proposals,
as does [proposing premises at openings](consensual-premises.md).
[Load-bearing as situated meaning](../load-bearing.md) defines the
counterfactual criterion used by the research measurement helper.
