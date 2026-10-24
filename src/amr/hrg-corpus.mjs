/** Automatically factor occurrence-bearing AMR relations into shared HRG rules.
 * Boundary valences follow Gildea et al. (2019), section 5.3.1.
 * Rule definitions may be reused; grounded occurrences never acquire equality
 * merely by using the same rule or concept label.
 */
import { extractHrg, boundaryValences } from './hrg-decomposition.mjs';
import { contentName } from './hash.mjs';
import { storeOf } from './fact-store.mjs';
export const grammarProfile = 'amr-ordered-hrg-v1';
const attribute = (role) => !role.startsWith(':') || role === ':instance';
// localeCompare's order, without building a collator for every comparison.
const collate = new Intl.Collator().compare;
const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);
// A retained grammar's terminal labels are parsed once.
const labels = new WeakMap();
const terminalLabel = (terminal) => {
  if (!labels.has(terminal)) labels.set(terminal, JSON.parse(terminal.label));
  return labels.get(terminal);
};
const groupOf = (fact) => fact.ruleId ?? fact.sourceIds?.[0] ?? 'relations';
// A statement's facts compile to the same productions wherever they occur, so
// its compilation is kept by content and shared across rounds, roles and
// questions; only the assembly into one grammar, which numbers rules and
// nonterminals in order, is redone. The key names the statement's facts (their
// ids and triples, in order) by a 106-bit content name, so the cache holds no
// second copy of them.
export const clearCompiledGroups = () => {
  compiledGroups.clear();
  memberships.clear();
};
const compiledGroups = new Map(),
  groupLimit = 100000;
const factParts = function* (entries) {
  for (const fact of entries) {
    yield fact.id ?? '\u0001';
    for (const term of fact.triple) yield String(term);
  }
};
// The same label or valence recurs across statements: kept once.
const interned = new Map();
const intern = (text) => {
  const known = interned.get(text);
  if (known !== undefined) return known;
  interned.set(text, text);
  return text;
};
// One cohort is grouped once, for its signature and its compilation alike.
const groupings = new WeakMap();
const named = (group, entries) => {
  entries.sort((a, b) => collate(a.id, b.id));
  return { group, entries, key: `${group}\u0000${contentName(factParts(entries))}` };
};
// A group of the same facts, in the same order, is named as before: a view
// without some statements names again only the groups it changed.
const memberships = new Map(),
  membershipLimit = 100000;
function namedOnce(group, members) {
  const known = memberships.get(group);
  if (known && sameList(known.members, members)) return known.value;
  const value = named(group, [...members]);
  if (memberships.size >= membershipLimit) memberships.delete(memberships.keys().next().value);
  memberships.set(group, { members, value });
  return value;
}
function grouped(facts) {
  const cached = groupings.get(facts);
  if (cached && cached.length === facts.length && cached.last === facts.at(-1))
    return cached.groups;
  const store = storeOf(facts);
  let groups;
  if (store) groups = storeGroups(store, facts);
  else {
    const byGroup = new Map();
    for (const fact of facts) {
      const group = groupOf(fact);
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push(fact);
    }
    groups = [...byGroup].map(([group, members]) => namedOnce(group, members));
  }
  groups.sort((a, b) => collate(a.group, b.group));
  groupings.set(facts, { groups, length: facts.length, last: facts.at(-1) });
  return groups;
}
// A store's facts are grouped as they come: a later cohort of the same
// inference names again only the groups that gained facts.
const storeGroupings = new WeakMap();
function storeGroups(store, facts) {
  let registry = storeGroupings.get(store);
  if (!registry) storeGroupings.set(store, (registry = { scanned: 0, byGroup: new Map() }));
  for (; registry.scanned < facts.length; registry.scanned++) {
    const f = registry.scanned,
      group = groupOf(facts[f]);
    let entry = registry.byGroup.get(group);
    if (!entry) registry.byGroup.set(group, (entry = { positions: [], count: 0, value: null }));
    entry.positions.push(f);
  }
  const groups = [];
  for (const [group, entry] of registry.byGroup) {
    // Positions grow in order: the cohort holds a prefix of each group's.
    let count = entry.positions.length;
    while (count && entry.positions[count - 1] >= facts.length) count--;
    if (!count) continue;
    if (entry.count !== count) {
      entry.count = count;
      entry.value = named(
        group,
        entry.positions.slice(0, count).map((f) => facts[f]),
      );
    }
    groups.push(entry.value);
  }
  return groups;
}
/** The same facts in the same statements give the same signature. */
export const corpusSignature = (facts) =>
  grouped(facts)
    .map(({ key }) => key)
    .join('\u0001');

