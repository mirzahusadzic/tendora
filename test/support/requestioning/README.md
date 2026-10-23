# Requestioned development questions (data snapshot)

A frozen record of one blind requestioning run, kept as an example of the data
behind `requestioned-benchmark.json`. It is evidence, not a pipeline.

- `prompt.md`, `schema.json`, `packet.json`: the 25 development questions as
  sent (questions and case text only, neutral references), and the mapping back
  to their ids.
- `responses.json`, `events.jsonl`: the returned rewordings and the run's event
  log, which shows only the model's reply (no tool use).
- `meaning/`: a second, independent check that each rewording asks the same
  thing, from the original and reworded questions only.
- `review.json`: the decision for each rewording; one was kept only when no
  reviewer found a change in meaning (46 of 50 kept).

The benchmark manifest records the hashes of the packet, responses, events and
review. See [Where held-out answers are lost](../../../docs/held-out-diagnosis.md)
for the results.
