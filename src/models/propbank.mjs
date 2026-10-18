/** Local, hash-verified PropBank resource. No Python, network or model service. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createLexicalAuditor } from '../amr/lexical-audit.mjs';

let loading;
export function propbankAuditor() {
  return (loading ??= (async () => {
    const root = new URL('../../vendor/propbank/', import.meta.url);
    const [bytes, metadata] = await Promise.all([
      readFile(new URL('lexicon.json', root)),
      readFile(new URL('UPSTREAM.json', root), 'utf8'),
    ]);
    const manifest = JSON.parse(metadata);
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.indexSha256)
      throw new Error('PropBank lexical resource hash mismatch');
    const resource = JSON.parse(bytes);
    if (resource.schema !== 'propbank-lexicon-v1')
      throw new Error('Unknown PropBank lexicon schema');
    return {
      audit: createLexicalAuditor(resource),
      frames: resource.frames,
      source: { ...resource.source, indexSha256: manifest.indexSha256 },
    };
  })());
}
