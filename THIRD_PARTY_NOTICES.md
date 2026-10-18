# Licensing and attribution

Copyright © 2026 Mirza Husadzic for original Tendora contributions.
The [MIT license](LICENSE) covers original application code, tests, tools,
documentation and the synthetic payments demo, with the component scopes below.

| Component                             | License                                                                                         | Source and notices                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| SEMCAT Python adapter                 | GPL-3.0-only                                                                                    | [Adapter license](python/semcat/adapter/LICENSE)                                                                            |
| Installed SEMCAT runtime              | GPL-3.0-only AND MIT                                                                            | [Fork licensing](https://github.com/mirzahusadzic/semcat/blob/e00a02b954e8d6baf3e362844da4e9ae6509efc9/LICENSING.md)        |
| Bundled PropBank-derived data         | CC BY-SA 4.0                                                                                    | [License and attribution](vendor/propbank/README.md)                                                                        |
| Optional Bolinas checkout             | MIT core; bundled utilities under Apache-2.0, MIT and LGPL-3.0-or-later, plus ColorBrewer terms | [Fork component notices](https://github.com/mirzahusadzic/bolinas/blob/70fbac4afe7177d28f9658df4c88b2e1b4bcbfbb/NOTICES.md) |
| [Load-bearing essay](load-bearing.md) | CC BY 4.0                                                                                       | [License](licenses/CC-BY-4.0.txt), Mirza Husadzic                                                                           |

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

Other npm and Python dependencies retain the licenses supplied with their
installed distributions. eGemma runs separately under its own code and model
licenses.

## Development reference

The [AMR annotation guidelines](https://github.com/amrisi/amr-guidelines/blob/master/amr.md)
were consulted during development for AMR notation and interpretation.
