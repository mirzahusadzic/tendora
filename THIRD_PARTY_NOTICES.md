# Licensing and third-party notices

## This repository

| Path | License |
| ---- | ------- |
| `dist/` (the bundled Tendora engine) | [Tendora Demo Engine License](dist/LICENSE): run it, unmodified, to evaluate, demo and research; no redistribution, reverse engineering or hosted service |
| `docs/load-bearing.md`, the essay [Load-bearing as situated meaning](docs/load-bearing.md) | [CC BY 4.0](licenses/CC-BY-4.0.txt), Mirza Husadzic |
| The engine's language packs, compiled into `dist/` | Part of the engine, under its license; they reference PropBank 3.4.0 frame identifiers (PropBank is CC BY-SA 4.0; see `vendor/propbank`). The bundle also carries bun's MIT-licensed runtime helper |
| `vendor/propbank/lexicon.json` (PropBank-derived data) | CC BY-SA 4.0, with attribution in [its guide](vendor/propbank/README.md) and [the upstream license](vendor/propbank/LICENSE) |
| Everything else: the payments corpus (`demo/`), the evidence, the documents, the essay's helper and its test | [Apache License 2.0](licenses/Apache-2.0.txt), with its [NOTICE](NOTICE) |

## Installed separately

| Component | How it arrives | License |
| --------- | -------------- | ------- |
| [terminal-kit](https://github.com/cronvel/terminal-kit) and its dependencies | `npm install` | MIT (16 packages), BSD-3-Clause (jpeg-js), BSD-3-Clause AND Apache-2.0 (chroma-js); `node-bitmap` 0.0.1, pulled in by terminal-kit's image support, is MIT, stated in its README (its package.json declares no license) |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | `npm install` (a prebuilt binary for your platform) | MIT OR Apache-2.0 |
| [PENMAN](https://github.com/goodmami/penman) | `npm run setup:python`, into `.venv/` | MIT |
| [SEMCAT](https://github.com/mirzahusadzic/semcat) runtime and its `tendora-semcat` adapter | `npm run setup:python`, into `.venv/`, from SEMCAT's own repository at a pinned commit | GPL-3.0-only AND MIT (runtime); GPL-3.0-only (adapter). Its dependencies include `cbcbox` (EPL-2.0) and numpy, pandas and networkx (BSD) |
| [Node.js](https://nodejs.org/) 24 or later | the runtime you install | MIT |

SEMCAT is not part of this repository or of the engine bundle. `npm run setup:python` installs it from its own repository, and the engine runs it as a separate program, exchanging one JSON request a line over standard input and output, to compare meaning graphs when you ask a new question. The bundled demo and Gadfly's batteries need neither SEMCAT nor Python.
