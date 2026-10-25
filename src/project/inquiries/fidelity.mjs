/** Corpus fidelity: a corpus's statements against the questions they answer.
 * Read-only and offline, from the latest check at the root role.
 *
 * Variables. Each statement's reading is asked back with one participant,
 * circumstance or its truth left blank (the probes of `probe`). A variable is
 *   own        answered by its own statement alone
 *   shared     answered by its own statement and, the same, by others
 *   carried    answered only by other statements, unconditionally
 *   possible   among other possible answers
 *   silent     rightly unanswered: its condition is not given, or it is a
 *              necessary condition
 *   otherwise  answered, but not with what the statement says
 *   owed       open or limited: to be answered or silenced
 *   conflict   answered both ways
 * Own, shared and carried are answerable. A statement is settled when every
 * variable is answerable or silent. With `withhold`, each variable its own
 * statement answers is asked again without that statement: it is borne alone
 * when nothing else gives it, shared when another statement does (the
 * load-bearing test of docs/load-bearing.md, per variable).
 *
 * Questions. The latest saved check of each question at this revision is
 * answered by one statement, composed from two or more (and across top-level
 * roles), conditional, possible, in conflict or open; an open question whose supported
 * parts reach two or more statements is a composition met, not closed.
 */
import { Worker } from 'node:worker_threads';
import { dirname } from 'node:path';
import { projectTree } from '../authoring/project.mjs';
import { knowledgeSnapshot } from '../authoring/knowledge.mjs';
import { listEngineRuns } from '../storage/engine-runs.mjs';
import { clozeProbes, checkProbe } from '../../engine/cloze.mjs';
import { probeAsks, releasedNote, roleName, rootCheck } from './inspection.mjs';

export const variableKinds = [
  'own',
  'shared',
  'carried',
  'possible',
  'silent',
  'otherwise',
  'owed',
  'conflict',
];
export const questionKinds = [
  'one',
  'composed',
  'conditional',
  'possible',
  'conflict',
  'met',
  'open',
];
const answerable = ['own', 'shared', 'carried'];
const toReview = ['otherwise', 'owed', 'conflict'];

export function variableKind(probe, checked) {
  const ambiguous = checked.status === 'ambiguous';
  switch (checked.outcome) {
    case 'recovered':
      return ambiguous ? 'possible' : 'own';
    case 'also elsewhere':
      return ambiguous ? 'possible' : 'shared';
    case 'elsewhere':
      if (ambiguous) return 'possible';
      return checked.answers.some(
        (answer) => !answer.sourceIds.includes(probe.sourceId) && !answer.conditional,
      )
        ? 'carried'
        : 'owed';
    case 'conditional':
    case 'necessary':
      return 'silent';
    case 'otherwise':
    case 'conflict':
      return checked.outcome;
    default:
      return 'owed';
  }
}

