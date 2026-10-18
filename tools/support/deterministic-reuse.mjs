/** Bounded offline experiment. This is not an editor/runtime interpretation path. */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  prepareGraphs,
  normalizedRoleProfile,
  penmanPython,
} from '../../src/models/graph-preparation.mjs';
import { propbankAuditor } from '../../src/models/propbank.mjs';
import { validateGraph } from '../../src/amr/revision.mjs';
import { labelReading } from '../../src/amr/labels.mjs';

export const reuseProfile = 'deterministic-source-reuse-experiment-v1';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inventories = new WeakMap();

/** Only inventory aliases resolve an unlisted spelling. Listed senses never merge. */
export function lexicalInterfaces(graph, text, { frames, audit, organizations }) {
  let aliases = inventories.get(frames);
  if (!aliases) {
    aliases = new Map();
    for (const [frame, [, spellings]] of Object.entries(frames))
      for (const spelling of spellings) {
        const lemma = spelling.replaceAll('_', '-').replaceAll(' ', '-');
        if (!aliases.has(lemma)) aliases.set(lemma, new Set());
        aliases.get(lemma).add(frame);
      }
    inventories.set(frames, aliases);
  }
  const changes = [];
  const canonical = {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const predicate = node.concept.match(/^(.+)-\d{2}$/u);
      const candidates = predicate && aliases.get(predicate[1]);
      if (
        node.literal !== undefined ||
        !predicate ||
        frames[node.concept] ||
        candidates?.size !== 1
      )
        return node;
      const [concept] = candidates;
      if (concept.slice(-3) !== node.concept.slice(-3)) return node;
      // An alias is a spelling of this roleset, not a license to move arguments.
      const roles = Object.keys(frames[concept][3]);
      if (
        graph.edges.some(
          (e) => e.from === node.id && /^:ARG\d+$/u.test(e.role) && !roles.includes(e.role),
        )
      )
        return node;
      changes.push({ nodeId: node.id, from: node.concept, to: concept, files: frames[concept][4] });
      return { ...node, concept };
    }),
  };
  const labelled = labelReading(canonical, text, audit(text, canonical).checks);
  return {
    graph: {
      ...labelled,
      nodes: labelled.nodes.map((node, i) => ({
        ...node,
        ...(graph.nodes[i].surfaceLabel ? { surfaceLabel: graph.nodes[i].surfaceLabel } : {}),
        ...((node.concept === 'person' ||
          node.concept === 'organization' ||
          organizations.has(node.concept)) &&
        node.literal === undefined
          ? { semanticTypes: [...new Set([...(node.semanticTypes ?? []), 'who-answer'])] }
          : {}),
      })),
    },
    aliases: changes,
  };
}

export function questionFocus(graph, text) {
  const unknowns = graph.nodes.filter(
    (n) =>
      n.concept === 'amr-unknown' &&
      graph.edges.some((e) => (e.to === n.id && e.role !== ':polarity') || e.from === n.id),
  );
  if (unknowns.length !== 1 || !/^\s*(?:(?:by|to|for|with|from)\s+)?(?:who|whom)\b/iu.test(text))
    return { graph, focus: null };
  const id = unknowns[0].id;
  return {
    graph: {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === id
          ? { ...n, semanticTypes: [...new Set([...(n.semanticTypes ?? []), 'who-answer'])] }
          : n,
      ),
    },
    focus: { nodeId: id, type: 'who-answer', basis: 'explicit single Who/Whom question' },
  };
}

export async function createRetainedPreparation(project, { prepare = prepareGraphs } = {}) {
  const lexical = await propbankAuditor();
  const { stdout: groupsBytes } = await promisify(execFile)(
    await penmanPython(),
    [
      '-I',
      '-c',
      'from semcat_provenance import installed_source; installed_source(); from importlib.resources import files; print(files("smatchpp").joinpath("resource/concept_groups.json").read_text(), end="")',
    ],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
  );
  const organizations = new Set(JSON.parse(groupsBytes).organization.aliases);
  const context = { ...lexical, organizations };
  const profile = {
    version: reuseProfile,
    normalization: normalizedRoleProfile,
    propbank: lexical.source.indexSha256,
    categories: hash(groupsBytes),
  };
  const directory = join(dirname(project.path), 'engine', 'experiments', reuseProfile);
  await mkdir(directory, { recursive: true });
  const keyFor = (entry) =>
    hash({
      profile,
      id: entry.id,
      kind: entry.kind,
      revision: entry.revision,
      text: entry.text,
      graph: entry.graph ?? null,
      acquisition: entry.acquisition ?? null,
      penman: entry.penman ?? null,
    });
  const store = async (key, value) => {
    const path = join(directory, `${key}.json`),
      temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ key, checksum: hash(value), value }) + '\n', {
        flag: 'wx',
      });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
  };
  return async (input) => {
    const started = performance.now();
    const entries = [...input.sources, ...input.cases, input.question];
    const stats = {
      sourcePrepared: 0,
      sourceReused: 0,
      questionPrepared: 0,
      questionReused: 0,
      penmanGraphs: 0,
      aliases: [],
      focus: null,
      interfaces: [],
    };
    const records = await Promise.all(
      entries.map(async (entry) => {
        const key = keyFor(entry);
        if (entry.acquisition?.status === 'missing') return { entry, key, missing: true };
        try {
          const saved = JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8'));
          if (saved.key === key && saved.checksum === hash(saved.value)) {
            validateGraph(saved.value.graph);
            return { entry, key, value: saved.value, reused: true };
          }
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        return { entry, key };
      }),
    );
    const pending = records.filter((record) => !record.missing && !record.value);
    const normalize = pending.filter(({ entry }) => !entry.graph);
    for (let i = 0; i < normalize.length; i += 128) {
      const batch = normalize.slice(i, i + 128);
      const result = await prepare(
        batch.map(({ entry }) => ({ penman: entry.acquisition?.penman ?? entry.penman })),
        { profile: normalizedRoleProfile },
      );
      if (result.results?.length !== batch.length) throw new Error('Preparation cohort mismatch');
      result.results.forEach((item, index) => {
        if (!item.ok) throw new Error('Frozen acquisition could not be normalized');
        batch[index].prepared = item;
      });
      stats.penmanGraphs += batch.length;
    }
    for (const record of pending) {
      const raw = record.prepared ?? {
        graph: validateGraph(record.entry.graph),
        penman: record.entry.acquisition?.penman ?? null,
      };
      const interpreted = lexicalInterfaces(raw.graph, record.entry.text, context);
      record.value = { ...raw, ...interpreted, profile };
      await store(record.key, record.value);
    }
    const prepared = records.map(({ entry, key, value, reused, missing }) => {
      if (missing) return entry;
      stats[
        `${entry.kind === 'question' ? 'question' : 'source'}${reused ? 'Reused' : 'Prepared'}`
      ]++;
      stats.aliases.push(...value.aliases.map((change) => ({ inputId: entry.id, ...change })));
      stats.interfaces.push({ inputId: entry.id, kind: entry.kind, key, reused: Boolean(reused) });
      const focused =
        entry.kind === 'question' ? questionFocus(value.graph, entry.text) : { graph: value.graph };
      if (focused.focus) stats.focus = focused.focus;
      return { ...entry, ...value, graph: focused.graph };
    });
    stats.elapsedMs = Math.round(performance.now() - started);
    return {
      input: {
        ...input,
        sources: prepared.slice(0, input.sources.length),
        cases: prepared.slice(input.sources.length, -1),
        question: prepared.at(-1),
      },
      stats,
    };
  };
}
