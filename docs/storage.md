# Storage

A project is a directory. What an answer depends on is content-addressed and
hash-checked when read; what can be made again is marked so.

## Layout

| Path                      | Holds                                                                                                                   | Made again from              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `project.json`            | The manifest: id, name, the role tree, and the hashes of the concepts and records; its digest is the project's revision | nothing: authored            |
| `material.sqlite`         | Authored records, readings, questions and role vectors, as compressed, hash-checked blocks                              | readings and vectors: eGemma |
| `provenance.json`         | Optional declared authorship, by statement text                                                                         | nothing: authored            |
| `engine/artifacts.sqlite` | Saved checks: their inputs, results and runs, and compiled grammars                                                     | checking again               |
| `engine/active/`          | A lease for each check in progress                                                                                      | transient                    |
| `recordings/`             | Small handles to recordings kept in the artifact store                                                                  | checking again               |
| `*.lock`                  | A lease for a write in progress                                                                                         | transient                    |

## material.sqlite

Logical JSON files in five areas (`corpora/`, `records/`, `acquisitions/`,
`role-matching/`, `investigations/`), packed into blocks:

| Table    | Columns                     | Holds                                                                                            |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| `blocks` | `hash`, `payload`           | Up to 4 MiB of files as `[path, text]` pairs, Brotli; `hash` is the SHA-256 of the decoded bytes |
| `files`  | `path`, `block`, `checksum` | A logical file and its block                                                                     |

Role vectors are retained as files in `role-matching/`. The first time an
inquiry ranks roles, Tendora builds an index of them beside the two tables, so
a project that has never ranked roles, the bundled demo among them, has only
`blocks` and `files`:

| Table                | Columns                                                                      | Holds                                               |
| -------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `role_vector_models` | `id` (key), `profile`, `model`, `config`                                     | The embedding model and settings a vector came from |
| `role_vectors`       | `id` (key), `ref` (unique), `model_id`, `text`, `acquired`, `origin`, `slot` | A role text and where its vector came from          |
| `role_embeddings`    | `vec0(id, embedding float[128] distance_metric=cosine, chunk_size=8)`        | The vectors, in sqlite-vec                          |
| `role_vector_texts`  | `path` (key), `checksum`, `ref`                                              | Which retained text a vector is for                 |

Triggers on `files` drop a vector when the file it came from changes or goes,
so the index never outlives its source and can be rebuilt from the retained
vectors.

## engine/artifacts.sqlite

| Table       | Columns                     | Holds                                                                                                                 |
| ----------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `fragments` | `hash`, `payload`, `refs`   | A JSON value in parts of about 4 KB and up, Brotli, each named by the digest of its bytes: a shared part is kept once |
| `artifacts` | `hash`                      | The root fragment of each input, result or error                                                                      |
| `runs`      | `id`, `payload`, `checksum` | A saved check: question, scope, case, status, answer, provenance, actor and via, and its input and result             |
| `grammars`  | `key`, `ref`, `updated`     | A scope's compiled grammar, reused while its statements stay the same                                                 |

A saved check keeps the text of the statements it read and cites, with their
provenance, so it reads as it was after the statements change;
`material.sqlite` stays the authoritative copy of what was authored.
Compaction releases old checks to what they found (the question, its last
answer and an ambiguous check's candidates, the statements they rest on, and
its provenance). It keeps the latest check at the root role whole first, since
probes and corpus fidelity read it, then the newest checks while they fit.
`tendora delete` removes saved checks, and those copies with them.

## Guarantees

- **Checked reads:** a block, fragment or run whose bytes do not match its
  digest is refused.
- **Bounded reads:** a block, run or artifact decodes within 256 MiB, before
  its hash is checked; a write larger than that is refused.
- **Leases:** each write takes a lease, a regular file naming its process; a
  lease whose process is gone is cleared.
- **No links:** storage inside a project that is a symbolic link is refused;
  the project directory itself may be one.
- **Whole writes:** the manifest is written beside itself and renamed; a new
  project is refused where a project, or another project's storage, is.
- **Provenance kept:** a check keeps the provenance it answered with and the
  digest of the `provenance.json` it read.

## Embeddings

eGemma embeds a text as 768 numbers. Tendora keeps the first 128, renormalized
(enough to rank), with the model and its revision, and stores them as float32
in sqlite-vec.

| Embeddings         |                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------- |
| What they do       | Order a role's children by similarity to the question when an inquiry explores the role tree |
| What they never do | Answer, remove a branch, or connect statements: the engine reads AMR only                    |
| When they are made | On first need, retained by exact text; offline, only retained vectors are used               |
| Without them       | Roles keep their authored order, and the inquiry says so                                     |