export async function fidelityReport(project, { withhold = false } = {}) {
  const { input, result } = await rootCheck(project);
  const sources = result.inputs.filter((item) => !['question', 'case'].includes(item.kind));
  const placementOf = new Map(sources.map((item) => [item.id, item.placementId]));
  const rows = projectTree(project.data);
  const byId = new Map(rows.map((row) => [row.placement.id, row]));
  // The top-level role a placement is under (the root's own statements: the root).
  const topRole = (placementId) => {
    let at = byId.get(placementId);
    while (at && byId.get(at.placement.parentId)?.placement.parentId)
      at = byId.get(at.placement.parentId);
    return at?.concept.name ?? null;
  };

  const knowledge = knowledgeSnapshot(project.data);
  let grammarCache;
  const statements = sources.map((source) => {
    const counts = Object.fromEntries(variableKinds.map((kind) => [kind, 0]));
    const borne = { alone: 0, shared: 0 };
    const review = [];
    if (source.graph)
      for (const probe of clozeProbes(source)) {
        const checked = checkProbe(project, input, result, probe, { knowledge, grammarCache });
        grammarCache = checked.grammarCache;
        const kind = variableKind(probe, checked);
        counts[kind]++;
        if (withhold && ['own', 'shared'].includes(kind)) {
          const own = new Set(
            checked.answers
              .filter((answer) => answer.sourceIds.includes(probe.sourceId))
              .map((answer) => answer.text),
          );
          const without = checkProbe(project, input, result, probe, {
            knowledge,
            grammarCache,
            withhold: [probe.sourceId],
          });
          borne[
            without.answers.some((answer) => own.has(answer.text) && !answer.conditional)
              ? 'shared'
              : 'alone'
          ]++;
        }
        if (toReview.includes(kind)) review.push({ kind, asks: probeAsks(probe) });
      }
    const variables = variableKinds.reduce((sum, kind) => sum + counts[kind], 0);
    return {
      id: source.id,
      statement: source.text,
      role: roleName(project.data, source.placementId),
      topRole: topRole(source.placementId),
      read: Boolean(source.graph),
      variables,
      ...counts,
      ...(withhold ? { borneAlone: borne.alone, borneShared: borne.shared } : {}),
      settled:
        Boolean(source.graph) &&
        [...answerable, 'silent'].reduce((sum, kind) => sum + counts[kind], 0) === variables,
      review,
    };
  });

  // The latest check of each question, its scope and its case, at this revision.
  const latest = new Map(),
    released = new Set();
  const saved = (await listEngineRuns(project))
    .filter((run) => run.projectDigest === project.digest)
    .filter((run) => !run.purpose || ['inquiry', 'question-refresh'].includes(run.purpose))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const key = (run) =>
    JSON.stringify([run.questions?.[0]?.text, run.scopePlacementId, run.case || null]);
  for (const run of saved) {
    if (!run.questions?.[0]?.text) continue;
    if (run.answer && !latest.has(key(run))) latest.set(key(run), run);
  }
  // A question whose checks were all released is not read; the report counts it.
  for (const run of saved)
    if (run.questions?.[0]?.text && !run.answer && run.cache === 'recheck' && !latest.has(key(run)))
      released.add(key(run));
  const known = new Set(placementOf.keys());
  const cited = (binding) =>
    new Set(
      [
        ...(binding.sourceIds ?? []),
        ...(binding.ruleIds ?? []).map((id) => id.split('/clause/')[0]),
      ].filter((id) => known.has(id)),
    );
  const asked = [...latest.values()].map((run) => {
    const answer = run.answer;
    const bindings = answer.answers ?? [];
    const widest = bindings.reduce((most, binding) => {
      const ids = cited(binding);
      return ids.size > most.size ? ids : most;
    }, new Set());
    const parts = new Set(
      (answer.partial?.parts ?? [])
        .flatMap((part) => part.sourceIds ?? [])
        .filter((id) => known.has(id)),
    );
    const kind =
      bindings.length && answer.status === 'supported'
        ? widest.size > 1
          ? 'composed'
          : 'one'
        : answer.status === 'conditional'
          ? 'conditional'
          : answer.status === 'conflict'
            ? 'conflict'
            : answer.status === 'ambiguous' || (answer.candidates ?? []).length
              ? 'possible'
              : parts.size > 1
                ? 'met'
                : 'open';
    const ids = kind === 'met' ? parts : widest;
    return {
      question: run.questions[0].text,
      ...(run.case ? { case: run.case } : {}),
      kind,
      statements: ids.size,
      roles: new Set([...ids].map((id) => topRole(placementOf.get(id)))).size,
      rests: [...new Set(bindings.flatMap((binding) => [...cited(binding)]))],
    };
  });

  const restedOn = new Set(asked.flatMap((question) => question.rests));
  const tally = (items) => {
    const sum = (pick) => items.reduce((total, item) => total + pick(item), 0);
    const counts = Object.fromEntries(
      variableKinds.map((kind) => [kind, sum((item) => item[kind])]),
    );
    return {
      statements: items.length,
      read: sum((item) => Number(item.read)),
      variables: sum((item) => item.variables),
      ...counts,
      answerable: answerable.reduce((total, kind) => total + counts[kind], 0),
      ...(withhold
        ? {
            borneAlone: sum((item) => item.borneAlone),
            borneShared: sum((item) => item.borneShared),
          }
        : {}),
      settled: sum((item) => Number(item.settled)),
      restedOn: items.filter((item) => restedOn.has(item.id)).length,
    };
  };
  const roles = [...new Set(statements.map((item) => item.topRole))].map((role) => ({
    role,
    ...tally(statements.filter((item) => item.topRole === role)),
  }));
  return {
    revision: project.digest,
    totals: tally(statements),
    questions: {
      total: asked.length,
      released: released.size,
      ...Object.fromEntries(
        questionKinds.map((kind) => [kind, asked.filter((q) => q.kind === kind).length]),
      ),
      composedAcrossRoles: asked.filter((q) => q.kind === 'composed' && q.roles > 1).length,
    },
    roles,
    statements: statements.map(({ id: _id, ...item }) => item),
    asked: asked.map(({ rests: _rests, ...item }) => item),
  };
}

