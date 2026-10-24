/** Statement provenance: an optional `provenance.json` beside a project's
 * manifest saying, per statement, who wrote it (`author`), who proposed it
 * when that was a model or another party (`proposer`), and whether and by whom
 * it was accepted (`accepted`). Other fields (a number, a section, a lineage)
 * are kept as given. A statement it does not list, or a project without it,
 * names no one: `unrecorded`. Authorship is declared, not verified.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

/** The project's statement provenance by text, or an empty one. */
export async function readProvenance(project) {
  let text;
  try {
    text = await readFile(join(dirname(project.path), provenanceFile), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  const data = validateProvenance(JSON.parse(text));
  return new Map(data.statements.map((entry) => [entry.text, entry]));
}

/** What an exported answer carries: the corpus it was checked against (its
 * id and the revision digest of the check) and the provenance of every
 * statement its answers rest on, in the order the answers name them. */
export function answerProvenance({ projectId, projectRevision }, provenance, answers, sources) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const seen = new Set(),
    statements = [];
  for (const answer of answers ?? [])
    for (const sourceId of answer.sourceIds ?? []) {
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      const text = byId.get(sourceId)?.text ?? null;
      const { text: _text, ...entry } = (text !== null && provenance.get(text)) || {
        author: unrecorded,
      };
      statements.push({ sourceId, text, ...entry });
    }
  return { projectId, projectRevision, statements };
}
