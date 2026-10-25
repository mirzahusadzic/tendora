/** What the workbench and the CLI show of a project's saved checks: recoil
 * from a statement, role or question (down, up, sideways), the tension lines
 * between role branches, and cloze probes of statements. Read-only and
 * offline: nothing is checked again, nothing is saved. */
import { projectTree } from '../authoring/project.mjs';
import { knowledgeSnapshot } from '../authoring/knowledge.mjs';
import { listEngineRuns, readEngineArtifact } from '../storage/engine-runs.mjs';
import { clozeProbes, checkProbe } from '../../engine/cloze.mjs';
import { recoil, recoilContext, recoilFrontier, statementCatalog } from './recoil.mjs';
import { opportunityTree } from './juxtaposition.mjs';
import { resolveInquiryPlacement } from './scope.mjs';
import { authorCase } from './investigation.mjs';

/** A statement named by its text, or by a part of it only one statement has. */
export function findStatement(data, text) {
  const wanted = text.trim();
  const catalog = statementCatalog(data).filter((item) => item.development?.asserted !== false);
  const exact = catalog.filter((item) => item.text.trim() === wanted);
  const found = exact.length ? exact : catalog.filter((item) => item.text.includes(wanted));
  if (found.length === 1) return found[0];
  throw new Error(
    found.length
      ? `${found.length} statements contain “${wanted}”; give more of the statement.`
      : `No statement contains “${wanted}”.`,
  );
}

/** The recoil locus a person names: a statement, a role, or a saved question
 * asked at a role (the root unless given), with an independent case. */
export function recoilLocus(project, { statement, role, question, scope, caseText }) {
  if ([statement, role, question].filter(Boolean).length !== 1)
    throw new Error('Name one statement, role or question.');
  if (statement) return { kind: 'statement', text: findStatement(project.data, statement).text };
  if (role) return { kind: 'role', placementId: resolveInquiryPlacement(project, role) };
  return {
    kind: 'question',
    text: question.trim(),
    scopePlacementId: resolveInquiryPlacement(project, scope),
    caseSelection: caseText ? authorCase(project, caseText) : null,
  };
}

const frontierMeaning = (reason) => recoilFrontier[reason] ?? reason;
const visitRow = (visit) => ({
  relation: [...new Set((visit.relations ?? []).map((edge) => edge.relation).filter(Boolean))].join(
    '; ',
  ),
  kind: visit.kind,
  label: visit.label,
});

/** Recoil from a locus, in three directions: what it rests on (down), what
 * rests on it (up), and what shares its place (sideways), with the frontier
 * the walk cannot see past. A frontier is never absence. */
export async function recoilReport(project, locus, { context } = {}) {
  context ??= await recoilContext(project);
  const walk = recoil(context, locus);
  return {
    locus: walk.locus,
    revision: walk.revision,
    down: walk.origins.map(visitRow),
    up: walk.consequences.map(visitRow),
    sideways: walk.alongside.map((item) => ({
      relation: item.relations.map((path) => path.relation).join('; '),
      kind: item.kind,
      label: item.label,
      through: [...new Set(item.relations.map((path) => path.via).filter(Boolean))],
    })),
    frontier: walk.frontier.map((item) => ({
      reason: item.reason,
      meaning: frontierMeaning(item.reason),
      kind: item.kind,
      label: item.label,
    })),
    unaffected: walk.unaffected,
  };
}

/** The tension lines between role branches at a grain (1: the top-level roles
 * under the root), over every question's latest check at this revision. */
export async function tensionReport(project, { grain = 1, context } = {}) {
  const tree = await opportunityTree(project, { grain, context });
  return {
    grain: tree.grain,
    revision: tree.revision,
    effects: tree.effects,
    lines: tree.tensions.map((line) => ({
      between: line.labels,
      resolved: line.resolved,
      gathered: line.gathered,
      open: line.open,
    })),
    questions: tree.questions.map((item) => ({
      question: item.question,
      ...(item.case ? { case: item.case } : {}),
      effect: item.effect,
      branches: item.branches.map((id) => roleName(project.data, id)),
      lines: item.tensions.map((line) => ({
        between: [roleName(project.data, line.left), roleName(project.data, line.right)],
        status: line.status,
      })),
    })),
  };
}

