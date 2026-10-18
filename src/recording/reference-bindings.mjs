/** Scoped equality of semantic references. Occurrence attributes keep their owners. */
import { graphRevision } from './revisions.mjs';
import { claimRoot } from '../amr/patterns.mjs';

const occurrenceRoles = new Set(['@source', '@node']);
const semantic = (role) =>
  role.startsWith(':') || ['@asserted', '@qualification', '@label', '@root'].includes(role);
const variable = (value) => value.startsWith('?');
const identity = (source, node) => `${source}#${node}`;

export function validateReferenceBinding(binding) {
  if (
    !binding?.name?.trim() ||
    !binding.attribution?.trim() ||
    !binding.scopePlacementId ||
    !Array.isArray(binding.references) ||
    binding.references.length < 2 ||
    binding.references.length > 32 ||
    binding.references.some(
      (ref) => !ref.text || !ref.nodeId || !ref.sourceNodeId || !ref.graphRevision,
    )
  )
    throw new Error(
      'Reference binding needs a name, attribution, scope and two or more exact source occurrences',
    );
}

export function bindReferences(material, bindings, applies) {
  const parent = new Map(),
    accepted = [],
    skipped = [];
  const graphBySource = new Map(material.sourceGraphs.map((item) => [item.sourceId, item]));
  const root = (value) => {
    const next = parent.get(value);
    return next && next !== value ? root(next) : value;
  };
  for (const binding of bindings) {
    if (!applies(binding)) continue;
    const refs = binding.references.map((ref) => {
      const source = material.sources.find(
        (source) => source.nodeId === ref.nodeId && source.text === ref.text,
      );
      const entry = source && graphBySource.get(source.id),
        graph = entry?.graph;
      const node = graph?.nodes.find((node) => node.id === ref.sourceNodeId);
      return graph &&
        node &&
        !node.id.startsWith('literal:') &&
        (entry.revision ?? graphRevision(graph)) === ref.graphRevision
        ? { source, graph, node }
        : null;
    });
    if (refs.some((ref) => !ref)) {
      skipped.push({
        kind: 'reference changed or unavailable',
        bindingId: binding.id,
        name: binding.name,
      });
      continue;
    }
    // Joining an event across different assertion environments needs an explicit
    // interpretation. Equality by itself cannot extract an embedded claim.
    const contexts = refs.map(({ source, graph, node }) => {
      if (!/-\d+$/u.test(node.concept)) return 'entity';
      const clauses = material.fragments
        ?.filter(
          (fragment) =>
            fragment.sourceId === source.id &&
            fragment.kind === 'clause' &&
            fragment.graph.nodes.some((item) => item.id === node.id),
        )
        .map((fragment) => fragment.graph);
      const scopes = clauses?.length ? clauses : [graph];
      return JSON.stringify(
        scopes
          .map((graph) => {
            const guards = graph.edges
              .filter((edge) => [':polarity', ':condition'].includes(edge.role))
              .map((edge) => [edge.role, graph.nodes.find((item) => item.id === edge.to)?.concept]);
            const reaches = (from, target, seen = new Set()) =>
              from === target ||
              (!seen.has(from) &&
                (seen.add(from),
                graph.edges
                  .filter((edge) => edge.from === from)
                  .some((edge) => reaches(edge.to, target, seen))));
            const environments = graph.nodes
              .filter(
                (item) =>
                  /^(?:possible|recommend|obligate|say|tell|report|quote|think|believe)-\d+$/u.test(
                    item.concept,
                  ) &&
                  reaches(claimRoot(graph), item.id) &&
                  reaches(item.id, node.id),
              )
              .map((item) => item.concept);
            return [environments.sort(), guards.sort()];
          })
          .sort(),
      );
    });
    if (new Set(contexts).size !== 1) {
      skipped.push({
        kind: 'reference assertion boundary',
        bindingId: binding.id,
        name: binding.name,
      });
      continue;
    }
    const ids = refs.map((ref) => identity(ref.source.id, ref.node.id));
    const representative = ids.map(root).sort()[0];
    for (const id of ids) parent.set(root(id), representative);
    accepted.push({ ...binding, ids, sourceIds: refs.map((ref) => ref.source.id) });
  }
  if (!accepted.length)
    return { ...material, skipped: [...material.skipped, ...skipped], bindings: [] };
  const classes = new Map();
  for (const binding of accepted)
    for (const id of binding.ids) {
      const canonical = root(id);
      if (!classes.has(canonical)) classes.set(canonical, new Set());
      classes.get(canonical).add(binding.id);
    }
  const proof = (ids) => {
    const bindingIds = [...new Set(ids.flatMap((id) => [...(classes.get(root(id)) ?? [])]))];
    return {
      bindingIds,
      sourceIds: [
        ...new Set(
          accepted
            .filter((binding) => bindingIds.includes(binding.id))
            .flatMap((binding) => binding.sourceIds),
        ),
      ],
    };
  };
  const triple = (value) =>
    semantic(value[1])
      ? [root(value[0]), value[1], value[1] === ':instance' ? value[2] : root(value[2])]
      : value;
  const facts = material.facts.map((fact) => {
    const next = triple(fact.triple),
      evidence = semantic(fact.triple[1])
        ? proof([fact.triple[0], ...(fact.triple[1] === ':instance' ? [] : [fact.triple[2]])])
        : { bindingIds: [], sourceIds: [] };
    return {
      ...fact,
      triple: next,
      ...(evidence.bindingIds.length
        ? {
            bindingIds: evidence.bindingIds,
            occurrence: fact.triple,
            sourceIds: [...new Set([...fact.sourceIds, ...evidence.sourceIds])],
          }
        : {}),
      ...(fact.guards
        ? { guards: fact.guards.map((id) => JSON.stringify(triple(JSON.parse(id)))) }
        : {}),
    };
  });
  for (const node of material.nodes) {
    const evidence = proof([node.id]);
    facts.push({
      triple: [node.id, '@referent', root(node.id)],
      sourceIds: [...new Set([node.sourceId, ...evidence.sourceIds])],
      ...(evidence.bindingIds.length ? { bindingIds: evidence.bindingIds } : {}),
    });
  }
  const rules = material.rules.map((rule) => {
    const owners = new Map();
    const terms = new Set([...rule.when.flat(), ...rule.then.flat()]);
    let serial = 0;
    for (const [subject, role] of rule.when)
      if (occurrenceRoles.has(role) && variable(subject))
        if (!owners.has(subject)) {
          let name;
          do {
            name = `?occurrence${serial++}`;
          } while (terms.has(name));
          owners.set(subject, name);
        }
    const when = rule.when.map((item) =>
      occurrenceRoles.has(item[1]) && owners.has(item[0])
        ? [owners.get(item[0]), item[1], item[2]]
        : triple(item),
    );
    for (const [subject, owner] of owners) {
      when.push([owner, '@referent', subject]);
    }
    return {
      ...rule,
      when,
      then: rule.then.map(triple),
      ...(rule.guards ? { guards: rule.guards.map(triple) } : {}),
    };
  });
  return {
    ...material,
    facts,
    rules,
    skipped: [...material.skipped, ...skipped],
    bindings: accepted,
  };
}
