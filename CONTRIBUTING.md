# Contributing

Thank you for helping. Tendora answers only what its statements support, so
every change is held to one standard: no wrong answer, and nothing it cannot
show.

## Start

```sh
npm ci
npm run setup:python
npm run demo
npm run check
```

[The README](README.md) says what Tendora is, [the capability tour](docs/demo.md)
shows each capability on the bundled demo, and [the architecture](docs/architecture.md)
and [the agent guide](AGENTS.md) set the boundaries a change keeps.

## A change

| Rule                                    | Why                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A failing test first, for every fix     | The test shows the fault, and that the fix is what removes it                                          |
| No wrong answer                         | A lost answer can come back; a wrong one is trusted                                                    |
| No word-specific fixes                  | A fix for one word breaks the next domain; fix the reading or the rule                                 |
| Never lower a benchmark floor           | A floor records what the engine already does                                                           |
| No second generative pass               | Only eGemma reads text; everything after the reading is deterministic                                  |
| Statements are written in the workbench | So a script's statements cannot pass for a person's                                                    |
| The demo changes only through its tools | `demo/payments-on-call` is built, refreshed and drawn by `tools/` ([development](docs/development.md)) |

While iterating, `npm run check:changed` runs the suites a change reaches and
`npm run format:changed` checks its formatting; run the full `npm run check`
before you send it. A documentation change keeps every CLI example running as
written and every link resolving (`acceptance/doc-examples`,
`architecture/doc-links`).

One change a pull request, with a message that says what changed and why, in
the form the history uses: `fix(cli): …`, `feat(engine): …`, `docs: …`.

## Reporting a problem

Open an issue with the command you ran, what it printed (`--json` helps), what
you expected, and `npx tendora --version`. A wrong answer is the most useful
report there is: include the statements and the question. For a security
problem, see [the security policy](SECURITY.md) instead.

## Licensing

Contributions are made under the license of the part they change: MIT for code,
tests, tools and documentation; CC BY 4.0 for the essay
[Load-bearing as situated meaning](docs/load-bearing.md); GPL-3.0-only for the
SEMCAT adapter. [Licensing and attribution](THIRD_PARTY_NOTICES.md) lists every
path. Credit what you build on.
