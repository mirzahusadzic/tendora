/**
 * Gadfly reads every kept verdict again from its frame and records: each
 * report `gadfly report FRAME RECORDS --json` writes equals the kept one, apart
 * from the reader's name (`reader`), which Gadfly's Tendora integration adds.
 *   GADFLY="uvx --from midwife==0.5.0 gadfly" node test/acceptance/recompute.mjs
 * GADFLY defaults to `gadfly` on PATH. No engine, model or network is used.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../evidence/payments-demo/', import.meta.url));
const [command, ...prefix] = (process.env.GADFLY ?? 'gadfly').split(' ').filter(Boolean);
const differ = [];
let read = 0;
for (const dir of [root, join(root, 'gemma-temperature-0')])
  for (const frame of readdirSync(join(dir, 'frames')).filter((name) => name.endsWith('.json'))) {
    const name = frame.slice(0, -'.json'.length);
    const run = spawnSync(
      command,
      [...prefix, 'report', join(dir, 'frames', frame), join(dir, 'runs', `${name}.jsonl`), '--json'],
      { encoding: 'utf8' },
    );
    if (run.error || run.status !== 0) {
      console.error(`gadfly report failed on ${name}: ${run.error?.message ?? run.stderr.trim()}`);
      process.exit(2);
    }
    const { reader, ...kept } = JSON.parse(readFileSync(join(dir, 'reports', `${name}.json`), 'utf8'));
    if (!isDeepStrictEqual(JSON.parse(run.stdout), kept)) differ.push(`${dir.slice(root.length) || '.'}/${name}`);
    read += 1;
  }
if (differ.length) {
  console.error(`Gadfly reads ${differ.length} of ${read} reports differently:\n  ${differ.join('\n  ')}`);
  process.exit(1);
}
console.log(`ok recompute: Gadfly reads all ${read} kept reports the same`);
