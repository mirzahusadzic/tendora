/** This is a strict product gate, not an expected-failure regression. */
import assert from 'node:assert/strict';
import { captureHandContract } from '../../tools/capture-hand-contract.mjs';

const manifest = await captureHandContract();
assert.equal(
  manifest.status,
  'pass',
  `Hand contract is not accepted. Inspect ${manifest.output}/manifest.json and captures.html.\n` +
    manifest.criteria
      .map((c) => `${c.id}: ${c.status}: ${(c.failures ?? []).join(' ')}`)
      .join('\n'),
);