/** The report from a worker thread; `signal` stops it. */
export function fidelityInWorker(project, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./fidelity-worker.mjs', import.meta.url), {
      workerData: { directory: dirname(project.path), digest: project.digest },
    });
    const stop = () => worker.terminate();
    signal?.addEventListener('abort', stop, { once: true });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      signal?.removeEventListener('abort', stop);
      if (code) reject(new Error(signal?.aborted ? 'Stopped.' : `Fidelity stopped (${code}).`));
    });
  });
}

const share = (part, whole) => (whole ? ` (${Math.round((100 * part) / whole)}%)` : '');

/** The report as plain text, for the CLI. */
export function formatFidelity(report) {
  const t = report.totals,
    q = report.questions;
  const lines = [
    `Corpus fidelity at revision ${report.revision.slice(0, 12)}`,
    '',
    `${t.statements} statements (${t.read} read), ${t.variables} variables asked back`,
    `  answerable ${t.answerable}${share(t.answerable, t.variables)}: own ${t.own}, shared ${t.shared}, carried ${t.carried}`,
    `  silent ${t.silent}, possible ${t.possible}, otherwise ${t.otherwise}, owed ${t.owed}, conflict ${t.conflict}`,
    ...(t.borneAlone !== undefined
      ? [`  withheld: borne alone ${t.borneAlone}, shared with another statement ${t.borneShared}`]
      : []),
    `  settled ${t.settled} of ${t.statements}; questions rest on ${t.restedOn} of ${t.statements}`,
    '',
    `${q.total} checked questions: one statement ${q.one}, composed ${q.composed} (across roles ${q.composedAcrossRoles}),`,
    `  conditional ${q.conditional}, possible ${q.possible}, conflict ${q.conflict}, composition met ${q.met}, open ${q.open}`,
    ...(releasedNote(q.released) ? [`  ${releasedNote(q.released)}`] : []),
    '',
  ];
  const width = Math.max(4, ...report.roles.map((role) => (role.role ?? '').length));
  const columns = ['Statements', 'Variables', 'Answerable', 'Settled', 'Rested on'];
  lines.push(`${'Role'.padEnd(width)}  ${columns.join('  ')}`);
  for (const role of report.roles)
    lines.push(
      `${(role.role ?? '').padEnd(width)}  ` +
        [role.statements, role.variables, role.answerable, role.settled, role.restedOn]
          .map((value, i) => String(value).padStart(columns[i].length))
          .join('  '),
    );
  const review = report.statements.filter((item) => item.review.length || !item.read);
  if (review.length) {
    lines.push('', 'To review:');
    for (const item of review) {
      lines.push(`  ${item.statement}  [${item.role}]`);
      if (!item.read) lines.push('    no reading: nothing can be asked back');
      for (const slot of item.review) lines.push(`    ${slot.kind}: ${slot.asks}`);
    }
  }
  return lines.join('\n');
}
