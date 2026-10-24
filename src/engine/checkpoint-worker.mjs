/** A worker thread that checks role checkpoints for the question's thread. It
 * keeps the source records it was sent, by their content, so a question at
 * the same revision sends only their names, and the bases it built. */
import { parentPort } from 'node:worker_threads';
import { openProject } from '../project/authoring/project.mjs';
import { knowledgeSnapshot } from '../project/authoring/knowledge.mjs';
import { checkCheckpoint, explorationPlan, explorationViews } from './role-exploration.mjs';
import { answerRecording } from './answer.mjs';

const items = new Map();
let opened = null;
async function projectAt(path, digest) {
  if (opened?.path !== path || opened.project.digest !== digest) {
    const project = await openProject(path);
    opened = { path, project, knowledge: knowledgeSnapshot(project.data) };
  }
  if (opened.project.digest !== digest) throw new Error('The project changed');
  parentPort.postMessage({ opened: digest });
  return opened;
}
// A question's exploration as sent: its records restored, its views made.
async function explorationOf(task) {
  const { project, knowledge } = await projectAt(task.path, task.digest);
  const input = { ...task.input, sources: restore(task.input.sources) };
  const result = { ...task.result, inputs: restore(task.result.inputs) };
  const exploration = explorationPlan(input, result);
  const options = { grammarCache: {}, knowledge };
  options.supplied = explorationViews(project, input, result, exploration, options);
  return { project, input, result, exploration, options };
}
const restore = (keys) =>
  keys.map((key) => {
    if (!items.has(key)) throw new Error('A source record was not sent');
    return items.get(key);
  });

parentPort.on('message', async (task) => {
  if (task.kind === 'forget') return items.clear();
  if (task.kind === 'items') {
    for (const [key, item] of task.items) items.set(key, item);
    return;
  }
  if (task.kind === 'warm') {
    // The base of every source, built before the next question needs it.
    try {
      const { project, input, result, exploration, options } = await explorationOf(task);
      const { allSources, context } = exploration;
      options.supplied.of(
        answerRecording(
          project,
          { ...input, sources: allSources },
          { ...result, inputs: [...allSources, ...context] },
        ),
      );
    } catch {
      // A worker that cannot warm is not used at this revision.
    }
    return parentPort.postMessage({ warmed: task.digest });
  }
  const counter = new Int32Array(task.counter);
  try {
    const { project, input, result, exploration, options } = await explorationOf(task);
    for (;;) {
      if (Atomics.load(counter, 1)) break;
      const at = Atomics.add(counter, 0, 1);
      if (at >= task.levels.length) break;
      const level = task.levels[at];
      parentPort.postMessage({ id: task.id, claimed: level });
      try {
        const { check } = checkCheckpoint(project, input, result, exploration, level, options);
        parentPort.postMessage({ id: task.id, level, check });
      } catch (error) {
        parentPort.postMessage({ id: task.id, level, error: error.message });
      }
    }
  } catch (error) {
    parentPort.postMessage({ id: task.id, error: error.message });
  }
  parentPort.postMessage({ id: task.id, done: true });
});
parentPort.postMessage({ ready: true });