const roleName = (data, placementId) => {
  const placement = data.placements.find((item) => item.id === placementId);
  return data.concepts.find((concept) => concept.id === placement?.conceptId)?.name ?? placementId;
};

// What a probe's blank asks, in words.
const asks = {
  ':ARG0': 'who or what',
  ':ARG1': 'what',
  ':ARG2': 'to or for whom',
  ':time': 'when',
  ':location': 'where',
  ':manner': 'how',
  ':purpose': 'what for',
  ':cause': 'why',
  ':instrument': 'with what',
  ':path': 'which way',
  ':source': 'from where',
  ':destination': 'to where',
  ':beneficiary': 'for whom',
  ':duration': 'how long',
  ':frequency': 'how often',
  ':extent': 'how far',
  ':accompanier': 'with whom',
};
// A modal frame's own participants: who must, must do what.
const framedAsks = {
  'obligate-01': { ':ARG1': 'who must', ':ARG2': 'must do what' },
  'recommend-01': { ':ARG1': 'what is recommended', ':ARG2': 'to whom' },
  'permit-01': { ':ARG0': 'who permits', ':ARG1': 'what is permitted', ':ARG2': 'to whom' },
  'possible-01': { ':ARG1': 'what is possible' },
};
function probeAsks(probe) {
  if (probe.kind === 'truth') return `is it so (${probe.expected})`;
  const relation = probe.graph.edges.find((edge) => edge.id === 'cloze-edge')?.from;
  const concept = probe.graph.nodes.find((node) => node.id === relation)?.concept;
  return framedAsks[concept]?.[probe.role] ?? asks[probe.role] ?? probe.role;
}
export const probeOutcomes = {
  recovered: 'the statement answers its own blank',
  'also elsewhere': 'recovered, and other statements give the same answer',
  elsewhere: 'only other statements answer it',
  otherwise: 'answered, but not with what the statement says',
  conditional: 'it holds only under its condition, and the condition is not given',
  necessary: 'a necessary condition: nothing follows from it alone',
  limited: 'the search stopped at its bound',
  conflict: 'answered both ways',
  open: 'not recovered: the engine cannot use this reading for its own content',
};

/** The statement with the probe's participant left blank: the words of the
 * participant and its description (never its condition's), found through the
 * reading's labels, in the shortest stretch of the sentence holding them all;
 * the main clause wins a tie. */
