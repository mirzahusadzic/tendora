# Setup

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
npm run demo -- --reset
npm run workbench -- --project .proj/payments-demo
```

The demo contains `project.json`, retained material in `material.sqlite`, and
36 computed results with their evidence in `engine/artifacts.sqlite`; the
[capability tour](demo.md) walks through them.
The bundled snapshot lives in `demo/payments-on-call` and changes only through
its tools; `npm run demo` copies it to `.proj/payments-demo`, the one project in
`.proj/`, which is yours to change. Run again, it leaves an existing copy alone
and says whether it still matches the bundled demo; `npm run demo -- --reset`
discards the copy and starts again, and replaces nothing that is not a copy of
the demo.
The payments sources and acquisitions contain synthetic incident material.

The editor starts with a role tree. Use `n` to add statements, `e` to edit,
`a` to ask and `o` to open Development. Forms use `Ctrl+S` to save and `Esc` to
return. Pane footers and `?` show context-specific actions. Start without
`--project` to use the project launcher.

```sh
npm run workbench -- --project .proj/payments-demo --snapshot
npm run workbench -- --help
```

The trim runs in JavaScript; on macOS with the Swift toolchain it can run in
Swift or on the GPU instead ([trim backends](cli.md#trim-backends)).

`--snapshot` prints a plain-text view. A project opened without a terminal also
uses that mode. `NO_COLOR=1`, `TERM=dumb` or `--no-color` disable color.

## Scriptable checks

```sh
npx tendora ask --project .proj/payments-demo \
  --question 'Who freezes deployments during a major incident?' --offline
npx tendora --help
```

[The CLI reference](cli.md) covers every command, its output, exit status and
environment.

## Fresh language with eGemma

Run [eGemma](https://github.com/mirzahusadzic/egemma) separately, then configure
its base URL and bearer token in the environment that launches Tendora:

```sh
export EGEMMA_URL=http://127.0.0.1:8000
export EGEMMA_API_KEY_FILE=~/.config/egemma/key   # or EGEMMA_API_KEY=your-service-key
```

Defaults are `http://127.0.0.1:8000` and `dummy-key`. A key file stays out of
the environment that child processes and logs inherit. Tendora does not start the
server or bundle model weights. Ordinary interactive use and CLI checks without
`--offline` can send source, case and question text to the configured service
when readings are missing. The demo's 36 questions and their cases replay
offline; new wording needs a reading.

The service must support `POST /amr/parse-batch` and `POST /embed/texts`.
Embedding requests use `dimensions: 768` and `prompt_name: "STS"`; Tendora
keeps the first 128, and they only order exploration
([what embeddings do](storage.md#embeddings)).

Missing readings stay visible as `needs-amr`. Check the selected Python
environment if graph preparation fails, and the eGemma URL/key if new language
cannot be acquired. The offline demo and CI do not need a service or credentials.
