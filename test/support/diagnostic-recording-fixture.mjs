/** Frozen symbolic graphs expose conditional saved-recording inspection pages.
 * No acquisition, accepted interpretation, or new inference capability is claimed.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareGraphs } from '../../src/models/graph-preparation.mjs';
import { retainedAcquisition } from '../../src/engine/input.mjs';
import { runCrossing } from '../../src/inquiry/cross-run.mjs';
import { recordRun } from '../../src/recording/format.mjs';

export async function diagnosticRecordingFixture(directory, project) {
  const query = 'Which unit should process this sample?';
  const declarations = [
    ['The container leaks.', '(l / leak-01 :ARG1 (c / container))'],
    [
      'The unit processes the container leak.',
      '(p / process-01 :ARG0 (u / unit) :ARG1 (l / leak-01 :ARG1 (c / container)))',
    ],
    [
      query,
      '(r / recommend-01 :ARG1 (p / process-01 :ARG0 (u / unit :mod (a / amr-unknown)) :ARG1 (s / sample)))',
    ],
    [
      'Which unit should process this leak?',
      '(r / recommend-01 :ARG1 (p / process-01 :ARG0 (u / unit :mod (a / amr-unknown)) :ARG1 (l / leak-01)))',
    ],
  ];
  const prepared = await prepareGraphs(declarations.map(([, penman]) => ({ penman })));
  const inputs = declarations.map(([text], index) => {
    const item = prepared.results[index];
    assert(item.ok);
    return { text, graph: item.graph, penman: item.penman };
  });
  const asset = {
    query,
    start: 'sample',
    project,
    caseState: { policy: 'ancestor-context-v1', rootNodeId: 'sample' },
    nodes: [
      { id: 'sample', label: 'Sample', sentences: [declarations[0][0]], crossings: ['unit'] },
      {
        id: 'unit',
        label: 'Processing unit',
        sentences: [declarations[1][0]],
        crossings: [],
        interpretationProposals: [{ source: 0, replace: { from: 'sample', to: 'leak' } }],
      },
    ],
  };
  const run = await runCrossing(asset, query, () => {}, undefined, {
    acquisition: retainedAcquisition({ inputs }),
  });
  const recording = recordRun(run, {
    assetBytes: JSON.stringify(asset),
    assetName: 'declared-diagnostic-context-and-proposal',
  });
  assert(recording.visits.some((visit) => visit.contextChecks?.length));
  assert.equal(recording.proposals.length, 1);
  const path = join(directory, 'context-proposal-recording.json');
  await writeFile(path, JSON.stringify(recording, null, 2) + '\n');
  return { recording, path, asset, declarations };
}
