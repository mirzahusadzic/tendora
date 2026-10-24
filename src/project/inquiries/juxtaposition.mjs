/** What a checked question brings together in the role tree. At a chosen grain
 * (depth in the tree: 1 is the top-level sections), the statements its check
 * cites fall into branches:
 *
 *   quiet          it cites no statement
 *   branch         one branch
 *   juxtaposition  two or more; each pair is a tension line, resolved when
 *                  one answer composes statements from both, gathered when
 *                  each branch gives its own answers and none composes them,
 *                  open when only supported parts or possible answers reach
 *                  one of them
 *
 * Openings do not activate a branch: they name every statement where a
 * relation of the question occurs, however generic.
 *
 * Over every question, the tension lines are the opportunity tree: where the
 * corpus already joins its branches, and where a question met two and has not
 * been answered. Nothing is checked again; an open line is a place to ask or
 * to author, never an answer.
 */
import { recoilContext } from './recoil.mjs';

const questionPurposes = new Set(['inquiry', 'question-refresh']);

/** The branch of a placement at a grain: its ancestor at that depth, or the
 * placement itself when it sits above that depth; the root is no branch. */
export function branchAt(data, grain = 1) {
  const placements = new Map(data.placements.map((placement) => [placement.id, placement]));
  const depth = (id) => {
    let level = 0;
    for (let at = placements.get(id); at?.parentId; at = placements.get(at.parentId)) level++;
    return level;
  };
  return (placementId) => {
    let at = placements.get(placementId);
    if (!at || !at.parentId) return null;
    while (depth(at.id) > grain) at = placements.get(at.parentId);
    return at.id;
  };
}

/** A source identifier names its placement: `<placement>/s<n>`. */
const placementOf = (sourceId) => /^(.*)\/s\d+$/u.exec(sourceId)?.[1] ?? null;

export function activation(answer, branchOf) {
  const branches = (ids) =>
    new Set(ids.map((id) => branchOf(placementOf(id))).filter((branch) => branch !== null));
  const bindings = (answer.answers ?? []).map((binding) => branches(binding.sourceIds));
  const answered = new Set(bindings.flatMap((set) => [...set]));
  const reached = branches([
    ...(answer.candidates ?? []).flatMap((binding) => binding.sourceIds),
    ...(answer.partial?.parts ?? []).flatMap((part) => part.sourceIds ?? []),
  ]);
  const active = [...new Set([...answered, ...reached])].sort();
  const tensions = [];
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++)
      tensions.push({
        left: active[i],
        right: active[j],
        status: bindings.some((set) => set.has(active[i]) && set.has(active[j]))
          ? 'resolved'
          : answered.has(active[i]) && answered.has(active[j])
            ? 'gathered'
            : 'open',
      });
  return {
    effect: !active.length ? 'quiet' : active.length === 1 ? 'branch' : 'juxtaposition',
    branches: active,
    tensions,
  };
}

/** Every checked question's activation, and the tension lines between branches. */
export async function opportunityTree(project, { grain = 1, context = null } = {}) {
  const { data, digest, runs } = context ?? (await recoilContext(project));
  const branchOf = branchAt(data, grain);
  const concepts = new Map(data.concepts.map((concept) => [concept.id, concept]));
  const placements = new Map(data.placements.map((placement) => [placement.id, placement]));
  const name = (id) => concepts.get(placements.get(id)?.conceptId)?.name ?? id;
  // The latest current check of each question.
  const latest = new Map();
  for (const run of runs) {
    const text = run.questions?.[0]?.text;
    if (!text || !run.answer || run.projectDigest !== digest) continue;
    if (run.purpose && !questionPurposes.has(run.purpose)) continue;
    const key = JSON.stringify([
      text,
      run.scopePlacementId,
      run.caseSelection?.sources?.map((source) => source.text).join('\n') ?? null,
    ]);
    if (!latest.has(key) || latest.get(key).startedAt < run.startedAt) latest.set(key, run);
  }
  const questions = [...latest.values()].map((run) => ({
    question: run.questions[0].text,
    ...(run.caseSelection?.sources?.length
      ? { case: run.caseSelection.sources.map((source) => source.text).join(' ') }
      : {}),
    ...activation(run.answer, branchOf),
  }));
  const lines = new Map();
  for (const item of questions)
    for (const tension of item.tensions) {
      const key = JSON.stringify([tension.left, tension.right]);
      if (!lines.has(key))
        lines.set(key, {
          left: tension.left,
          right: tension.right,
          labels: [name(tension.left), name(tension.right)],
          resolved: [],
          gathered: [],
          open: [],
        });
      lines.get(key)[tension.status].push(item.question);
    }
  const effects = { quiet: 0, branch: 0, juxtaposition: 0 };
  for (const item of questions) effects[item.effect]++;
  return {
    grain,
    revision: digest,
    effects,
    tensions: [...lines.values()].sort(
      (a, b) =>
        b.resolved.length +
          b.gathered.length +
          b.open.length -
          (a.resolved.length + a.gathered.length + a.open.length) ||
        a.labels.join().localeCompare(b.labels.join()),
    ),
    questions,
  };
}