/** One statement's components: decompositions, valences and productions, with
 * nonterminals and rule numbers left to the assembly. */
function compileGroup(entries) {
  const terminals = entries.map((fact) => {
    const [from, role, to] = fact.triple;
    return {
      id: fact.id,
      label: intern(JSON.stringify(attribute(role) ? [role, { value: to }] : [role])),
      vertices: attribute(role) ? [from] : [from, to],
    };
  });
  const vertices = [...new Set(terminals.flatMap((t) => t.vertices))].sort();
  // Components avoid an artificial global node connecting unrelated sources.
  const adjacency = new Map(vertices.map((v) => [v, new Set()]));
  for (const t of terminals)
    for (const a of t.vertices) for (const b of t.vertices) adjacency.get(a).add(b);
  const seen = new Set(),
    components = [];
  for (const first of vertices) {
    if (seen.has(first)) continue;
    const component = new Set([first]);
    for (const v of component) {
      seen.add(v);
      for (const w of adjacency.get(v)) component.add(w);
    }
    const local = terminals.filter((t) => component.has(t.vertices[0]));
    const extracted = extractHrg([...component], local);
    components.push(
      Object.freeze({
        width: extracted.width,
        valences: boundaryValences(extracted).map((shape) => intern(JSON.stringify(shape))),
        rules: extracted.rules.map((r) =>
          Object.freeze({
            id: r.id,
            rank: r.rank,
            vertices: Object.freeze(r.vertices),
            terminals: Object.freeze(
              r.terminals.map(({ label, ports }) => Object.freeze({ label, ports })),
            ),
            terminalIds: Object.freeze(r.terminals.map((t) => t.id)),
            children: r.children.map((c) => ({ id: c.id, ports: c.ports })),
          }),
        ),
      }),
    );
  }
  return components;
}

export function compileCorpus(facts, retained = null, signature = corpusSignature(facts)) {
  if (retained?.profile === grammarProfile && retained.signature === signature)
    return { grammar: retained, reused: true };
  const rules = [],
    instances = [],
    starts = [],
    symbols = new Map(),
    ruleKeys = new Map();
  const internSymbol = (key) => {
    if (!symbols.has(key)) symbols.set(key, `N${symbols.size}`);
    return symbols.get(key);
  };
  const widths = [];
  for (const { group, entries, key } of grouped(facts)) {
    let components = compiledGroups.get(key);
    if (!components) {
      components = compileGroup(entries);
      if (compiledGroups.size >= groupLimit)
        compiledGroups.delete(compiledGroups.keys().next().value);
      compiledGroups.set(key, components);
    }
    for (const component of components) {
      const base = instances.length;
      widths.push(component.width);
      starts.push(base);
      const nonterminals = component.valences.map(internSymbol);
      for (const r of component.rules) {
        const shape = {
          symbol: nonterminals[r.id],
          rank: r.rank,
          vertices: r.vertices.length,
          terminals: r.terminals,
          children: r.children.map((c) => ({ symbol: nonterminals[c.id], ports: c.ports })),
        };
        const key = JSON.stringify(shape);
        if (!ruleKeys.has(key)) {
          ruleKeys.set(key, rules.length);
          rules.push({ id: rules.length, ...shape });
        }
        instances.push({
          id: base + r.id,
          group,
          rule: ruleKeys.get(key),
          vertices: r.vertices,
          terminals: r.terminalIds,
          children: r.children.map((c) => base + c.id),
        });
      }
    }
  }
  const ruleSources = new Map();
  for (const instance of instances) {
    if (!ruleSources.has(instance.rule)) ruleSources.set(instance.rule, new Set());
    ruleSources.get(instance.rule).add(instance.group);
  }
  return {
    grammar: {
      profile: grammarProfile,
      signature,
      rules,
      instances,
      starts,
      stats: {
        rules: rules.length,
        occurrences: instances.length,
        sharedRules: [...ruleSources.values()].filter((s) => s.size > 1).length,
        maxWidth: Math.max(0, ...widths),
        facts: facts.length,
      },
    },
    reused: false,
  };
}

