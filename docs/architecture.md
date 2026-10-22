# Architecture

Tendora develops a corpus through natural-language statements and questions,
organized by roles. A role controls the scope from which a question is checked.
The engine retains sources, intermediate artifacts and dependencies so an answer
or partial contribution can be inspected and revisited as the material changes.

## Acquisition and checking

Text is acquired as an Abstract Meaning Representation (AMR) through eGemma.
The acquired PENMAN graph, model and revision are retained. Local PENMAN
processing normalizes roles while preserving original variable identities.
PropBank supplies lexical inspection data; it does not certify a parser reading.

The [AMR annotation guidelines](https://github.com/amrisi/amr-guidelines/blob/master/amr.md)
were a development reference for AMR notation and interpretation.

The deterministic engine compiles source graphs into hyperedge replacement
grammar (HRG) material, matches questions through a query chart and checks
attributed answers. Conditions, modality, polarity, reference and source
boundaries constrain what can be supported. A question never supplies its own
evidence, and grammar recognition alone is not entailment.

SEMCAT supplies bounded local Smatch++ and global RoSE comparisons with
correspondences and provenance. Similarity and embeddings assist comparison
and navigation; their scores do not by themselves establish an answer.
There is no second generative pass to reinterpret or align the corpus.

## Retained work

The workbench can preserve supported parts alongside unresolved relations
(aporias), including openings at a specific relation or participant. A changed
source can invalidate a dependent part without erasing its history. Saved
questions and partial contributions can be revisited through Development.

Workbench Asks retain a versioned inquiry frame: the question reading when
acquired, intention/purpose, scope, selected case, source identities and source
revisions.
Following an opening creates a distinct receiving frame linked to the originating
recording and opening. The carry records its actor, rationale, changed frame
dimensions and support consequence. An identical acquired question can reuse its
checked reading. A changed graph can produce a candidate correspondence, but graph
mapping or compiled wording does not by itself establish preservation. Scope,
case, source or project changes invalidate earlier support and require a fresh
check. A purpose-only change preserves the earlier assessment when the question
revision and checking context are unchanged; it does not manufacture a new proof.
Version 1 and 2 continuations remain readable without being rewritten as framed
records.

Projects keep their manifest in `project.json`. Compressed, hash-checked blocks
in `material.sqlite` retain authored records, acquisitions, role vectors and
questions, preserving their decoded bytes and references. sqlite-vec stores
128-dimensional float32 vectors for local ranking; its index can be rebuilt
from retained acquisitions. Engine artifacts and recordings are rebuildable;
the demo includes computed answers and evidence for its seventeen questions.
CLI `ask` and the TUI use the same checking engine.

| Location               | Responsibility                                                   |
| ---------------------- | ---------------------------------------------------------------- |
| `src/amr/`             | Graphs, fragments, grammar, correspondences and answer structure |
| `src/engine/`          | Preparation, compilation, checking and retained contributions    |
| `src/models/`          | eGemma clients, PENMAN and SEMCAT transports                     |
| `src/project/`         | Authored records, scope, inquiries and storage                   |
| `src/tui/`, `src/cli/` | Interactive authoring and scriptable checks                      |
| `test/`, `tools/`      | Regressions, fixtures, experiments and PTY capture               |
| `python/semcat/`       | Python adapter and pinned SEMCAT integration                     |
| `vendor/propbank/`     | Pinned lexical resources                                         |

## Present limits

Acquired graphs can misread language; lexical audits and source inspection
help review those readings. Offline replay uses retained wording. Search and
alignment have explicit budgets and report when a limit is reached.

The cooperative frame is a first vertical slice. It does not yet provide a
general hypothetical-premise overlay, branch merging, or neural answer
realization. Those remain proposals rather than engine behavior, as does
[proposing premises at openings](consensual-premises.md).

The payments project demonstrates role-scoped questions about written incident
procedures. Storage and interfaces are evolving with the research prototype.

[Load-bearing as situated meaning](../load-bearing.md) defines the local
counterfactual criterion used by the research measurement helper.
