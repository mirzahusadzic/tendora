# Tendora

A terminal workbench for developing knowledge through natural language, with traceable reasoning across roles.

[![CI](https://github.com/mirzahusadzic/tendora/actions/workflows/ci.yml/badge.svg)](https://github.com/mirzahusadzic/tendora/actions/workflows/ci.yml)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Python 3.14](https://img.shields.io/badge/Python-3.14-3776AB?logo=python&logoColor=white)](docs/setup.md)
[![Code: MIT](https://img.shields.io/badge/code-MIT-blue)](THIRD_PARTY_NOTICES.md)

Write statements, organize them by role, and ask questions within a scope. Tendora retains the readings, checks answers against sources, and keeps conditions and unresolved relations visible as the corpus develops.

**Research prototype.** Language acquisition uses [eGemma](https://github.com/mirzahusadzic/egemma); reasoning over retained readings runs locally. The bundled demo works offline after setup.

## Start

Requires **Node.js 24+**, **[uv](https://docs.astral.sh/uv/)** and Git on macOS or Linux. Setup creates a local Python 3.14 environment.

```sh
git clone https://github.com/mirzahusadzic/tendora.git
cd tendora
npm ci
npm run setup:python
cp -R .proj/payments-on-call .proj/payments-demo
npm run workbench -- --project .proj/payments-demo
```

Choose a role; `n` adds statements, `a` asks a question, and `o` opens Development. Select a saved question to see its answer and evidence. Use `Ctrl+S` to save, `Esc` to return, and `?` for help.

## Try a question

The single bundled project, **Payments On-Call**, has six roles, nineteen statements and seventeen questions with computed answers and evidence. It explores what the written sources support, including conditions and role boundaries.

```sh
npm run engine -- ask --project .proj/payments-demo \
  --scope 'Incident Commander' \
  --question 'What does the security engineer report?' --offline
```

Returns **leaked payment key**, marked **conditional**, with the supporting source attached.

Use `--explain` for evidence, `--json` for structured output, and `--offline` to prohibit new acquisitions. For scripts, `npm run --silent engine -- …` keeps npm's banner off stdout; diagnostics go to stderr. `npm run engine -- --help` lists commands.

## Stack

JavaScript ES modules · terminal-kit · SQLite / sqlite-vec · Python / PENMAN · [SEMCAT](https://github.com/mirzahusadzic/semcat) · [PropBank](vendor/propbank/README.md)

Optional grammar checks use our [Bolinas fork](https://github.com/mirzahusadzic/bolinas): after Python setup, run `npm run setup:bolinas` and `npm run check:research`. Both forks are pinned to exact revisions.

[Setup & CLI](docs/setup.md) · [Architecture](docs/architecture.md) · [Development & CI](docs/development.md) · [Load-bearing meaning](load-bearing.md)

## License

Original application code and the payments demo are [MIT](LICENSE). The SEMCAT adapter/runtime and bundled data retain their own terms; the integrated runtime is subject to GPLv3 obligations. See [license scopes and attribution](THIRD_PARTY_NOTICES.md).
