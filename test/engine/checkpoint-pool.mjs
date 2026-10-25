/** Warming the checkpoint workers does not wait on a worker that ended while
 * its source records were sent, as starting their checkpoints does not
 * (review 2026-10-25, #14). */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  readyCheckpointWorkers,
  useCheckpointWorkers,
  warmCheckpoints,
} from '../../src/engine/checkpoint-pool.mjs';

useCheckpointWorkers(2);
await readyCheckpointWorkers();
// The workers end while the first record is sent to the first of them: a
// getter read when the record is copied to the worker (and once before, when
// it is named). The main thread then waits for them to end, and the records
// after it keep the sending going until their exits are handled.
let reads = 0;
const ending = {
  get text() {
    if (++reads === 2) {
      useCheckpointWorkers(0);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
    return 'The lift is inspected.';
  },
};
Object.defineProperty(ending, 'text', { enumerable: true });
const sources = [ending, ...Array.from({ length: 1200 }, (_, i) => ({ text: `Record ${i}.` }))];
const project = { path: '/nowhere/project.json', digest: 'revision' };
const warmed = warmCheckpoints(project, { sources }, { inputs: [] }).then(() => 'warmed');
assert.equal(
  await Promise.race([warmed, delay(5000).then(() => 'waiting')]),
  'warmed',
  'Warming does not wait on workers that ended',
);
assert(reads >= 2, 'The workers ended while records were sent');
console.log('ok checkpoint pool: warming skips a worker that ended while it was sent records');
