/** Cross-check the native extractor against the pinned independent graph parser. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extractHrg, graphTerminals, boundaryValences } from '../../src/amr/hrg-decomposition.mjs';
import { penmanPython } from '../../src/models/graph-preparation.mjs';
const fixture = JSON.parse(
  await readFile(new URL('../support/qa-domain-fixtures.json', import.meta.url), 'utf8'),
);
const graphs = [];
for (const domain of ['engine', 'hand']) {
  const texts = new Set(fixture[domain].sources.map((s) => s.text));
  for (const text of texts) {
    const graph = fixture.graphs.find((g) => g.text === text).graph;
    const vertices = graph.nodes.map((n) => n.id),
      terminals = graphTerminals(graph);
    const extraction = extractHrg(vertices, terminals);
    graphs.push({
      id: text,
      domain,
      vertices,
      terminals,
      extraction,
      valences: boundaryValences(extraction),
    });
  }
}
const started = performance.now();
const result = JSON.parse(
  execFileSync(await penmanPython(), ['test/support/hrg-bolinas.py'], {
    input: JSON.stringify(graphs),
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  }),
);
result.processMs = performance.now() - started;
assert.equal(result.results.length, graphs.length);
assert(result.results.every((r) => r.recognized));
await mkdir('tmp/qa-grammar-research', { recursive: true });
await writeFile(
  'tmp/qa-grammar-research/native-bolinas.json',
  JSON.stringify(result, null, 2) + '\n',
);
console.log(
  `ok native Gildea extraction and boundary valences: Bolinas recognizes ${graphs.length}/${graphs.length} graphs using shared domain grammars (${Math.round(result.processMs)} ms including Python startup)`,
);
