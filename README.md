# Tendora

A terminal workbench for developing knowledge through natural language, with traceable reasoning across roles.

[![CI](https://github.com/mirzahusadzic/tendora/actions/workflows/ci.yml/badge.svg)](https://github.com/mirzahusadzic/tendora/actions/workflows/ci.yml)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Python 3.14](https://img.shields.io/badge/Python-3.14-3776AB?logo=python&logoColor=white)](docs/setup.md)
[![Code: MIT](https://img.shields.io/badge/code-MIT-blue)](THIRD_PARTY_NOTICES.md)

Write statements, organize them by role, and ask questions within a scope. Tendora retains the readings, checks answers against sources, and keeps conditions and unresolved relations visible as the corpus develops.

**Research prototype.** Language acquisition uses [eGemma](https://github.com/mirzahusadzic/egemma); reasoning over retained readings runs locally. The bundled demo works offline after setup.

## Where it stands

Tendora is a domain corpus engine: each project develops the narrow part of language its domain needs, through the statements written for it.

It answers only what its sources support. Answers stay attributed, unknowns stay open, and withdrawing a statement retracts only what depended on it.

The open problem is answering questions worded independently of a domain's statements. The demo's seventeen questions were written together with its statements. Three more domains were written as held-out benchmarks, two of them blind with a sealed answer key. When first run, the engine supported 0 of their 18 warranted answers, kept all 5 open or ambiguous questions open and supported nothing false. These questions have since been [diagnosed in detail](docs/held-out-diagnosis.md) and now serve as development sets: the engine supports 4 of the 18, still with nothing false. A claim about generalisation needs a new sealed domain:

```sh
node test/acceptance/independent-domain.mjs
```

## Start

Requires **Node.js 24+**, **[uv](https://docs.astral.sh/uv/)** and Git on macOS or Linux. Setup creates a local Python 3.14 environment.

```sh
git clone https://github.com/mirzahusadzic/tendora.git
cd tendora
npm ci
npm run setup:python
npm run demo
npm run workbench -- --project .proj/payments-demo
```

Choose a role; `n` adds statements, `a` asks a new question, and `o` opens Development, where unsent questions wait as drafts. Select a saved question to see its answer and evidence. From an unsupported connection, `c` continues the question and keeps the originating question, opening and purpose visible. In Development, `i` changes the purpose of the selected saved question. Use `Ctrl+S` to save, `Esc` to return, and `?` for help.

## Try a question

The single bundled project, **Payments On-Call**, has six roles, nineteen statements and seventeen questions with computed answers and evidence. It explores what the written sources support, including conditions and role boundaries.

```sh
npm run engine -- ask --project .proj/payments-demo \
  --scope 'Incident Commander' \
  --question 'What does the security engineer report?' --offline
```

Returns **leaked payment key**, marked **conditional**, with the supporting source attached.

Use `--explain` for evidence, `--json` for structured output, and `--offline` to prohibit new acquisitions. For scripts, `npm run --silent engine -- …` keeps npm's banner off stdout; diagnostics go to stderr. `npm run engine -- --help` lists commands.

## The name

Tendora comes from _tendon_: the tissue that carries load between muscle and bone, and where resistance is felt. A tendon can be touched gently to ease pain or pressed firmly. Tendora is the firm press: a question is compressed into a bounded check against scoped sources, and whatever cannot be supported stays visible as an opening. Gentle reflection may propose; what holds is settled by the sources and by agreement among the participants.

## Stack

JavaScript ES modules · terminal-kit · SQLite / sqlite-vec · Python / PENMAN · [SEMCAT](https://github.com/mirzahusadzic/semcat) · [PropBank](vendor/propbank/README.md)

Optional grammar checks use our [Bolinas fork](https://github.com/mirzahusadzic/bolinas): after Python setup, run `npm run setup:bolinas` and `npm run check:research`. Both forks are pinned to exact revisions.

[Setup & CLI](docs/setup.md) · [Architecture](docs/architecture.md) · [Development & CI](docs/development.md) · [Load-bearing meaning](load-bearing.md)

## License

Tendora's original code, tests, tools, documentation and payments demo are [MIT](LICENSE). Some parts carry other terms:

- `python/semcat/adapter/` is GPL-3.0-only; the SEMCAT runtime that setup installs is GPL-3.0-only AND MIT. Distributing Tendora integrated with SEMCAT must comply with GPLv3.
- `vendor/propbank/lexicon.json` is PropBank-derived data under CC BY-SA 4.0.
- [`load-bearing.md`](load-bearing.md) is CC BY 4.0.

See [licensing and attribution](THIRD_PARTY_NOTICES.md) for every path, installed component and notice.
