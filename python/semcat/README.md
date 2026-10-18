# SEMCAT integration

The small `tendora-semcat` adapter calls the maintained
[SEMCAT fork](https://github.com/mirzahusadzic/semcat), pinned to
`e00a02b954e8d6baf3e362844da4e9ae6509efc9`. The fork supplies Smatch++, RoSE,
the original aggregator and shared AMR normalization. Its optimizer and
weighting are preserved; normalization fixes can change scores.

```sh
npm run setup:python
.venv/bin/python python/semcat/manage.py verify
```

Setup requires uv. It installs `semcat-runtime==0.1.0` from the exact
commit archive with its SHA-256 pinned in `UPSTREAM.json`, then verifies all 24 runtime files against `UPSTREAM.json` and
the adapter against its assembled source manifest. The adapter repeats those
checks before comparisons, rejects shadowed imports, and reports commit,
fingerprints and dependency versions. These checks detect drift; they are not
a substitute for reviewing dependency changes.

Builds live in ignored `.proj/semcat-builds/`. Reinstall after editing the
adapter. Change runtime behavior in the fork, then update both the dependency
pin and `UPSTREAM.json` hashes from that commit. Do not install the standalone
`smatchpp` or `semantic-rose` distributions in the same environment.

`manage.py build` assembles the adapter without a network. `install` and
`verify` accept `--python /path/to/python`; otherwise they use `PENMAN_PYTHON`
or the current interpreter. Installation also accepts `--no-deps` and
`--no-build-isolation` for an already prepared environment.

The bridge uses Python-MIP/HiGHS, bounded inputs and per-pair deadlines. Case,
quotes, Unicode, original variable identities and lexical roles are retained.
The default SEMCAT weights are `1` and `1-alpha`, with `alpha=0.25`.
Incomplete optimization returns an explicit limit, not a certified score.

The adapter is **GPL-3.0-only**, copyright 2026 Mirza Husadzic; see
[its license](adapter/LICENSE). The dependency combines GPLv3 and MIT code;
see [repository licensing](../../THIRD_PARTY_NOTICES.md). Distributing an
integrated runtime requires complying with GPLv3, including corresponding
source obligations.

Run the packaging and drift tests with:

```sh
.venv/bin/python python/semcat/test_manage.py
```
