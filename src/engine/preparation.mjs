/** Normalize retained AMRs independently of optional correspondence search. */
import { prepareGraphs, normalizedRoleProfile } from '../models/graph-preparation.mjs';
import { validateGraph } from '../amr/revision.mjs';
import { propbankAuditor } from '../models/propbank.mjs';
import { lexicalAuditProfile } from '../amr/lexical-audit.mjs';
import { acquiredTexts } from '../project/storage/acquisitions.mjs';

/** Inspect an existing exact-text acquisition without acquisition or reasoning. */
export async function prepareRetainedReading(project, text, { signal } = {}) {
  const captures = await acquiredTexts(project, [text]);
  if (captures?.[0]?.status !== 'retained') return null;
  const prepared = await prepareGraphs([{ penman: captures[0].penman }], {
    profile: normalizedRoleProfile,
    signal,
  });
  const record = prepared.results[0];
  return {
    graph: record.ok ? validateGraph(record.graph) : null,
    readingError: record.ok ? null : record.diagnostics.map((item) => item.message).join('; '),
  };
}

/** Read-only vocabulary review for editor inspection of retained graphs. */
export async function retainedReadingAuditor() {
  const { audit } = await propbankAuditor();
  return audit;
}

export async function prepareInquiry(
  input,
  { signal, phase = async () => {}, prepare = prepareGraphs } = {},
) {
  await phase('prepare', 'Normalize the requested question, scoped sources and selected case');
  const entries = [...input.sources, ...input.cases, input.question];
  const records = entries.map((entry) => ({
    ...entry,
    graph: entry.acquisition?.status === 'missing' ? null : (entry.graph ?? null),
  }));
  const openings = [...(input.openings ?? [])];
  const available = records.filter((entry) => entry.acquisition?.status !== 'missing');
  const pending = available.filter((entry) => !entry.graph);
  for (const record of available.filter((entry) => entry.graph)) validateGraph(record.graph);
  for (let i = 0; i < pending.length; i += 128) {
    signal?.throwIfAborted();
    const batch = pending.slice(i, i + 128);
    const result = await prepare(
      batch.map((entry) => ({ penman: entry.acquisition?.penman ?? entry.penman })),
      { signal, profile: normalizedRoleProfile },
    );
    if (result.results?.length !== batch.length)
      throw new Error('Preparation response cohort mismatch');
    for (const [index, item] of result.results.entries()) {
      const record = batch[index];
      if (item.ok) Object.assign(record, item, { graph: validateGraph(item.graph) });
      else
        openings.push({
          id: `normalization:${record.id}`,
          kind: 'normalization',
          inputId: record.id,
          text: record.text,
          reason: item.diagnostics.map((item) => item.message).join('; '),
        });
    }
  }
  const auditable = records.filter((entry) => entry.graph && entry.text?.trim());
  let lexicalAudit = null;
  if (auditable.length) {
    await phase('vocabulary', 'Check acquired predicates against source words and PropBank');
    const started = performance.now();
    const { audit, source } = await propbankAuditor();
    const items = [];
    let predicates = 0;
    for (const record of auditable) {
      signal?.throwIfAborted();
      const result = audit(record.text, record.graph);
      record.lexicalAudit = result;
      predicates += result.checks.length;
      if (result.findings.length)
        items.push({
          inputId: record.id,
          kind: record.kind,
          text: record.text,
          findings: result.findings,
          candidates: result.candidates,
        });
    }
    lexicalAudit = {
      profile: lexicalAuditProfile,
      source,
      inputs: auditable.length,
      predicates,
      elapsedMs: performance.now() - started,
      items,
    };
  }
  return { records, openings, lexicalAudit };
}
