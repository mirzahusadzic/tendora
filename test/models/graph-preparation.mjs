import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareGraphs,
  penmanPython,
  preparationUsage,
} from '../../src/models/graph-preparation.mjs';
import { evaluateAnswer } from '../../src/recording/answers.mjs';
import { graphLiterals } from '../../src/amr/literals.mjs';
import { canonicalRelation } from '../../src/amr/roles.mjs';

const configuredPython = process.env.PENMAN_PYTHON;
try {
  process.env.PENMAN_PYTHON = 'explicit-python';
  assert.equal(await penmanPython(), 'explicit-python');
} finally {
  if (configuredPython === undefined) delete process.env.PENMAN_PYTHON;
  else process.env.PENMAN_PYTHON = configuredPython;
}

const directory = await mkdtemp(join(tmpdir(), 'penman-transport-'));
try {
  await assert.rejects(
    prepareGraphs([], { python: join(directory, 'missing') }),
    /PENMAN unavailable:.*ENOENT.*npm run setup:python/u,
  );
  const interpreter = join(directory, 'python');
  const fail = async (stdout, stderr) => {
    await writeFile(
      interpreter,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => {\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(1);\n});\n`,
      { mode: 0o700 },
    );
    return prepareGraphs([], { python: interpreter });
  };
  await assert.rejects(
    fail('', "Traceback:\nModuleNotFoundError: No module named 'penman'\n"),
    (error) =>
      /No module named 'penman'.*npm run setup:python/u.test(error.message) &&
      !/Unexpected end|Traceback/u.test(error.message),
  );
  await assert.rejects(
    fail(JSON.stringify({ error: "No module named 'amr_normalization'" }), ''),
    /No module named 'amr_normalization'.*npm run setup:python/u,
  );
  await assert.rejects(
    fail('{', 'Runtime failed before a response'),
    /PENMAN preparation failed: Runtime failed before a response/u,
  );
  // One process serves every request on an interpreter. A cancelled request
  // stops it; another request it held fails with an error of its own, not
  // with that cancellation.
  const silent = join(directory, 'silent');
  await writeFile(silent, '#!/usr/bin/env node\nprocess.stdin.resume();\n', { mode: 0o700 });
  process.env.PENMAN_PYTHON = silent;
  try {
    const first = new AbortController();
    const cancelled = prepareGraphs([{ penman: '(a / alpha)' }], { signal: first.signal });
    const other = prepareGraphs([{ penman: '(b / beta)' }]);
    await new Promise((resolve) => setImmediate(resolve));
    first.abort();
    await assert.rejects(cancelled, /abort/iu);
    await assert.rejects(other, /PENMAN preparation stopped: another request was cancelled/u);
  } finally {
    if (configuredPython === undefined) delete process.env.PENMAN_PYTHON;
    else process.env.PENMAN_PYTHON = configuredPython;
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

let available = true;
try {
  await prepareGraphs([]);
} catch (error) {
  if (!/No module named 'penman'|ENOENT/u.test(error.message)) throw error;
  available = false;
  console.log('skip local PENMAN checks: run npm run setup:python or set PENMAN_PYTHON');
}
if (available) {
  const inputs = [
    {
      penman:
        '# ::id source\n# ::tok The boy may go .\n(p / possible-01 :ARG1 (g / go-01 :ARG0 (b / boy~e.1)))',
      operations: [{ kind: 'reroot', node: 'g' }, { kind: 'relabel' }],
    },
    { penman: '(g / go-01 :ARG0 (b / boy))' },
    { penman: '(c / chapter :mod 7)', operations: [{ kind: 'reify' }, { kind: 'dereify' }] },
    { penman: '(n / name :op1 "3")', operations: [{ kind: 'reify-attributes' }] },
    { penman: '(x / dog :invented-role (y / cat))' },
    { penman: '(unclosed / graph' },
  ];
  const batch = await prepareGraphs(inputs);
  assert.equal(batch.results.length, inputs.length);
  assert(
    batch.results.slice(0, 4).every((result) => result.ok),
    JSON.stringify(batch),
  );
  assert(batch.results.slice(4).every((result) => !result.ok));
  const [possible, query, roundTrip] = batch.results;
  assert.notEqual(possible.graph.top, possible.graph.assertionTop);
  assert.equal(possible.metadata.id, 'source');
  assert.equal(possible.alignments.length, 1);
  const recording = {
    inquiry: { text: 'Does the boy go?', graphId: 'q' },
    graphs: [
      { ...query.graph, id: 'q' },
      { ...possible.graph, id: 's' },
    ],
    sources: [{ id: 'source', nodeId: 'case', graphId: 's', text: 'The boy may go.' }],
  };
  assert.equal(
    evaluateAnswer(recording).status,
    'open',
    'A display root cannot assert an embedded possible event',
  );
  assert(roundTrip.graph.edges.some((edge) => edge.role === ':mod'));
  assert(roundTrip.graph.nodes.some((node) => node.literal === '7'));
  const renamed = batch.results[3];
  assert(
    renamed.graph.nodes.some((node) => node.concept === '"3"'),
    'Attribute reification preserves a quoted numeric string',
  );
  // A reading prepared once in this process is not sent again, a new one goes
  // to the same open process, and both read as a fresh process reads them.
  const before = preparationUsage();
  const again = await prepareGraphs([inputs[1], { penman: '(d / dance-01 :ARG0 (b / boy))' }]);
  const used = preparationUsage();
  assert.equal(used.reused - before.reused, 1, 'The prepared reading is reused');
  assert.equal(used.sent - before.sent, 1, 'Only the new reading is sent');
  assert.equal(used.servers, before.servers, 'The open preparation process serves it');
  assert.deepEqual(again.results[0], query);
  const fresh = await prepareGraphs([{ penman: '(d / dance-01 :ARG0 (b / boy))' }], {
    python: await penmanPython(),
  });
  assert.deepEqual(again.results[1], fresh.results[0]);
  const roles = await prepareGraphs([], { roles: [':ARG0-of', ':consist-of', ':mod-of'] });
  assert.deepEqual(roles.roles[':ARG0-of'], { role: ':ARG0', inverse: true });
  assert.deepEqual(roles.roles[':consist-of'], { role: ':consist-of', inverse: false });
  assert.deepEqual(roles.roles[':mod-of'], { role: ':domain', inverse: false });
  const roleInputs = [
    ':ARG0',
    ':ARG9',
    ':op1',
    ':op12',
    ':snt1',
    ':instance',
    ':mod',
    ':domain',
    ':location',
    ':consist-of',
    ':prep-on-behalf-of',
    ':prep-out-of',
    ':custom-role',
  ];
  const variations = roleInputs.flatMap((role) =>
    Array.from({ length: 5 }, (_, index) => role + '-of'.repeat(index)),
  );
  const modelRoles = await prepareGraphs([], { roles: variations });
  for (const role of variations) {
    const prepared = modelRoles.roles[role];
    assert.deepEqual(
      canonicalRelation(['from', role, 'to']),
      prepared.inverse ? ['to', prepared.role, 'from'] : ['from', prepared.role, 'to'],
      role,
    );
  }
  assert.deepEqual(canonicalRelation(['from', '@source', 'to']), ['from', '@source', 'to']);
  await assert.rejects(prepareGraphs(Array(129).fill(inputs[1])), /128/);
  const invalid = await prepareGraphs([
    { penman: '(x / dog)', operations: [{ kind: 'reroot', node: 'missing' }] },
  ]);
  assert(!invalid.results[0].ok);

  const sentence =
    '# ::tok I never missed a day of school .\n(m / miss-01 :ARG0~e.0 (i / i~e.0) :ARG1 (d / day :part-of (s / school)) :polarity -)';
  const representations = await prepareGraphs([
    { penman: sentence },
    {
      penman: sentence,
      operations: [
        { kind: 'reroot', node: 'd' },
        { kind: 'relabel' },
        { kind: 'reorder' },
        { kind: 'reconfigure' },
      ],
    },
    { penman: sentence, operations: [{ kind: 'indicate-branches' }] },
  ]);
  assert(
    representations.results.every((item) => item.ok),
    JSON.stringify(representations),
  );
  for (const item of representations.results) {
    const graph = item.graph;
    assert(
      !graph.edges.some((edge) => edge.role === ':TOP'),
      'Layout branches are excluded from semantic evidence',
    );
    assert.equal(item.alignments.length, 2);
    const material = {
      inquiry: { text: 'Did I never miss a day of school?', graphId: 'query' },
      graphs: [
        { ...representations.results[0].graph, id: 'query' },
        { ...graph, id: 'school' },
      ],
      sources: [
        {
          id: 'school-source',
          nodeId: 'case',
          graphId: 'school',
          text: 'I never missed a day of school.',
        },
      ],
    };
    const result = evaluateAnswer(material);
    assert.equal(result.status, 'supported');
    assert.deepEqual(result.answers[0].sourceIds, ['school-source']);
    const normalized = (await prepareGraphs([{ graph, originalPenman: item.penman }])).results[0];
    assert.deepEqual(normalized.graph, graph, 'Normalization is idempotent');
  }

  const escaped = { id: 'literal:0', concept: 'a\\nb' };
  assert.equal(
    graphLiterals(
      { nodes: [escaped] },
      { triples: [{ relation: ':op1', target: '"a\\nb"', target_kind: 'literal' }] },
    ).get(escaped.id),
    '"a\\nb"',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareGraphs(inputs, { signal: controller.signal }), /abort/iu);
  // Cancelled while the interpreter is found, before the request is sent: it
  // settles with its cancellation (it once waited forever) and the shared
  // process keeps serving.
  const servers = preparationUsage().servers;
  const late = new AbortController();
  const cancelled = prepareGraphs([{ penman: '(c / cancel-01 :ARG1 (r / request))' }], {
    signal: late.signal,
  });
  late.abort();
  let waited;
  await assert.rejects(
    Promise.race([
      cancelled,
      new Promise((_, reject) => {
        waited = setTimeout(() => reject(new Error('The cancelled request never settled')), 5000);
      }),
    ]),
    /abort/iu,
  );
  clearTimeout(waited);
  assert.equal((await prepareGraphs([{ penman: '(s / serve-01)' }])).results.length, 1);
  assert.equal(preparationUsage().servers, servers, 'The shared process was not closed');

  const typed = await prepareGraphs([
    { penman: '(n / name :op1 3)' },
    { penman: '(n / name :op1 "3")' },
  ]);
  assert.deepEqual(
    new Set(
      typed.results.flatMap((item) =>
        item.graph.nodes.filter((node) => node.literal !== undefined).map((node) => node.literal),
      ),
    ),
    new Set(['3', '"3"']),
  );
  console.log(
    'ok PENMAN preserves references, modal assertion, literals and normalization origins',
  );
}
