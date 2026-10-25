/** The tour's graphs are drawn from the bundled demo's saved checks: when the
 * demo changes, docs/demo.md is regenerated (node tools/demo-graphs.mjs
 * --write docs/demo.md), never edited by hand. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { graphs, withGraphs } from '../../tools/demo-graphs.mjs';

const tour = await readFile(new URL('../../docs/demo.md', import.meta.url), 'utf8');
assert.deepEqual(
  [...tour.matchAll(/<!-- graph: ([\w-]+) -->/gu)].map((match) => match[1]),
  Object.keys(graphs),
  'Every graph appears once, in order',
);
assert.equal(withGraphs(tour), tour, 'docs/demo.md shows the graphs the demo gives');
for (const graph of Object.values(graphs))
  assert.match(graph, /\nflowchart LR\n/u, 'Each reads left to right');
console.log('ok demo graphs: the tour shows what the bundled demo gives');
