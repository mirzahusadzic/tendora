# Setup and CLI

Tendora runs on macOS and Linux with Node.js 24+, npm, Git and
[uv](https://docs.astral.sh/uv/getting-started/installation/). Python deadlines
and the PTY harness currently require Unix; native Windows is not supported.

```sh
npm ci
npm run setup:python
```

Python setup creates `.venv` with Python 3.14 and installs the pinned SEMCAT
runtime and its dependencies. It needs network access for the initial download.
If `.venv` uses an older Python, move it aside and rerun setup.
The engine uses `PENMAN_PYTHON` when set, then `.venv/bin/python`, then `python3`.
An explicit environment must provide Python 3.14+ and the declared adapter.
Run `.venv/bin/python python/semcat/manage.py verify` to check installed sources.

## Work on a copy

```sh
npm run demo
npm run workbench -- --project .proj/payments-demo
```

The demo contains `project.json`, retained material in `material.sqlite`, and
twenty-one computed results with their evidence in `engine/artifacts.sqlite`.
Work on a copy to keep the bundled snapshot unchanged; generated databases and
engine data elsewhere are ignored. `npm run demo` leaves an existing copy
unchanged; `npm run demo -- --reset` discards it and starts again.
The payments sources and acquisitions contain synthetic incident material.

The editor starts with a role tree. Use `n` to add statements, `e` to edit,
`a` to ask and `o` to open Development. Forms use `Ctrl+S` to save and `Esc` to
return. Pane footers and `?` show context-specific actions. Start without
`--project` to use the project launcher.

```sh
npm run workbench -- --project .proj/payments-demo --snapshot
npm run workbench -- --help
```

`--snapshot` prints a plain-text view. A project opened without a terminal also
uses that mode. `NO_COLOR=1`, `TERM=dumb` or `--no-color` disable color.

## Scriptable checks

```sh
npm run engine -- ask --project .proj/payments-demo \
  --scope 'Incident Commander' \
  --question 'Who freezes deployments during a major incident?' --offline --explain

npm run --silent engine -- runs --project .proj/payments-demo --json
npm run engine -- ask --help
```

`ask` checks current sources; `runs` lists saved checks; `show --run ID` reads
a saved result. Use `init --project PATH` for a new empty project and the TUI
to author it. `--scope` accepts a role label or `/Root/Child` path. Duplicate
nested labels need a full path. `--case` and `--case-text` supply independent
case material; a question or case does not become corpus evidence.

| Option      | Behavior                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `--offline` | Reuse exact retained AMRs; do not acquire missing readings.              |
| `--explain` | Include evidence and proof details; progress goes to stderr.             |
| `--json`    | Write a structured result to stdout. Use npm's `--silent` for pipelines. |
| `--trace`   | Retain detailed local comparison diagnostics.                            |

Exit codes are `0` for a completed check, `1` for a failure or missing reading,
`2` for invalid arguments, and `130` for interruption. A completed check may
be conditional or open: inspect its status, not just its exit code. `show`
does not reassess changed sources. `delete` requires `--run ID` or `--all` and
acts immediately; `compact` removes rebuildable cached state.

## Fresh language with eGemma

Run [eGemma](https://github.com/mirzahusadzic/egemma) separately, then configure
its base URL and bearer token in the environment that launches Tendora:

```sh
export EGEMMA_URL=http://127.0.0.1:8000
export EGEMMA_API_KEY=your-service-key
```

Defaults are `http://127.0.0.1:8000` and `dummy-key`. Tendora does not start the
server or bundle model weights. Ordinary interactive use and CLI checks without
`--offline` can send source, case and question text to the configured service
when readings are missing. The sixteen other retained payments questions are
listed in the project; arbitrary new wording may need acquisition.

The service must support `POST /amr/parse-batch` and `POST /embed/texts`.
Embedding requests use `dimensions: 768` and `prompt_name: "STS"`; role ordering
uses normalized leading dimensions. Ranking is navigation, not proof.

Missing readings stay visible as `needs-amr`. Check the selected Python
environment if graph preparation fails, and the eGemma URL/key if new language
cannot be acquired. The offline demo and CI do not need a service or credentials.
