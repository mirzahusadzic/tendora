/** Diagnostic acceptance on the actual retained hand project, with no new acquisitions. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { relative, resolve, join } from 'node:path';
import { openProject, saveProject } from '../../src/project/authoring/project.mjs';
import { inputFromProject } from '../../src/engine/input.mjs';
import { prepareInquiry } from '../../src/engine/preparation.mjs';
import { checkAnswer } from '../../src/engine/answer.mjs';
import { recheckPartialContribution } from '../../src/engine/partial.mjs';
import { currentPartialContribution } from '../../src/project/authoring/partial.mjs';

if (!process.env.HAND_CONTRACT_SOURCE)
  throw new Error('Set HAND_CONTRACT_SOURCE to your retained hand project; it is not bundled.');
const original = resolve(process.env.HAND_CONTRACT_SOURCE);
const sourceHashes = async () => {
  const files = [];
  async function visit(path, top = false) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = join(path, entry.name),
        key = relative(original, child);
      if (entry.isDirectory() && (top ? ['engine', 'recordings'].includes(entry.name) : false))
        continue;
      if (entry.isFile() && entry.name.endsWith('.sqlite')) continue;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile())
        files.push(
          `${key}:${createHash('sha256')
            .update(await readFile(child))
            .digest('hex')}`,
        );
    }
  }
  await visit(original, true);
  return createHash('sha256').update(files.join('\n')).digest('hex');
};
const before = await sourceHashes();
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/partial-hand-'));
await cp(original, directory, {
  recursive: true,
  filter: (path) =>
    !path.endsWith('.sqlite') && !path.includes('/engine') && !path.includes('/recordings'),
});
const fetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('Real hand acceptance is frozen and offline');
};
try {
  let project = await openProject(directory);
  let contribution = project.data.contributions.find((entry) => entry.partial);
  const savedIds = contribution.partial.parts.map((part) => part.id).sort();
  assert.equal(savedIds.length, 2, 'The real project retains the observed two historical parts');
  assert.equal(contribution.partial.openings.length, 8);
  const ask = async (options) => {
    const input = await inputFromProject(project, {
      scopePlacementId: contribution.scopePlacementId,
      question: contribution.question.text,
    });
    const { records } = await prepareInquiry(input);
    assert(
      records.every((entry) => entry.graph),
      'Every input uses its actual retained acquisition',
    );
    const result = { inputs: records };
    return { input, result, answer: checkAnswer(project, input, result, options) };
  };
  const baseline = await ask({ partialCoverage: { targets: [] } });
  const replay = await ask();
  assert.equal(replay.answer.status, 'open');
  assert.equal(
    replay.answer.partial.parts.length,
    2,
    'Located replay recovers both proofs in the real corpus',
  );
  assert.equal(replay.answer.partial.openings.length, 8);
  const next = recheckPartialContribution(project, contribution.id, replay.input, replay.result);
  project = await saveProject(project, next.data);
  contribution = next.contribution;
  assert.deepEqual(
    contribution.partial.parts.map((part) => part.id).sort(),
    savedIds,
    'Migration keeps the historical identities after fresh proof',
  );
  assert(contribution.partial.parts.every((part) => part.current && part.supports[0].derivation));
  const openingIds = contribution.partial.aporias.map((opening) => opening.id).sort();
  await rm(join(directory, 'engine'), { recursive: true, force: true });
  project = await openProject(directory);
  contribution = project.data.contributions.find((entry) => entry.id === contribution.id);
  const cold = currentPartialContribution(project.data, contribution);
  assert.equal(cold.parts.filter((part) => part.current).length, 2);
  assert.deepEqual(cold.parts.map((part) => part.id).sort(), savedIds);
  assert.deepEqual(cold.aporias.map((opening) => opening.id).sort(), openingIds);
  assert(
    cold.parts.every(
      (part) =>
        part.evidenceHistory.at(-1).id ===
        contribution.partial.parts.find((entry) => entry.id === part.id).evidenceHistory.at(-1).id,
    ),
  );
  const reordered = structuredClone(project.data);
  for (const concept of reordered.concepts) concept.passages.reverse();
  project = await saveProject(project, reordered);
  const order = await ask();
  assert.equal(order.answer.partial.parts.length, 2);
  assert.deepEqual(
    order.answer.partial.contributions[0].partial.parts.map((part) => part.id).sort(),
    savedIds,
  );

  const source = contribution.partial.parts[0].sources[0];
  const changed = structuredClone(project.data);
  const placement = changed.placements.find((entry) => entry.id === source.nodeId);
  const concept = changed.concepts.find((entry) => entry.id === placement.conceptId);
  concept.passages = concept.passages.filter((text) => text !== source.text);
  project = await saveProject(project, changed);
  const removed = currentPartialContribution(project.data, contribution);
  assert.equal(removed.parts.filter((part) => part.current).length, 1);
  assert.equal(
    removed.parts.find((part) => part.id === contribution.partial.parts[0].id).current,
    false,
  );
  assert.deepEqual(removed.aporias.map((opening) => opening.id).sort(), openingIds);
  console.log(
    JSON.stringify({
      diagnostic: 'real-hand-partial-acceptance',
      inputs: replay.result.inputs.length,
      unseeded: {
        parts: baseline.answer.partial.parts.length,
        complete: baseline.answer.partial.complete,
        work: baseline.answer.partial.work,
      },
      locatedReplay: {
        parts: replay.answer.partial.parts.length,
        openings: replay.answer.partial.openings.length,
        complete: replay.answer.partial.complete,
        work: replay.answer.partial.work,
      },
      coldParts: cold.parts.filter((part) => part.current).length,
      afterSourceRemoval: removed.parts.filter((part) => part.current).length,
      remainingBound: replay.answer.partial.complete
        ? null
        : 'Partial HRG matching reached its 50000-work budget. Two witnessed parts are current; exhaustive coverage and the eight unresolved relations are not established.',
    }),
  );
} finally {
  globalThis.fetch = fetch;
  await rm(directory, { recursive: true, force: true });
  assert.deepEqual(await sourceHashes(), before, 'Original canonical project files are unchanged');
}
