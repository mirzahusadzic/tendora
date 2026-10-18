/** Strict opt-in product gate: a failed or unexecuted requirement fails the profile. */
import assert from 'node:assert/strict';
import { captureTendoraContract } from '../../tools/capture-tendora-contract.mjs';

const manifest = await captureTendoraContract();
assert.equal(
  manifest.status,
  'pass',
  `Tendora contract is not accepted. Inspect ${manifest.output}/manifest.json and captures.html.\n` +
    manifest.failures
      .filter((failure) => failure.message)
      .map((failure) => failure.message)
      .join('\n') +
    '\n' +
    manifest.checks
      .filter((c) => c.status !== 'pass')
      .map((c) => `${c.id}: ${c.status}: ${JSON.stringify(c.detail)}`)
      .join('\n'),
);
