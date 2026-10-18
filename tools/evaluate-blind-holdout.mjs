/** Separate post-freeze evaluation. Never writes the integration or its captures. */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateAccounting,
  json,
  parseOptions,
  sha256,
  verifyFrozenRun,
} from './support/blind-holdout.mjs';

export async function evaluateBlindHoldout({ run, oracle }) {
  // This must complete before even opening the oracle path.
  const verified = await verifyFrozenRun(run);
  const oracleBytes = await readFile(resolve(oracle));
  let oracleData;
  try {
    oracleData = JSON.parse(oracleBytes);
  } catch {
    throw new Error('Oracle must be valid JSON');
  }
  const evaluation = evaluateAccounting(verified.integration, oracleData);
  evaluation.frozenIntegrationSha256 = verified.freeze.integration.sha256;
  evaluation.oracleSha256 = sha256(oracleBytes);
  evaluation.evaluatedAt = new Date().toISOString();
  const path = join(verified.directory, 'evaluation.json');
  await writeFile(path, json(evaluation), { flag: 'wx' });
  return { path, counts: evaluation.counts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2), ['--run', '--oracle']);
    const result = await evaluateBlindHoldout({
      run: options['--run'],
      oracle: options['--oracle'],
    });
    console.log(`Evaluation: ${result.path}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
