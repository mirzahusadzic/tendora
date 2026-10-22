# Offline PropBank lexical resource

Derived from the [PropBank project's frames](https://github.com/propbank/propbank-frames)
at release **v3.4.0**, commit
`4087fa9ab5c40907c34ff91a56acc2cab1670145`. Attribution: the PropBank project
and the contributors identified in its frame files. This derived lexical data
is distributed under **CC BY-SA 4.0**; see the upstream [LICENSE](LICENSE).
That license covers the derived data only: `build.py` and this guide are
original Tendora code under the repository's [MIT license](../../LICENSE).
[UPSTREAM.json](UPSTREAM.json) records source, archive and derived-file hashes.

`lexicon.json` contains 11,205 rolesets. Each entry retains the roleset description,
aliases, annotated predicate surfaces, numbered role descriptions and original
XML filenames. Full example sentences and argument annotations are omitted.
The runtime requires no Python, model, service or additional npm package.

Changes made while deriving the data:

- Convert PropBank identifiers to AMR spelling: `interact.01` becomes
  `interact-01`, and `log_on.02` becomes `log-on-02`.
- Merge the duplicate `overhang.01` definitions from `hang.xml` and
  `overhang.xml`, retaining both descriptions, role descriptions and filenames.
  These descriptions are inspection data, not a rule for equating role meanings.
- Extract only `<rel>` predicate surfaces from annotated examples, preserving
  irregular forms without treating argument text as predicate evidence.

The resource is pinned deliberately. Absence of an AMR predicate from this
release can reflect a different frame inventory. Aliases and examples are also
incomplete: a failed lookup does not establish a parsing error. A matched lemma
does not validate its sense, role bindings, negation or reference resolution.

Verify the checked-in files without a download:

```sh
python3 vendor/propbank/build.py --check
```

For reproducible regeneration, keep the downloaded archive under the repository:

```sh
mkdir -p tmp/propbank-audit
curl -L --fail https://codeload.github.com/propbank/propbank-frames/zip/refs/tags/v3.4.0 \
  -o tmp/propbank-audit/propbank-v3.4.0.zip
python3 vendor/propbank/build.py --check tmp/propbank-audit/propbank-v3.4.0.zip
```

Omit `--check` to regenerate the three derived files. The builder verifies the
pinned archive hash before reading the XML; the runtime verifies the index hash
before using it. Runtime checking lives in
[lexical-audit.mjs](../../src/amr/lexical-audit.mjs).
