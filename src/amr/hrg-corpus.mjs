/** Automatically factor occurrence-bearing AMR relations into shared HRG rules.
 * Boundary valences follow Gildea et al. (2019), section 5.3.1.
 * Rule definitions may be reused; grounded occurrences never acquire equality
 * merely by using the same rule or concept label.
 */
import { extractHrg, boundaryValences } from './hrg-decomposition.mjs';
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
// nonterminals in order, is redone. The key is the facts themselves, exactly.
const compiledGroups = new Map(),
  groupLimit = 100000;
const factTexts = new WeakMap();
const factText = (fact) => {
  let text = factTexts.get(fact);
  if (text === undefined) factTexts.set(fact, (text = JSON.stringify([fact.id, fact.triple])));
  return text;
};
// One cohort is grouped once, for its signature and its compilation alike.
const groupings = new WeakMap();
function grouped(facts) {
  const cached = groupings.get(facts);
  if (cached && cached.length === facts.length && cached.last === facts.at(-1))
    return cached.groups;
  const byGroup = new Map();
  for (const fact of facts) {
    const group = groupOf(fact);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(fact);
  }
  const groups = [...byGroup]
    .sort(([a], [b]) => collate(a, b))
    .map(([group, entries]) => {
      entries.sort((a, b) => collate(a.id, b.id));
      return {
        group,
        entries,
        key: `${group}\u0000${entries.map(factText).join('\u0000')}`,
      };
    });
  groupings.set(facts, { groups, length: facts.length, last: facts.at(-1) });
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
      label: JSON.stringify(attribute(role) ? [role, { value: to }] : [role]),
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
        valences: boundaryValences(extracted).map((shape) => JSON.stringify(shape)),
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

/** Interpret grounded rule occurrences, preserving ordered ports and edge IDs. */
export function grammarFacts(grammar, facts) {
  const records = new Map(facts.map((f) => [f.id, f])),
    emitted = [],
    visited = new Set();
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
    const begin = emitted.length;
    for (let i = 0; i < rule.terminals.length; i++) {
      const t = rule.terminals[i],
        [role, value] = terminalLabel(t);
      const triple = [
        instance.vertices[t.ports[0]],
        role,
        attribute(role) ? value.value : instance.vertices[t.ports[1]],
      ];
      const record = records.get(instance.terminals[i]);
      if (!record || !sameList(record.triple, triple))
        throw new Error('HRG terminal does not match its source occurrence');
      emitted.push({ ...record, triple, grammar: { rule: rule.id, instance: id, terminal: i } });
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
        emitted.length = begin;
        return false;
      }
    }
    return true;
  };
  for (const root of grammar.starts) visit(root);
  return emitted;
}
