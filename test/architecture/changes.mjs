/** A change reaches the suites that depend on it, through imports, URLs and
 * named repository paths; the runner, the suite list and the package reach all. */
import assert from 'node:assert/strict';
import { affectedSuites, formatTargets } from '../../tools/changes.mjs';
import { suites } from '../suites.mjs';

// Paths built from parts: a path named whole would make this suite depend on it.
const docs = ['docs', 'setup.md'].join('/');
const reached = (...changed) => affectedSuites(changed, suites.check).map(({ suite }) => suite);

const recoil = reached('src/project/inquiries/recoil.mjs');
assert(recoil.includes('project/recoil.mjs'), 'A module reaches the suite that imports it');
assert(!recoil.includes('tui/scale.mjs'), 'and not suites that never reach it');
const matcher = reached('src/amr/hrg-query.mjs');
assert(matcher.includes('acceptance/payments.mjs'), 'through the modules a suite reaches');
assert(matcher.includes('amr/hrg.mjs'));
const demo = reached('.proj/payments-on-call/material.sqlite');
assert(demo.includes('project/examples.mjs'), 'A named directory reaches its files');
assert(demo.includes('acceptance/payments.mjs'));
assert(!demo.includes('amr/hrg.mjs'));
assert(reached('test/engine/cloze.mjs').includes('engine/cloze.mjs'), 'A suite reaches itself');
assert.deepEqual(reached(docs), [], 'Documentation reaches no suite');
for (const path of ['test/run.mjs', 'test/suites.mjs', 'package.json', 'tools/changes.mjs'])
  assert.equal(reached(path).length, suites.check.length, `${path} reaches every suite`);
assert.deepEqual(
  formatTargets(['src/engine/cloze.mjs', 'tmp/x.mjs', 'notes/draft.md', docs]),
  ['src/engine/cloze.mjs', docs],
  'Only the files the format check covers',
);
console.log('ok changes reach their suites: imports, URLs, named paths; shared runner reaches all');
