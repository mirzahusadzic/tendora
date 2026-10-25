# Security

Tendora is a research prototype without releases; the `main` branch is the one
supported.

## Reporting

Report a vulnerability privately through GitHub: the repository's **Security**
tab, **Report a vulnerability**. Please do not open a public issue. Say what
you ran, what happened and what an attacker would gain; a reproduction on a copy
of the demo is ideal. Reports are acknowledged as soon as they are read, and
fixed with a test that shows the fault.

## In scope

| Area                 | What Tendora promises                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Answers              | Only what the statements support; a question is never its own evidence                                                               |
| Provenance           | A check keeps who wrote what its answer rests on, with the digest of the `provenance.json` it read                                   |
| Stored data          | Reads are hash-checked and decode within 256 MiB; storage that is a symbolic link is refused ([storage](docs/storage.md#guarantees)) |
| The network          | Text leaves the machine only to eGemma; `--offline` sends nothing                                                                    |
| Credentials          | The eGemma key is read from `EGEMMA_API_KEY_FILE` (or the variable) and sent only to the eGemma URL you configure                    |
| Deletion             | `delete` removes saved checks only, asks on a terminal, and `npm run demo -- --reset` replaces only a copy of the demo               |
| Native trim backends | `swift` and `metal` compile the sources in `src/models/native` with the local `swiftc` into `.deps/native`, and run that program     |

A bypass of any of these is in scope, as is a project directory crafted to make
Tendora write outside it, run code, or hang.

## Out of scope

eGemma itself (report it to its own repository), a reading that is wrong but
leads to no wrong answer, and an actor label: actors are labels, not verified
identities.
