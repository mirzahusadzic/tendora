# Development

After [setup](setup.md):

```sh
npm run check
npm run format:check
.venv/bin/python python/semcat/test_manage.py
.venv/bin/python python/semcat/manage.py verify
.venv/bin/python vendor/propbank/build.py --check
```

`npm run check` runs sequential offline suites, including the payments demo,
engine, storage, CLI, architecture and actual terminal interactions. It rejects
JavaScript fetch calls. Fixtures are synthetic or retained acquisitions; no
model service or credentials are needed. Tests use disposable project copies.
`npm test` runs the same suites as `npm run check`.

Every runnable test belongs to exactly one profile in `test/suites.mjs`.
Architecture checks enforce module boundaries and complete fixture imports.
For focused work, run the relevant `node test/<area>/<test>.mjs` first.
`npm run format` formats maintained JavaScript and public documentation;
vendored upstream source and canonical project data are excluded.

[CI](../.github/workflows/ci.yml) runs on Linux and macOS with Node.js 24,
installs Python 3.14 through uv, checks provenance and formatting, then runs
the offline tests and the independent Bolinas cross-check.

The 10,000-role background-process test has a three-minute deadline. Navigation
timings are reported everywhere; the 100 ms target is enforced locally because
hosted runner scheduling varies. Navigation, event-loop responsiveness and
cancellation assertions run on every platform.

Refresh all bundled answers offline with `node tools/refresh-payments-demo.mjs`.
It computes results on a disposable copy, verifies the retained material and
portable evidence, then replaces the demo's two compact SQLite stores.

## External research profiles

Three profiles in `test/suites.mjs` run against private, retained projects that
are not bundled. They are opt-in and do not run in CI:

| Profile              | Command                                | Requires                                   |
| -------------------- | -------------------------------------- | ------------------------------------------ |
| `acceptance:tendora` | `node test/run.mjs acceptance:tendora` | `TENDORA_CONTRACT_SOURCE`: service project |
| `acceptance:hand`    | `node test/run.mjs acceptance:hand`    | `HAND_CONTRACT_SOURCE`: hand project       |
| `research:hand`      | `node test/run.mjs research:hand`      | `HAND_CONTRACT_SOURCE`: hand project       |

Each copies its source into a new `tmp/` directory and reasons offline with
retained acquisitions only. The two acceptance profiles are strict product
gates: they write `manifest.json` and terminal captures, and any failed or
unexecuted requirement fails the profile. `research:hand` is diagnostic and
checks that the original project files are unchanged. A clean checkout cannot
run these profiles without the corresponding project.

## Dependencies and references

The application depends on terminal-kit and sqlite-vec through the npm lockfile.
The Python adapter pins the SEMCAT fork by full commit and verifies installed
source hashes; see [its integration guide](../python/semcat/README.md).
Transitive Python dependencies use the declared version ranges, and their
resolved versions are recorded in comparison results.

PropBank is the only vendored dependency. Its lexical data has pinned source
and derived hashes.

For independent grammar validation, install the
[Bolinas fork](https://github.com/mirzahusadzic/bolinas) at the revision in
[`tools/bolinas.json`](../tools/bolinas.json):

```sh
npm run setup:bolinas
.venv/bin/python tools/bolinas.py test
npm run check:research
```

Setup downloads a detached Git checkout into ignored `.deps/bolinas/`.
Subsequent checks run offline and verify the pinned revision and clean source.
The application and payments demo do not require Bolinas. To update its pin,
review the fork changes, edit `tools/bolinas.json`, move the existing checkout
aside and rerun setup.

Review source and license changes when updating any pin. Preserve the
[third-party notices](../THIRD_PARTY_NOTICES.md).
