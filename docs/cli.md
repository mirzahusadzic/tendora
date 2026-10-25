# CLI

`tendora` checks questions and inspects saved checks from a terminal or a
script. The workbench (`npm run workbench`) is where statements are written;
both use the same engine.

```sh
npx tendora --help                 # in a checkout; npm link installs it on PATH
npm run --silent engine -- --help  # the same CLI through npm
```

Every command but `backends` takes `--project <directory>`; all take `--json`
and `-h, --help`, and each help ends with an example on the bundled demo.

## Commands

| Command     | Does                                                                   | Key options                                         |
| ----------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| `ask`       | Checks a question against the statements in scope                      | `--question`, `--scope`, `--case-text`, `--offline` |
| `runs`      | Lists saved checks                                                     | `--explain`                                         |
| `show`      | Reads one saved check, without checking again                          | `--run`                                             |
| `recoil`    | What a statement, role or question rests on, what rests on it          | `--statement` \| `--role` \| `--question`           |
| `tensions`  | Juxtaposition: where questions bring the role tree's branches together | `--grain`                                           |
| `probe`     | Asks statements back from their own readings                           | `--statement` \| `--role`                           |
| `fidelity`  | Corpus fidelity: what the statements answer, what questions rest on    | `--withhold`                                        |
| `init`      | Creates an empty project where there is no project or its storage      | `--name`, `--root`                                  |
| `delete`    | Removes saved checks; authored statements stay                         | `--run` \| `--all`, `--dry-run`, `--yes`            |
| `storage`   | Reports storage use                                                    |                                                     |
| `compact`   | Compacts storage and rebuildable caches                                |                                                     |
| `knowledge` | Imports authored engine knowledge (advanced)                           | `--file`                                            |
| `backends`  | Lists where the trim can run on this machine (no project)              |                                                     |

`run` is an alias for `ask`, `juxtaposition` for `tensions`. `--question -` reads the question from standard
input.

## ask

```sh
npx tendora ask --project .proj/payments-demo \
  --question "Who notifies the customers?" --case-text "A certificate expires." --offline
```

```
supported: Who notifies the customers? (case: A certificate expires.)
Answer: Sam
  rests on the case and 2 statements
Saved as 0fee2666 in 0.09 s.
```

The first line is the status and the question: `supported`, `conditional` (it
holds under a clause the answer names), `open`, `ambiguous`, `conflict`,
`limited`, `needs-reading` (a statement in scope has no reading, so the answer
may change) or a failure (`needs-amr`, `failed`). Then each answer and what it
rests on; an open check says why, what is one confirmation away (confirmed in
the workbench, Development, `d`) and the closest statements; a check missing a
reading says which. The last line names the saved check: its first 8
characters serve wherever a check is named (`show`, `delete`). `--explain`
adds sources, rules, evidence, readings and vocabulary findings, and prints
each stage of the check as it runs.

`--json` writes the full result with the provenance the check kept: the
project, the revision checked, the digest of the `provenance.json` it read
(`declaredDigest`) and who wrote each statement the answer rests on. `show
--json` gives the same; a later `provenance.json` changes only later checks. A
check saved before checks kept provenance has it read at export, marked
`computedAtExport`.

`--scope` and `--case` take a role label, a `/Root/Child` path or a placement
ID. `--case-text` states the circumstances of this check: rules apply to it and
an answer may rest on it, saying so ("rests on the case and 2 statements", or
"from the case alone"); it never becomes a statement, and provenance names it
as the case, with whoever made the check.
Without `--offline`, text without a retained reading is sent to eGemma.
`--actor` labels the check; without it the check records `unrecorded`, and
every CLI check records `via: cli`.

## Inspecting saved checks

`show` reads one saved check and `runs` lists them; each says when the
statements changed since a check (`statementsChanged` in JSON). `recoil`,
`tensions`, `probe` and `fidelity` read the saved checks at the project's current revision.
None of them checks again or saves anything.

```sh
npx tendora recoil --project .proj/payments-demo \
  --question "Who notifies the customers?" --case-text "A certificate expires."
npx tendora recoil --project .proj/payments-demo --statement "If a certificate expires"
npx tendora tensions --project .proj/payments-demo
npx tendora probe --project .proj/payments-demo --role "Security Engineer"
npx tendora fidelity --project .proj/payments-demo
```

