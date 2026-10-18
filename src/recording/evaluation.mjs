/** Immutable evaluation: one recorded acquisition plus one authored knowledge revision. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { validateRecording } from './format.mjs';
import { evaluateAnswer } from './answers.mjs';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const readRecording = async (path) => JSON.parse(await readFile(path, 'utf8'));
export async function saveEvaluation(
  recordingPath,
  knowledge,
  projectRevision = null,
  read = readRecording,
) {
  const path = resolve(recordingPath),
    recording = validateRecording(await read(path));
  const body = {
    schema: 'tendora.evaluation',
    version: 2,
    recordingPath: path,
    recordingRevision: digest(recording),
    projectRevision,
    knowledge: structuredClone(knowledge ?? recording.knowledge ?? {}),
  };
  body.result = evaluateAnswer(recording, body.knowledge);
  const id = digest(body),
    evaluationPath = join(dirname(path), '.evaluations', `${id}.json`);
  const evaluation = { ...body, id };
  await mkdir(dirname(evaluationPath), { recursive: true });
  try {
    await writeFile(evaluationPath, JSON.stringify(evaluation, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(evaluationPath, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(evaluation))
      throw new Error('Evaluation identity conflict');
  }
  return { ...evaluation, path: evaluationPath };
}

export async function readEvaluation(path, read = readRecording) {
  const evaluation = JSON.parse(await readFile(path, 'utf8'));
  const { id, result, ...body } = evaluation;
  if (
    body.schema !== 'tendora.evaluation' ||
    ![1, 2].includes(body.version) ||
    digest(body.version === 1 ? body : { ...body, result }) !== id
  )
    throw new Error('Evaluation changed');
  const recording = validateRecording(await read(body.recordingPath));
  if (digest(recording) !== body.recordingRevision) throw new Error('Evaluation recording changed');
  if (body.version === 1 && digest(evaluateAnswer(recording, body.knowledge)) !== digest(result))
    throw new Error('Evaluation result changed; evaluate again');
  return { ...evaluation, path: resolve(path) };
}