export function blankedText(source, probe) {
  if (probe.kind === 'truth') return source.text;
  const kept = new Set(probe.graph.nodes.map((node) => node.id));
  const condition = new Set((probe.case?.nodes ?? []).map((node) => node.id));
  const description = new Set([probe.blank]);
  for (const id of description)
    for (const edge of source.graph.edges) {
      const next = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
      if (next && !kept.has(next) && !condition.has(next)) description.add(next);
    }
  const labels = source.development?.labels ?? {};
  const words = [
    ...new Set(
      source.graph.nodes
        .filter((node) => description.has(node.id))
        .map((node) =>
          String(
            labels[node.id] ??
              node.surfaceLabel ??
              node.literal ??
              // An imported reading has no surface labels: the concept's own word.
              (node.concept?.startsWith('amr-') ? '' : node.concept?.replace(/-\d+$/u, '')) ??
              '',
          )
            .replace(/^"|"$/gu, '')
            .toLowerCase(),
        )
        .filter((word) => word.length > 1),
    ),
  ];
  const stem = (word) => word.replace(/(?:ing|ed|es|s)$/u, '');
  const matches = (token, word) => {
    const t = token.toLowerCase();
    return t === word || stem(t) === stem(word) || (word.length > 3 && t.startsWith(word));
  };
  const hits = [...source.text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)]
    .map((token) => ({ token, word: words.findIndex((word) => matches(token[0], word)) }))
    .filter((hit) => hit.word >= 0);
  const wanted = new Set(hits.map((hit) => hit.word));
  if (!wanted.size) return source.text;
  let best = null;
  for (let i = 0; i < hits.length; i++) {
    const seen = new Set();
    for (let j = i; j < hits.length; j++) {
      seen.add(hits[j].word);
      if (seen.size < wanted.size) continue;
      const start = hits[i].token.index,
        end = hits[j].token.index + hits[j].token[0].length;
      if (
        !best ||
        end - start < best.end - best.start ||
        (end - start === best.end - best.start && start > best.start)
      )
        best = { start, end };
      break;
    }
  }
  // The participant's words may continue past the window ("… closes the
  // incident"): extend through them and small words, ending on one of them.
  const minor = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'and']);
  const tokens = [...source.text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)];
  for (
    let at = tokens.findIndex((token) => token.index >= best.end);
    at >= 0 && at < tokens.length;
    at++
  ) {
    const token = tokens[at];
    if (/[,.;:!?]/u.test(source.text.slice(best.end, token.index))) break;
    const own = words.some((word) => matches(token[0], word));
    if (!own && !minor.has(token[0].toLowerCase())) break;
    if (own) best = { start: best.start, end: token.index + token[0].length };
  }
  const text = source.text.slice(0, best.start) + '___' + source.text.slice(best.end);
  // An appositive's comma goes with the participant it closes: "___ reports …".
  return text.replace(/^___,\s*/u, '___ ').replace(/,\s*___,/u, ', ___');
}

/** The latest full check at the root at this revision: what probes are read
 * against. Probes need one; they do not check anything themselves. */
async function rootCheck(project) {
  const root = project.data.placements.find((placement) => placement.parentId === null).id;
  const run = (await listEngineRuns(project))
    .filter(
      (item) =>
        item.answer &&
        item.resultRef &&
        item.inputRef &&
        item.scopePlacementId === root &&
        !item.caseSelection &&
        item.projectDigest === project.digest,
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!run)
    throw new Error(
      'Probes read the latest check at the root role at this revision; ask a question there first.',
    );
  const [input, result] = await Promise.all([
    readEngineArtifact(project, run.inputRef),
    readEngineArtifact(project, run.resultRef),
  ]);
  return { input, result };
}

/** Cloze probes of one statement or of every statement placed at or under a
 * role: each participant of its relation asked back from its own reading, and
 * its truth. They propose where to ask and what to reword; they answer nothing. */
export async function probeReport(project, { statement, role }) {
  if (Boolean(statement) === Boolean(role)) throw new Error('Name one statement or role.');
  const { input, result } = await rootCheck(project);
  const sources = result.inputs.filter((item) => item.kind !== 'question');
  const rows = projectTree(project.data);
  const byId = new Map(rows.map((row) => [row.placement.id, row]));
  const within = (placementId, scope) => {
    for (let at = placementId; at; at = byId.get(at)?.placement.parentId)
      if (at === scope) return true;
    return false;
  };
  let chosen;
  if (statement) {
    const text = findStatement(project.data, statement).text;
    chosen = sources.filter((item) => item.text === text);
  } else {
    const scope = resolveInquiryPlacement(project, role);
    chosen = sources.filter((item) => within(item.placementId, scope));
  }
  if (!chosen.length) throw new Error('The latest root check holds no statement at this locus.');
  const knowledge = knowledgeSnapshot(project.data);
  const texts = new Map(sources.map((item) => [item.id, item]));
  let grammarCache;
  const counts = {};
  const statements = [];
  for (const source of chosen) {
    const probes = [];
    for (const probe of clozeProbes(source)) {
      const checked = checkProbe(project, input, result, probe, { knowledge, grammarCache });
      grammarCache = checked.grammarCache;
      counts[checked.outcome] = (counts[checked.outcome] ?? 0) + 1;
      const alsoFrom = [
        ...new Set(
          checked.answers
            .flatMap((answer) => answer.sourceIds)
            .filter((id) => id !== source.id && texts.has(id))
            .map((id) => texts.get(id).text),
        ),
      ];
      probes.push({
        asks: probeAsks(probe),
        blanked: blankedText(source, probe),
        outcome: checked.outcome,
        meaning: probeOutcomes[checked.outcome],
        answers: [...new Set(checked.answers.map((answer) => answer.text))],
        ...(alsoFrom.length ? { alsoFrom } : {}),
      });
    }
    statements.push({
      statement: source.text,
      role: roleName(project.data, source.placementId),
      ...(source.graph ? {} : { reading: 'none' }),
      probes,
    });
  }
  return { revision: project.digest, statements, counts };
}

