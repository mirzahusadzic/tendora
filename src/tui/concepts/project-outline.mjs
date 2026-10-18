/** Navigate authored concepts, saved interpretations and engine evidence. */
import { projectTree } from '../../project/authoring/project.mjs';
import { readableScopeLabel } from '../../project/inquiries/scope.mjs';
import { branch } from '../shell/tree.mjs';
import { developedConcepts } from '../../engine/concepts.mjs';
import { contributionTitle } from '../../project/authoring/development.mjs';
const empty = Object.freeze([]);
const cache = new WeakMap();
const assessedState = {
  running: 'Assessment running',
  supported: 'Supported by the corpus',
  conditional: 'Supported when its conditions hold',
  open: 'Not established by the corpus',
  ambiguous: 'Several answers remain possible',
  conflict: 'Saved contributions conflict',
  'needs-amr': 'Needs a retained language reading',
  'invalid-amr': 'Language reading could not be used',
  limited: 'Assessment reached a limit',
  failed: 'Assessment failed',
  cancelled: 'Assessment cancelled',
  interrupted: 'Assessment interrupted',
  stale: 'Assessment belongs to an earlier project revision',
};
function summarizeDevelopment(item, projectDigest) {
  const run =
    item.latestRun &&
    !item.latestRun.semantic &&
    item.latestRun.status !== 'stale' &&
    !(
      item.latestRun.purpose === 'question-refresh' &&
      ['cancelled', 'interrupted'].includes(item.latestRun.status)
    ) &&
    (!projectDigest || item.latestRun.projectDigest === projectDigest)
      ? item.latestRun
      : null;
  item.currentRun = run;
  if (run) {
    item.materialState = assessedState[run.status] ?? `Assessment: ${run.status}`;
    item.stateTone = [
      'open',
      'ambiguous',
      'conflict',
      'failed',
      'limited',
      'needs-amr',
      'invalid-amr',
      'cancelled',
      'interrupted',
      'stale',
    ].includes(run.status)
      ? 'warning'
      : 'plain';
    item.nextAction =
      run.status === 'running'
        ? 'Wait for the assessment to finish.'
        : ['supported', 'conditional'].includes(run.status)
          ? 'Inspect its supporting material or ask a follow-up question.'
          : ['open', 'ambiguous', 'conflict'].includes(run.status)
            ? 'Review the missing connections, then develop one or add supporting material.'
            : 'Review the assessment details, then run the saved question again.';
    return;
  }
  if (item.kind !== 'corpus-contribution') {
    item.materialState = item.latestRun ? 'Check pending' : 'Saved question has not been assessed';
    item.stateTone = 'warning';
    item.nextAction = 'Open the question to check the current corpus.';
    return;
  }
  const responses = item.entry.responses.filter((response) => !response.withdrawn),
    unresolved = responses.some((response) => response.composition?.connection === 'unresolved');
  item.materialState = !item.entry.question
    ? 'Saved corpus material'
    : !responses.length
      ? 'Open question with no answer saved'
      : unresolved
        ? 'Saved observation with an open connection'
        : item.latestRun
          ? 'Check pending'
          : 'Not assessed';
  item.stateTone = item.entry.question ? 'warning' : 'plain';
  item.nextAction = !item.entry.question
    ? 'Ask a question about this material.'
    : !responses.length
      ? 'Add an answer or develop the question from a related concept.'
      : unresolved
        ? 'Develop the open connection or add a clearer supporting statement.'
        : 'Open this question to check it against the current corpus.';
}
function flatten(roots, expanded) {
  const items = [],
    pending = roots.slice().reverse();
  while (pending.length) {
    const item = pending.pop();
    items.push(item);
    if (!expanded || expanded.has(item.id)) {
      for (let i = (item.children?.length ?? 0) - 1; i >= 0; i--) pending.push(item.children[i]);
    }
  }
  return items;
}
export function projectOutlineIndex(data, engineRuns = empty, projectDigest = null) {
  const saved = cache.get(data);
  if (saved?.engineRuns === engineRuns && saved.projectDigest === projectDigest) return saved.index;
  const entries = new Map(),
    roots = [],
    development = [],
    questions = new Map();
  const questionKey = (scope, text) => JSON.stringify([scope, text.trim()]);
  for (const { placement, concept, depth } of projectTree(data)) {
    const item = {
      id: placement.id,
      parentId: placement.parentId,
      placementId: placement.id,
      conceptId: concept.id,
      kind: concept.workspace ? 'workspace' : 'concept',
      label: concept.workspace ? 'No concepts yet' : readableScopeLabel(concept.name),
      description: concept.description,
      depth,
      children: [],
    };
    entries.set(item.id, item);
    if (item.parentId) entries.get(item.parentId).children.push(item);
    else roots.push(item);
  }
  for (const c of data.contributions ?? []) {
    if (!entries.has(c.scopePlacementId)) continue;
    const item = {
      id: `${c.scopePlacementId}/contribution/${c.id}`,
      placementId: c.scopePlacementId,
      kind: 'corpus-contribution',
      label: contributionTitle(c),
      section: c.question ? 'Questions' : 'Corpus material',
      depth: 0,
      children: [],
      readOnly: false,
      entry: c,
      runs: [],
    };
    entries.set(item.id, item);
    development.push(item);
    for (const text of [
      c.question?.text,
      ...c.wordings.filter((w) => !w.withdrawn).map((w) => w.text),
    ]) {
      if (!text) continue;
      const key = questionKey(c.scopePlacementId, text);
      if (!questions.has(key)) questions.set(key, []);
      if (!questions.get(key).includes(item)) questions.get(key).push(item);
    }
  }
  const asked = [];
  // A result belongs to its question. Repeated runs and cases remain in history,
  // rather than becoming additional rows beside the authored question.
  for (const run of [...engineRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const id = run.scopePlacementId;
    if (!entries.has(id)) continue;
    const key = questionKey(id, run.questions?.[0]?.text ?? run.id);
    if (!questions.has(key)) {
      if (run.purpose === 'contribution-assessment') continue;
      const item = {
        id: id + '/engine-run/' + run.id,
        placementId: id,
        kind: 'engine-run',
        label: run.questions?.[0]?.text ?? run.id,
        section: 'Questions',
        depth: 0,
        children: [],
        readOnly: true,
        entry: run,
        runs: [],
      };
      entries.set(item.id, item);
      questions.set(key, [item]);
      asked.push(item);
    }
    for (const item of questions.get(key)) {
      item.runs.unshift(run);
      item.latestRun = run;
      if (item.kind === 'engine-run') item.entry = run;
    }
  }
  development.push(...asked);
  for (const item of development) summarizeDevelopment(item, projectDigest);
  for (const entry of data.interpretationMappings ?? []) {
    const id = entry.origin?.scope?.nodeId;
    if (!entries.has(id)) continue;
    const item = {
      id: id + '/mapping/' + entry.id,
      placementId: id,
      kind: 'mapping',
      label: entry.name,
      section: 'Saved interpretations',
      depth: 0,
      children: [],
      readOnly: true,
      entry,
      materialState: 'Saved interpretation',
      stateTone: 'plain',
      nextAction: 'Inspect this interpretation or ask a question that uses it.',
    };
    entries.set(item.id, item);
    development.push(item);
  }
  const material = developedConcepts(data);
  const addMaterial = (node, parentId, depth) => {
    const item = { ...node, parentId, depth, children: [] };
    entries.set(item.id, item);
    item.children = node.children.map((child) => addMaterial(child, item.id, depth + 1));
    return item;
  };
  for (const node of material.roots) {
    const scope = entries.get(node.placementId);
    if (scope) scope.children.push(addMaterial(node, scope.id, scope.depth + 1));
  }
  // Empty organizational shells are workspace context, not concepts discovered in meaning.
  // Existing authored concepts with descriptions, sources or authored children remain visible.
  const conceptRoots = roots.flatMap((root) => {
    const concept = data.concepts.find((c) => c.id === root.conceptId);
    if (
      (concept.workspace && root.children.length) ||
      (!concept.passages.length &&
        !concept.description &&
        root.children.length &&
        root.children.every((c) => c.kind === 'material-concept'))
    ) {
      const lift = (item, parentId, depth) => {
        item.parentId = parentId;
        item.depth = depth;
        for (const child of item.children) lift(child, item.id, depth + 1);
      };
      for (const child of root.children) lift(child, null, 0);
      return root.children;
    }
    return [root];
  });
  const linked = new Map();
  for (const item of development) {
    const ids = new Set(item.kind === 'corpus-contribution' ? [item.entry.id] : []);
    if (item.latestRun) {
      const run = item.latestRun;
      for (const c of data.contributions ?? []) {
        const prefix = `contribution:${c.id}:`;
        if (
          run.answer?.answers?.some((a) => a.sourceIds?.some((s) => s.startsWith(prefix))) ||
          run.openings?.some((o) => o.contributionId === c.id) ||
          run.questions?.some(
            (q) =>
              q.text === c.question?.text ||
              c.wordings.some((w) => !w.withdrawn && w.text === q.text),
          )
        )
          ids.add(c.id);
      }
    }
    item.contributionIds = [...ids];
    const supports =
      item.kind === 'engine-run'
        ? new Set((item.latestRun?.answer?.answers ?? []).flatMap((a) => a.sourceIds))
        : null;
    const related = (node) =>
      supports?.size ? supports.has(node.sourceId) : ids.has(node.contributionId);
    linked.set(
      item.id,
      [...entries.values()].filter(related).map((c) => c.id),
    );
    item.conceptPaths = [...entries.values()]
      .filter((n) => related(n) && entries.get(n.parentId)?.sourceId !== n.sourceId)
      .map((n) => {
        const names = [];
        for (let at = n; at; at = entries.get(at.parentId)) names.unshift(at.name ?? at.label);
        return names.join(' → ');
      });
  }
  const sections = ['Questions', 'Corpus material', 'Saved interpretations'];
  development.sort((a, b) => sections.indexOf(a.section) - sections.indexOf(b.section));
  const all = flatten(conceptRoots, null);
  const index = {
    roots: conceptRoots,
    all,
    entries,
    conceptRoots,
    conceptEntries: new Map(all.map((item) => [item.id, item])),
    placementOrder: new Map(all.map((item, i) => [item.id, i])),
    development,
    linked,
  };
  cache.set(data, { engineRuns, projectDigest, index });
  return index;
}
export function projectOutline(
  data,
  expanded = new Set(),
  engineRuns = empty,
  projectDigest = null,
) {
  const index = projectOutlineIndex(data, engineRuns, projectDigest);
  return expanded ? flatten(index.roots, expanded) : index.all;
}
export function conceptOutline(index, expanded) {
  return flatten(index.conceptRoots, expanded);
}
export function developmentOutline(index) {
  return index.development;
}
export function projectEntryTree(item) {
  if (item.kind === 'corpus-contribution') {
    const responses = item.entry.responses.filter((response) => !response.withdrawn);
    return [
      ...(item.entry.question ? [branch('Question', item.entry.question.text)] : []),
      branch('Current state', item.materialState, [], item.stateTone),
      branch(
        'Saved material',
        responses.length
          ? `${responses.length} ${responses.length === 1 ? 'statement' : 'statements'}`
          : 'No answer or supporting statement',
      ),
      ...responses.map((response) => branch('Statement', response.text)),
      ...(item.entry.partial?.parts ?? []).map((part) =>
        branch(
          'Retained supported part',
          [...new Set((part.sources ?? []).map((source) => source.text))].join('\n'),
          [branch('Dependency', 'Recheck against current sources before using earlier support')],
        ),
      ),
      ...(item.entry.partial?.openings ?? []).map((opening) =>
        branch('Open connection', opening.label ?? opening.text ?? opening.reason),
      ),
      ...item.entry.wordings
        .filter((w) => !w.withdrawn)
        .map((w) =>
          branch(
            w.kind === 'clarification'
              ? 'Confirmed connection'
              : w.kind === 'perspective'
                ? 'Perspective'
                : 'Same question',
            w.text,
            [
              ...(w.answerLabel ? [branch('Answer', w.answerLabel)] : []),
              ...(w.basisSources ?? []).map((source) => branch('Source', source.text)),
            ],
          ),
        ),
      ...(item.entry.questionHistory ?? []).map((q) =>
        branch('Earlier question', q.text, [], 'muted'),
      ),
      ...item.entry.responses
        .filter((r) => r.withdrawn)
        .map((r) =>
          branch(
            'Withdrawn',
            r.questionText ? `${r.questionText} Answer: ${r.text}` : r.text,
            [],
            'muted',
          ),
        ),
      ...item.entry.wordings
        .filter((w) => w.withdrawn)
        .map((w) =>
          branch(
            'Earlier declaration',
            w.text + (w.withdrawalReason ? ' (withdrawn after revision)' : ' (withdrawn)'),
            [],
            'muted',
          ),
        ),
      ...(item.entry.anchor
        ? [branch('Develops from', item.entry.anchor.label ?? item.entry.anchor.question)]
        : []),
    ];
  }
  if (item.kind === 'engine-run')
    return [
      branch('Question', item.label),
      branch('Current state', item.materialState, [], item.stateTone),
      ...(item.latestRun
        ? [branch('Earlier result', assessedState[item.latestRun.status] ?? item.latestRun.status)]
        : []),
      branch('Next action', item.nextAction),
    ];
  if (item.kind !== 'mapping') return [];
  return [
    branch('Name', item.entry.name),
    branch('Kind', item.entry.kind ?? 'Concept mapping'),
    ...(item.entry.sourceText ? [branch('Source', item.entry.sourceText)] : []),
  ];
}
