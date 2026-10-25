# Repository guide

Tendora is a research workbench for authoring knowledge through language and
checking questions against scoped sources. Keep its CLI small; the TUI is the
main authoring interface.

## Start here

- [The README](README.md): what Tendora is, its capabilities, setup.
- [The capability tour](docs/demo.md): every capability on the bundled demo.
- [Architecture](docs/architecture.md): boundaries and limitations.
- [Storage](docs/storage.md): layout, schemas and embeddings.
- [Development](docs/development.md): tests and dependency updates.
- [Licensing and attribution](THIRD_PARTY_NOTICES.md): licensing scope.

Use Node.js 24+ and `npm ci`; `npm run setup:python` installs the local Python
environment with uv. Test without a running model service: `npm run check`.
Run `npm run format:changed` (or `format:check` for everything) before committing.

## Preserve the architecture

- Separate text-to-AMR acquisition from deterministic reasoning. Do not add a
  second generative pass for source interpretation, paraphrases or alignment.
- Extend the AMR/HRG compiler, query chart and attributed answer checking.
  Grammar recognition and semantic similarity alone do not establish entailment.
- Preserve assertion, role, polarity, modality, reference and source boundaries.
  A question is not evidence of its own truth.
- Retain supported parts and located openings when the whole relation is unresolved.
  Never turn a limit or missing acquisition into a supported answer.
- Keep domain premises in authored material. Do not add word-specific fixes or
  require hand-written formal rules to make a domain example work.
- Author through language; keep graph IDs and production editing out of ordinary
  product flows. Advanced diagnostics can expose them.

## Work safely

Use disposable copies under `tmp/` or ignored `.proj/` directories. Preserve the
canonical `.proj/payments-on-call` snapshot; change it only through its tools
(`docs/development.md`), then redraw the tour's graphs. It is the only bundled demo;
synthetic regression fixtures and external research harnesses live under `test/`
and `tools/`.

Keep the demo's retained material in `material.sqlite` and its computed results
in `engine/artifacts.sqlite`. Preserve decoded bytes and content hashes when
repacking. These two bundled databases are explicitly tracked.

Introduce a new concept, term or layer only with a test that could show it
failing. Prefer the cheapest discriminating test to new apparatus, and never
lower a benchmark floor to make a change pass.

Register every new test once in `test/suites.mjs`. Add focused regressions for
behavior changes and run the affected tests, then `npm run check:changed` (the
suites the change reaches); run the full `npm run check` before a snapshot or
after changing the runner. Documentation changes need factual checks and the
two documentation suites (`architecture/doc-links`, `acceptance/doc-examples`),
not a full engine run.

Keep credentials, personal corpora and generated runtime state out of Git.
Update SEMCAT behavior in its fork, then update its pin and
source hashes together; see [the integration guide](python/semcat/README.md).
Keep all third-party notices when changing packaging.