/** The reports as plain text, for the CLI. */
export function formatRecoil(report) {
  const lines = [`${report.locus.kind}: ${report.locus.label}`];
  const section = (title, rows, line) => {
    lines.push('', `${title} (${rows.length})`);
    for (const row of rows) lines.push('  ' + line(row));
    if (!rows.length) lines.push('  nothing');
  };
  section('Down: what it rests on', report.down, (r) => `${r.relation}: ${r.kind} “${r.label}”`);
  section('Up: what rests on it', report.up, (r) => `${r.relation}: ${r.kind} “${r.label}”`);
  section(
    'Sideways: what shares its place',
    report.sideways,
    (r) =>
      `${r.relation}: ${r.kind} “${r.label}”${r.through.length ? ` (through “${r.through.join('”, “')}”)` : ''}`,
  );
  if (report.frontier.length)
    section(
      'Frontier: what the walk cannot see',
      report.frontier,
      (r) => `${r.kind} “${r.label}”: ${r.meaning}`,
    );
  if (report.locus.kind !== 'question')
    lines.push('', `Unaffected at this revision: ${report.unaffected} questions`);
  lines.push('Read-only: nothing was checked again.');
  return lines.join('\n');
}

/** How a revision's checked questions fall: "Of 11 checked questions, 1 brings
 * roles together, 8 stay in one role and 2 cite no statement." */
export function effectSummary({ quiet, branch, juxtaposition }) {
  const verb = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const total = quiet + branch + juxtaposition;
  return (
    `Of ${verb(total, 'checked question', 'checked questions')}, ` +
    `${verb(juxtaposition, 'brings', 'bring')} roles together, ` +
    `${verb(branch, 'stays', 'stay')} in one role and ` +
    `${verb(quiet, 'cites', 'cite')} no statement.`
  );
}

export function formatTensions(report) {
  const lines = [effectSummary(report.effects)];
  if (!report.lines.length) lines.push('', 'No question brings two roles together yet.');
  for (const line of report.lines) {
    lines.push('', `${line.between.join(' ↔ ')}`);
    for (const [status, meaning] of [
      ['resolved', 'one answer composes both'],
      ['gathered', 'each gives its own answer'],
      ['open', 'reached, not yet answered'],
    ])
      for (const question of line[status]) lines.push(`  ${status} (${meaning}): ${question}`);
  }
  lines.push('', 'Read-only: an open line is a place to ask or to author, never an answer.');
  return lines.join('\n');
}

export function formatProbes(report) {
  const lines = [];
  for (const item of report.statements) {
    lines.push(`${item.statement}  [${item.role}]`);
    if (item.reading === 'none') lines.push('  no reading');
    for (const probe of item.probes)
      lines.push(
        `  ${probe.asks}: ${probe.blanked}`,
        `    ${probe.outcome}${probe.answers.length ? ` → ${probe.answers.join('; ')}` : ''}: ${probe.meaning}`,
        ...(probe.alsoFrom ? [`    also from: ${probe.alsoFrom.join(' | ')}`] : []),
      );
    lines.push('');
  }
  const counts = Object.entries(report.counts)
    .map(([outcome, n]) => `${n} ${outcome}`)
    .join(', ');
  lines.push(`Probes: ${counts || 'none'}. They answer nothing; they show where to ask or reword.`);
  return lines.join('\n');
}