/** Interpret grounded rule occurrences, preserving ordered ports and edge IDs:
 * the order in which the grammar emits a cohort's facts, as integer columns
 * (each emitted terminal's position in the cohort and its production: rule,
 * instance, terminal), with every terminal checked against its occurrence. */
export function grammarEmission(grammar, facts, positionOf = null) {
  let at = positionOf;
  if (!at) {
    const positions = new Map(facts.map((fact, f) => [fact.id, f]));
    at = (id) => positions.get(id);
  }
  let capacity = Math.max(16, facts.length),
    length = 0;
  let order = new Uint32Array(capacity),
    rules = new Uint32Array(capacity),
    instances = new Uint32Array(capacity),
    terminals = new Uint32Array(capacity);
  const emit = (f, rule, instance, terminal) => {
    if (length === capacity) {
      capacity *= 2;
      const grow = (column) => {
        const grown = new Uint32Array(capacity);
        grown.set(column);
        return grown;
      };
      [order, rules, instances, terminals] = [order, rules, instances, terminals].map(grow);
    }
    order[length] = f;
    rules[length] = rule;
    instances[length] = instance;
    terminals[length++] = terminal;
  };
  const visited = new Set();
  const visit = (id, expectedPorts = null, expectedSymbol = null) => {
    const instance = grammar.instances[id],
      rule = instance && grammar.rules[instance.rule];
    if (!rule) return false;
    if (visited.has(id)) throw new Error('Cyclic corpus derivation');
    visited.add(id);
    if (expectedSymbol !== null && rule.symbol !== expectedSymbol)
      throw new Error('HRG nonterminal mismatch');
    if (expectedPorts && !sameList(instance.vertices.slice(0, rule.rank), expectedPorts))
      throw new Error('HRG attachment mismatch');
    const begin = length;
    for (let i = 0; i < rule.terminals.length; i++) {
      const t = rule.terminals[i],
        [role, value] = terminalLabel(t);
      const from = instance.vertices[t.ports[0]],
        to = attribute(role) ? value.value : instance.vertices[t.ports[1]];
      const f = at(instance.terminals[i]),
        triple = f === undefined ? null : facts[f].triple;
      if (!triple || triple[0] !== from || triple[1] !== role || triple[2] !== to)
        throw new Error('HRG terminal does not match its source occurrence');
      emit(f, rule.id, id, i);
    }
    for (let i = 0; i < rule.children.length; i++) {
      const child = rule.children[i];
      if (
        !visit(
          instance.children[i],
          child.ports.map((p) => instance.vertices[p]),
          child.symbol,
        )
      ) {
        length = begin;
        return false;
      }
    }
    return true;
  };
  for (const root of grammar.starts) visit(root);
  return {
    length,
    order: order.subarray(0, length),
    rules: rules.subarray(0, length),
    instances: instances.subarray(0, length),
    terminals: terminals.subarray(0, length),
    production: (e) => ({ rule: rules[e], instance: instances[e], terminal: terminals[e] }),
  };
}

/** The emitted facts as objects, each with its production. */
export function grammarFacts(grammar, facts) {
  const emission = grammarEmission(grammar, facts);
  return Array.from({ length: emission.length }, (_, e) => {
    const fact = facts[emission.order[e]];
    return { ...fact, triple: [...fact.triple], grammar: emission.production(e) };
  });
}
