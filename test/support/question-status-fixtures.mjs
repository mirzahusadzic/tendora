/** Declared symbolic readings exercise actual uncertainty outcomes without models.
 * These are deterministic engine fixtures, not claims about AMR acquisition.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, saveProject } from '../../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../../src/project/storage/acquisitions.mjs';
import { inputFromProject } from '../../src/engine/input.mjs';
import { runEngine } from '../../src/engine/run.mjs';

export async function questionStatusFixture(directory, status) {
  const alternatives = status === 'ambiguous';
  assert(alternatives || status === 'conflict');
  const sources = alternatives
    ? [
        [
          'The carpenter repairs bicycles.',
          '(r / repair-01 :ARG0 (p / carpenter) :ARG1 (b / bicycle))',
        ],
        [
          'The mechanic repairs bicycles.',
          '(r / repair-01 :ARG0 (p / mechanic) :ARG1 (b / bicycle))',
        ],
      ]
    : [
        [
          'The mechanic repairs bicycles.',
          '(r / repair-01 :ARG0 (p / mechanic) :ARG1 (b / bicycle))',
        ],
        [
          'The mechanic does not repair bicycles.',
          '(r / repair-01 :polarity - :ARG0 (p / mechanic) :ARG1 (b / bicycle))',
        ],
      ];
  const question = alternatives
    ? ['Who repairs bicycles?', '(r / repair-01 :ARG0 (u / amr-unknown) :ARG1 (b / bicycle))']
    : [
        'Does the mechanic repair bicycles?',
        '(r / repair-01 :polarity (u / amr-unknown) :ARG0 (p / mechanic) :ARG1 (b / bicycle))',
      ];
  let project = await createProject(join(directory, status), 'Workshop sources', 'Workshop');
  const data = structuredClone(project.data);
  data.concepts[0].passages = sources.map(([text]) => text);
  project = await saveProject(project, data);
  await retainAcquisitions(
    project,
    [...sources, question].map(([text, penman]) => ({
      text,
      penman,
      origin: {
        kind: 'declared-symbolic-test-reading',
        file: 'test/support/question-status-fixtures.mjs',
      },
    })),
  );
  const input = await inputFromProject(project, {
    scopePlacementId: project.data.placements[0].id,
    question: question[0],
  });
  const run = await runEngine(project, { input, trace: false });
  assert.equal(run.status, status, JSON.stringify(run.answer));
  assert.equal(run.answer.answers.length, 0);
  assert.deepEqual(
    new Set(run.answer.candidates.map((candidate) => candidate.text)),
    new Set(alternatives ? ['carpenter', 'mechanic'] : ['Yes', 'No']),
  );
  assert(run.answer.candidates.every((candidate) => candidate.sourceIds.length));
  assert.deepEqual(
    new Set(run.answer.sources.map((source) => source.text)),
    new Set(sources.map(([text]) => text)),
  );
  return { project, run, question: question[0], sources: sources.map(([text]) => text) };
}
