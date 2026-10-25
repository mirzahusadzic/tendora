/** Statement provenance: an optional `provenance.json` beside a project's
 * manifest saying, per statement, who wrote it (`author`), who proposed it
 * when that was a model or another party (`proposer`), and whether and by whom
 * it was accepted (`accepted`). Other fields (a number, a section, a lineage)
 * are kept as given. A statement it does not list, or a project without it,
 * names no one: `unrecorded`. Authorship is declared, not verified.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sourceCatalog } from './sources.mjs';
import { refuseLinks } from '../storage/links.mjs';

export const provenanceFile = 'provenance.json';
const unrecorded = 'unrecorded';

export function validateProvenance(data) {
  if (data?.version !== 1 || !Array.isArray(data.statements))
    throw new Error('Statement provenance needs version 1 and a list of statements');
  const texts = new Set();
  for (const entry of data.statements) {
    if (typeof entry?.text !== 'string' || !entry.text.trim())
      throw new Error('A provenance entry needs the statement text');
    if (typeof entry.author !== 'string' || !entry.author.trim())
      throw new Error(`A provenance entry needs an author: ${entry.text}`);
    if (texts.has(entry.text)) throw new Error(`Provenance lists a statement twice: ${entry.text}`);
    texts.add(entry.text);
    if (
      entry.accepted != null &&
      (typeof entry.accepted.by !== 'string' || typeof entry.accepted.on !== 'string')
    )
      throw new Error(`An acceptance names who accepted and when: ${entry.text}`);
  }
  return data;
}

/** The project's statement provenance by text, or an empty one, and the
 * digest of the file it was read from (null without one). */
export async function declaredProvenance(project) {
  const path = join(dirname(project.path), provenanceFile);
  refuseLinks([path]);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: new Map(), digest: null };
    throw error;
  }
  const data = validateProvenance(JSON.parse(text));
  return {
    entries: new Map(data.statements.map((entry) => [entry.text, entry])),
    digest: createHash('sha256').update(text).digest('hex'),
  };
}

export const readProvenance = async (project) => (await declaredProvenance(project)).entries;

/** The authors recorded when statements were written, by the id a check cites
 * them with: a contribution's part, or a passage edited in the workbench; and
 * who confirmed a connection or declared a wording. What was written before
 * authors were recorded is not listed. */
export function recordedAuthors(data) {
  const recorded = new Map();
  const entry = ({ actor, via, at }) => ({ author: actor, via, ...(at ? { at } : {}) });
  for (const c of data.contributions ?? []) {
    for (const r of c.responses ?? [])
      if (r.actor) recorded.set(`contribution:${c.id}:${r.id}`, entry(r));
    // A confirmed connection is the confirmer's decision about a source; a
    // declared wording, its author's. Neither authors the source itself.
    for (const w of c.wordings ?? [])
      if (w.confirmation?.actor)
        recorded.set(`contribution:${c.id}:${w.id}`, {
          ...entry(w.confirmation),
          kind: 'confirmed connection',
        });
      else if (w.actor)
        recorded.set(`contribution:${c.id}:${w.id}`, { ...entry(w), kind: 'wording' });
  }
  for (const item of sourceCatalog(data))
    if (!item.development && item.actor)
      recorded.set(`${item.nodeId}/s${item.index + 1}`, entry(item));
  return recorded;
}

/** What an exported answer carries: the corpus it was checked against (its
 * id and the revision digest of the check; the digest of the declared file
 * when the caller read one) and the provenance of every statement its answers
 * rest on, in the order the answers name them. A recorded author comes first;
 * declared provenance adds what was not recorded (a proposer, an acceptance),
 * and a different declared author stays visible as `declaredAuthor`. A case
 * is the check's circumstance, not a statement: it names who made the check
 * (`checkedBy`). An ambiguous check's candidates are no answers: the
 * statements they rest on are listed apart, as `candidates`. */
export function answerProvenance(
  { projectId, projectRevision, declaredDigest, checkedBy = {} },
  provenance,
  answers,
  sources,
  recorded = new Map(),
  candidates = [],
) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const statement = (sourceId) => {
    const source = byId.get(sourceId),
      text = source?.text ?? null;
    if (source?.kind === 'case')
      return {
        sourceId,
        text,
        kind: 'case',
        author: checkedBy.actor ?? unrecorded,
        ...(checkedBy.via ? { via: checkedBy.via } : {}),
      };
    const { text: _text, ...declared } = (text !== null && provenance.get(text)) || {};
    const own = recorded.get(sourceId);
    return {
      sourceId,
      text,
      ...declared,
      ...(own ?? {}),
      ...(own && declared.author && declared.author !== own.author
        ? { declaredAuthor: declared.author }
        : {}),
      author: own?.author ?? declared.author ?? unrecorded,
    };
  };
  const cited = (items) => [...new Set((items ?? []).flatMap((item) => item.sourceIds ?? []))];
  const fromCandidates = cited(candidates).map(statement);
  return {
    projectId,
    projectRevision,
    ...(declaredDigest !== undefined ? { declaredDigest } : {}),
    statements: cited(answers).map(statement),
    ...(fromCandidates.length ? { candidates: fromCandidates } : {}),
  };
}

/** The provenance a check keeps when it answers: who was recorded and declared
 * then, so a later edit to `provenance.json` or to the statements cannot
 * change what an answer already given rests on. */
export async function checkProvenance(project, run, sources) {
  const declared = await declaredProvenance(project);
  return answerProvenance(
    {
      projectId: run.projectId,
      projectRevision: run.projectDigest,
      declaredDigest: declared.digest,
      checkedBy: { actor: run.actor, via: run.via },
    },
    declared.entries,
    run.answer?.answers,
    sources,
    recordedAuthors(project.data),
    run.answer?.candidates,
  );
}
