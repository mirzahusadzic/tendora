/**
 * The kept evidence is whole: each set holds the frames it should, every frame
 * has its records and its report, each file parses, every record was made under
 * the frame its report names, and every trial level a report reads has its
 * record. `recompute.mjs` then checks that Gadfly reads the same verdicts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../evidence/payments-demo/', import.meta.url));
// Tendora's and Gemma's reads of the 31 questions, and Gemma at temperature 0.
const sets = [
  { dir: root, frames: 62 },
  { dir: join(root, 'gemma-temperature-0'), frames: 31 },
];
const problems = [];
let frames = 0;
let records = 0;
for (const set of sets) {
  const where = set.dir.slice(root.length) || '.';
  const names = (folder, ending) =>
    existsSync(join(set.dir, folder))
      ? readdirSync(join(set.dir, folder))
          .filter((name) => name.endsWith(ending))
          .map((name) => name.slice(0, -ending.length))
      : [];
  const kept = { frames: names('frames', '.json'), runs: names('runs', '.jsonl'), reports: names('reports', '.json') };
  if (kept.frames.length !== set.frames) problems.push(`${where}: ${kept.frames.length} frames, ${set.frames} expected`);
  for (const folder of ['runs', 'reports'])
    for (const name of kept[folder]) if (!kept.frames.includes(name)) problems.push(`${where}/${folder}/${name}: no frame`);
  const read = (path, parse) => {
    try {
      return parse(readFileSync(join(set.dir, path), 'utf8'));
    } catch (error) {
      problems.push(`${where}/${path}: ${error.code === 'ENOENT' ? 'missing' : 'does not parse'}`);
      return null;
    }
  };
  for (const name of kept.frames) {
    frames += 1;
    read(`frames/${name}.json`, JSON.parse);
    const report = read(`reports/${name}.json`, JSON.parse);
    const lines = read(`runs/${name}.jsonl`, (text) =>
      text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    if (!report || !lines) continue;
    records += lines.length;
    if (report.frame !== name) problems.push(`${where}/reports/${name}.json: names the frame ${report.frame}`);
    if (!lines.length) problems.push(`${where}/runs/${name}.jsonl: no records`);
    if (lines.some((record) => record.frame !== report.hash))
      problems.push(`${where}/runs/${name}.jsonl: a record was made under another frame than its report's`);
    const made = new Set(lines.map((record) => `${record.input}/${record.trial}`));
    for (const finding of report.findings ?? [])
      for (const trial of Object.keys(finding.levels ?? {}))
        if (!made.has(`${finding.input}/${trial}`))
          problems.push(`${where}/reports/${name}.json: ${finding.input}/${trial} has no record`);
  }
}
if (problems.length) {
  console.error(`Kept evidence is not whole (${problems.length}):\n  ${problems.slice(0, 12).join('\n  ')}`);
  process.exit(1);
}
console.log(`ok evidence: ${frames} frames, ${records} records, each frame with its records and report`);
