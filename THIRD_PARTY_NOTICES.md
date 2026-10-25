# Licensing and attribution

Copyright © 2026 Mirza Husadzic for original Tendora contributions.

Tendora is not under a single license. Its original code is under the Apache
License 2.0; a small adapter and two bundled resources carry their own terms,
and setup installs further components under theirs. The [LICENSE](LICENSE) file
is the Apache 2.0 text, for original contributions only, and [NOTICE](NOTICE)
their notice.

## In this repository

| Path                                                                                                       | License      | Notices                                              |
| ---------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------- |
| Everything not listed below: application code, tests, tools, documentation and the synthetic payments demo | Apache-2.0   | [LICENSE](LICENSE), [NOTICE](NOTICE)                 |
| `python/semcat/adapter/` (SEMCAT Python adapter)                                                           | GPL-3.0-only | [Adapter license](python/semcat/adapter/LICENSE)     |
| `vendor/propbank/lexicon.json` (PropBank-derived data; the `build.py` beside it is Apache-2.0)             | CC BY-SA 4.0 | [License and attribution](vendor/propbank/README.md) |
| `docs/load-bearing.md`, the essay [Load-bearing as situated meaning](docs/load-bearing.md)                 | CC BY 4.0    | [License](licenses/CC-BY-4.0.txt), Mirza Husadzic    |

`package.json` states the same scope as an SPDX expression:
`Apache-2.0 AND GPL-3.0-only AND CC-BY-SA-4.0 AND CC-BY-4.0`. Versions before
the switch were MIT.

## Installed by setup, not stored here

| Component                                                           | License                                                                                         | Notices                                                                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| SEMCAT runtime, into `.venv/` by `npm run setup:python`             | GPL-3.0-only AND MIT                                                                            | [Fork licensing](https://github.com/mirzahusadzic/semcat/blob/e00a02b954e8d6baf3e362844da4e9ae6509efc9/LICENSING.md)        |
| Optional Bolinas checkout, into `.deps/` by `npm run setup:bolinas` | MIT core; bundled utilities under Apache-2.0, MIT and LGPL-3.0-or-later, plus ColorBrewer terms | [Fork component notices](https://github.com/mirzahusadzic/bolinas/blob/70fbac4afe7177d28f9658df4c88b2e1b4bcbfbb/NOTICES.md) |
| npm and Python dependencies                                         | As supplied with each installed distribution                                                    | Their package metadata                                                                                                      |
| `node-bitmap` 0.0.1, through terminal-kit                           | MIT, Copyright (c) 2012 Yusuke Hata; its package metadata names no license                      | [Its README](https://github.com/nowelium/node-bitmap)                                                                       |
| `sqlite-vec` 0.1.9 and its platform builds, by Alex Garcia          | MIT OR Apache-2.0; its metadata reads "MIT OR Apache"                                           | [Upstream licenses](https://github.com/asg017/sqlite-vec)                                                                   |

## What this means in practice

This is a summary, not legal advice; the license texts govern.

- The Apache-2.0 files can be reused under Apache 2.0 on their own: keep the
  license and the NOTICE, and say what you changed. The license also grants
  the contributors' patent rights in what they contributed.
- Running, studying and modifying Tendora locally places no further
  conditions on you.
- Distributing Tendora together with the SEMCAT adapter or runtime, as an
  integrated application, must comply with GPLv3, including its
  corresponding-source obligations, while preserving the Apache-2.0 and MIT
  notices.
- Redistributing the PropBank-derived lexicon, or adaptations of it, requires
  attribution and the same CC BY-SA 4.0 terms.

## Dependency attribution

**SEMCAT** is installed from the [maintained fork](https://github.com/mirzahusadzic/semcat).
It combines Smatch++ by Juri Opitz and SEMCAT contributors with RoSE by the RoSE
Developers. [The manifest](python/semcat/UPSTREAM.json) pins the upstream and
fork revisions. Distribution of the integrated application/runtime must comply
with GPLv3, including applicable corresponding-source obligations, and preserve
the MIT notices.

**PropBank** is the only dependency source data bundled in `vendor/`.
The lexicon derives from PropBank frames v3.4.0, with attribution to the
PropBank project and its frame contributors. Identifier normalization,
merged rolesets and extracted lexical fields are documented in
[the resource guide](vendor/propbank/README.md); its manifest records source
and derived-file hashes.

**Bolinas** is installed separately for optional grammar checks from
[the Python 3 fork](https://github.com/mirzahusadzic/bolinas), based on
[isi-nlp/bolinas](https://github.com/isi-nlp/bolinas).
Original authors include Jacob Andreas, Daniel Bauer, David Chiang,
Karl Moritz Hermann and Kevin Knight. The fork retains the NLTK, termcolor,
xdot and ColorBrewer notices and license texts.
[The dependency pin](tools/bolinas.json) records the exact revision.

**PENMAN**, by Michael Wayne Goodman, reads and normalizes the AMR graphs
([goodmami/penman](https://github.com/goodmami/penman), installed by setup).

Other npm and Python dependencies retain the licenses supplied with their
installed distributions. eGemma runs separately under its own code and model
licenses.

## Development reference

The [AMR annotation guidelines](https://github.com/amrisi/amr-guidelines/blob/master/amr.md)
were consulted during development for AMR notation and interpretation.

[Cuckoo Cycle](https://github.com/tromp/cuckoo) (Cuck(at)oo Cycle), by John
Tromp, is the model for the trim in `bench/lean-core`. Its edge trimming
discards over 99.9% of a graph's edges before the cycle search; the trim
discards the facts no match can use before the engine joins. Its lean miner (a
bit per edge, latency-bound) and mean miner (bucketed, bandwidth-bound) are the
pattern of the trim's two GPU variants, and the lean miner names the
directory. No Cuckoo Cycle code is included: the trim, arc consistency over
rules and facts, is written for Tendora.