- **recoil**: _down_ is what the locus rests on (statements, rules, the case,
  the roles they are placed at), _up_ what rests on it (questions, directly or
  through a rule), _sideways_ what shares its place (statements carried with
  it, or questions resting on the same statements). The _frontier_ is what the
  walk cannot see (a check made against earlier statements, a released check, a
  question never checked); it is never absence. A question is the saved one
  asked at `--scope` (the root by default) with its `--case-text`.
- **tensions** (juxtaposition): a line between two branches is _resolved_ when one answer
  composes statements from both, _gathered_ when each branch gives its own
  answer, _open_ when only parts reach one of them. `--grain` is the branch
  depth (1: the roles under the root). An open line is a place to ask or to
  author.
- **probe**: each participant of a statement's relation is left blank and
  asked back, then its truth. _Recovered_: the statement answers its own blank;
  _open_: the engine cannot use the reading even for its own content. Probes
  read the latest check at the root role, so one must exist.
- **fidelity**: every statement's probes at once, each variable classed: _own_,
  _shared_ or _carried_ (answerable), _silent_ (its condition not given, or a
  necessary condition), or to review (_possible_, _otherwise_, _owed_,
  _conflict_); then every checked question: answered by one statement,
  composed, conditional, possible, a composition met, or open. `--withhold`
  asks each answerable variable again without its statement: borne alone, or
  shared.

## Trim backends

Each inference round trims its facts to those some rule can still use before
it joins; the answers are the same on every backend.

```sh
npx tendora backends
npx tendora ask --project .proj/payments-demo --offline --backend auto \
  --question "Who notifies the customers?" --case-text "A certificate expires."
```

| Backend | Runs                                                           | Needs                               |
| ------- | -------------------------------------------------------------- | ----------------------------------- |
| `js`    | In the engine's process; the default                           | nothing                             |
| `swift` | A native program on every CPU thread                           | macOS and the Swift toolchain       |
| `metal` | The same program on the GPU                                    | that, and an Apple GPU with Metal 4 |
| `auto`  | `js` below 250,000 facts, then the fastest native backend here | nothing                             |

`--backend` on `ask`, `probe` and `fidelity`, or `TENDORA_BACKEND`, chooses
one; the workbench takes `--backend` too. The native program is built on first
use into `.deps/native`; starting it costs tens of milliseconds, so it pays
only on large stores, and a check's inference is bounded at 48,000 facts today:
`auto` then chooses `js`. A backend this machine lacks is refused with why.

## Output and exit status

Results go to stdout; diagnostics and progress to stderr, progress only on a
terminal or with `--explain`. With `--json`, stdout is JSON only. No output
uses color.

| Status | Meaning                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| `0`    | Completed, including an open answer                                                                        |
| `1`    | A failure, a missing reading, or a declined deletion                                                       |
| `2`    | Invalid arguments: an unknown command or option, or a project, run, role or statement that matches nothing |
| `130`  | Interrupted: the first `Ctrl+C` cancels, the second exits                                                  |

A syntax error points to the help. A name that matches nothing gives its own
next step instead: the closest statements, the roles there are, or the command
that lists saved checks. A script reads the status in the result, not only the
exit status.

## Environment

| Variable              | Use                                                               |
| --------------------- | ----------------------------------------------------------------- |
| `EGEMMA_URL`          | eGemma's base URL; default `http://127.0.0.1:8000`                |
| `EGEMMA_API_KEY_FILE` | A file holding the service key; preferred, wins over the variable |
| `EGEMMA_API_KEY`      | The service key; default `dummy-key`                              |
| `PENMAN_PYTHON`       | The Python used for graph preparation; default `.venv/bin/python` |
| `TENDORA_BACKEND`     | The trim backend when `--backend` is not given; default `js`      |
| `TENDORA_SWIFTC`      | The Swift compiler that builds the native trim; default `swiftc`  |

## Conventions

The CLI follows the [Command Line Interface Guidelines](https://clig.dev/):
help and an example for every command, suggestions for mistyped commands and
options, errors that name the next command, human output by default and JSON on
request, stdout for results and stderr for the rest, `--version`, and a
confirmation on a terminal before deleting (a script deletes at once; `--dry-run`
shows what would go). The workbench takes `--no-color` and respects `NO_COLOR`
and `TERM=dumb`; `npm run workbench -- --help` lists its options.

Statements are written in the workbench, not from the CLI, so a script's
statements cannot pass for a person's; every statement records who wrote it.
