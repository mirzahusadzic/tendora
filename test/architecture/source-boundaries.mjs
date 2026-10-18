/** Enforce ownership, offline authoring and independent engine execution. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { sourceGraph, checkSourceGraph } from '../support/source-graph.mjs';
const root = new URL('../../src/', import.meta.url);
checkSourceGraph(await sourceGraph(root));
const forbiddenProductText =
  /(?:customer service|billing team|payout failure|login failure|online store|product questions|repairs bicycles|recognize intention|qa-domain-fixtures|qa-development-acquisitions|test\/support|tools\/projects|egemma\/\.venv)/iu;
for (const path of (await readdir(root, { recursive: true })).filter((path) =>
  /\.(?:mjs|py)$/u.test(path),
))
  assert.doesNotMatch(
    await readFile(new URL(path, root), 'utf8'),
    forbiddenProductText,
    `Product source contains project vocabulary, a test fixture or a checkout-specific dependency: ${path}`,
  );
const reject = (entries, pattern) =>
  assert.throws(() => checkSourceGraph(new Map(entries)), pattern);
reject([['amr/graph.mjs', ['node:fs']]], /independent of runtime adapters/);
reject([['recording/answers.mjs', ['./missing.mjs']]], /Missing module/);
reject(
  [
    ['recording/answers.mjs', ['../models/acquisition.mjs']],
    ['models/acquisition.mjs', []],
  ],
  /Invalid dependency/,
);
reject(
  [
    ['project/storage/objects.mjs', ['../authoring/project.mjs']],
    ['project/authoring/project.mjs', []],
  ],
  /Storage cannot invoke project workflows/,
);
reject(
  [
    ['project/authoring/project.mjs', ['../inquiries/inquiry.mjs']],
    ['project/inquiries/inquiry.mjs', []],
  ],
  /Authoring cannot invoke project workflows/,
);
reject(
  [
    ['engine/run.mjs', ['../project/inquiries/inquiry.mjs']],
    ['project/inquiries/inquiry.mjs', []],
  ],
  /Engine cannot depend on inquiry history/,
);
reject(
  [
    ['project/authoring/project.mjs', ['../../models/acquisition.mjs']],
    ['models/acquisition.mjs', []],
  ],
  /Authoring cannot execute acquisition or reasoning/,
);
reject(
  [
    ['tui/engine/controller.mjs', ['./view.mjs']],
    ['tui/engine/view.mjs', ['./controller.mjs']],
  ],
  /Module cycle/,
);
reject([['tui/forgotten.mjs', []]], /Unclassified TUI module/);
console.log('ok module boundaries, independent engine, offline authoring and acyclic imports');
