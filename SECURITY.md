# Security

This repository holds Tendora's engine as a bundle (`dist/`), the payments demo, the evidence and the essay's helper.

## Reporting

Report a problem privately through GitHub: the repository's **Security** tab, **Report a vulnerability**. Please do not open a public issue. Say what you ran, what happened and what an attacker would gain; a reproduction on a copy of the demo is ideal. Remove keys, tokens and paths that say more than they need to.

## In scope

| Area | What Tendora promises |
| ---- | --------------------- |
| Answers | Only what the statements support; a question is never its own evidence |
| The server (`npm run serve`) | Listens on loopback only; `POST /ask` answers against the statements it is given and saves nothing |
| Network | Text leaves the machine only to the eGemma you configure, for a reading not yet retained; `--offline` sends nothing |
| Evidence | Each frame and record is as Gadfly wrote it. Tendora's reports are plain `gadfly report --json` output; the Gemma reports were written by Gadfly's Tendora integration, which adds the reader's name (`reader`); `gadfly report` recomputes every one. A record keeps at most the first 2,000 characters of each reply (`raw`) |

Out of scope: eGemma, Gadfly and SEMCAT, which have their own repositories, and anything you expose beyond loopback yourself.
