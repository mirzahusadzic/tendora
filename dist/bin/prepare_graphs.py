"""Bounded JSON graph preparation using the configured PENMAN runtime.

Original graphs are inputs, never rewritten. Every transformed item retains its
input occurrence; choosing a display top keeps the original claim anchor.
"""
import json
import re
import sys

import penman
from penman import constant, layout, surface, transform
from penman.exceptions import PenmanError
from penman.models.amr import model

PROFILE = "amr-roles-v1"
MAX_GRAPHS = 128
MAX_TRIPLES = 20000


def literal(value):
    return value if re.fullmatch(r"[-+]|-?\d+(?:\.\d+)?", value) else json.dumps(value, ensure_ascii=False)


def prepare(item, canonical_triple=None):
    canonical_triple = canonical_triple or (lambda t: model.deinvert(model.canonicalize(t)))
    source = item.get("graph")
    if source:
        nodes = {n["id"]: n for n in source["nodes"]}
        original = penman.decode(item["originalPenman"], model=model) if item.get("originalPenman") else None
        original_literals = {f"literal:{i}": t[2] for i, t in enumerate(t for t in original.triples if t[1] != ":instance")
            if t[2] not in original.variables()} if original else {}
        if len(nodes) != len(source["nodes"]):
            raise ValueError("Duplicate node identity")
        triples = [(n["id"], ":instance", n["concept"]) for n in nodes.values() if not n["id"].startswith("literal:")]
        origins = {triple: {"nodes": [triple[0]], "edges": []} for triple in triples}
        literals = {}
        for edge in source["edges"]:
            target = nodes[edge["to"]]
            previous = original_literals.get(target["id"])
            preserved = previous if previous is not None and target["concept"] in (str(constant.evaluate(previous)), previous.strip('"')) else literal(target["concept"])
            value = target.get("literal", preserved) if target["id"].startswith("literal:") else target["id"]
            triple = (edge["from"], edge["role"], value)
            triples.append(triple)
            origins[triple] = {"nodes": [target["id"]] if target["id"].startswith("literal:") else [], "edges": [edge["id"]]}
            if target["id"].startswith("literal:"):
                literals[triple] = target["id"]
        graph = penman.Graph(triples, top=source["top"], metadata=original.metadata if original else {},
            epidata={t: original.epidata[t] for t in triples if original and t in original.epidata})
        claim = source.get("assertionTop", source["top"])
        graph_id = source.get("id")
    else:
        graph = penman.decode(item["penman"], model=model)
        claim = graph.top
        graph_id = item.get("id")
        origins, literals = {}, {}
        for index, triple in enumerate(graph.triples):
            origins[triple] = {"nodes": [triple[0]] if triple[1] == ":instance" else [], "edges": [] if triple[1] == ":instance" else [f"e{index}"]}
    if len(graph.triples) > MAX_TRIPLES:
        raise ValueError("Graph exceeds 20000 triples")
    if len(set(graph.triples)) != len(graph.triples):
        raise ValueError("Duplicate triples need distinct occurrence handling")
    if claim not in graph.variables():
        raise ValueError("Claim anchor is missing")
    original_nodes = {t[0] for t in graph.instances()}
    node_origins = {n: {"nodes": [n], "edges": []} for n in original_nodes}
    operations = item.get("operations", [])
    if len(operations) > 12:
        raise ValueError("At most 12 transformations per graph")
    # Model canonicalization is explicit; never normalize an authored concept.
    normalized, normalized_origins, normalized_literals = [], {}, {}
    for triple in graph.triples:
        canonical = canonical_triple(triple)
        normalized.append(canonical)
        normalized_origins[canonical] = origins[triple]
        if triple in literals:
            normalized_literals[canonical] = literals[triple]
    graph = penman.Graph(normalized, top=graph.top, metadata=graph.metadata,
        epidata={canonical_triple(t): ep for t, ep in graph.epidata.items()})
    if len(set(graph.triples)) != len(graph.triples):
        raise ValueError("Canonical roles produce duplicate triples; review their occurrences")
    origins, literals = normalized_origins, normalized_literals
    diagnostics = [{"message": message, "triple": triple} for triple, messages in model.errors(graph).items() for message in messages]
    if diagnostics:
        return {"ok": False, "diagnostics": diagnostics}
    layout_only = False
    skipped = []
    for operation in operations:
        kind = operation["kind"]
        top = graph.top
        if kind == "reroot":
            top = operation["node"]
            if top not in graph.variables():
                raise ValueError("Display root is missing")
            tree = layout.reconfigure(graph, top=top, model=model)
            graph = layout.interpret(tree, model=model)
        elif kind in ("reorder", "reconfigure", "relabel"):
            tree = layout.reconfigure(graph, model=model, key=model.alphanumeric_order) if kind == "reconfigure" else layout.configure(graph, model=model)
            if kind == "reorder":
                layout.rearrange(tree, key=model.alphanumeric_order)
            if kind == "relabel":
                before = [v for v, _ in tree.nodes()]
                tree.reset_variables(fmt="a{i}")
                renamed = dict(zip(before, [v for v, _ in tree.nodes()]))
                convert = lambda t: (renamed.get(t[0], t[0]), t[1], renamed.get(t[2], t[2]) if t[1] != ":instance" else t[2])
                origins = {convert(t): value for t, value in origins.items()}
                literals = {convert(t): value for t, value in literals.items()}
                node_origins = {renamed.get(n, n): value for n, value in node_origins.items()}
                claim = renamed[claim]
                top = renamed[top]
            graph = layout.interpret(tree, model=model)
        elif kind in ("reify", "dereify", "dereify-safe", "reify-attributes"):
            old = graph
            for triple in graph.triples:
                graph.epidata.setdefault(triple, [])
            if kind == "reify":
                graph = transform.reify_edges(graph, model)
            elif kind in ("dereify", "dereify-safe"):
                graph = transform.dereify_edges(graph, model)
            else:
                graph = transform.reify_attributes(graph)
            if kind == "dereify-safe" and (claim not in graph.variables() or top not in graph.variables()):
                graph = old
                skipped.append({"kind": kind, "reason": "Preserve the authored assertion and display anchors"})
                continue
            removed = [t for t in old.triples if t not in graph.triples]
            for triple in graph.triples:
                if triple in origins:
                    continue
                # Determine the old relation represented by a new reification.
                related = []
                new_vars = set(graph.variables()) - set(old.variables())
                introduced = [n for n in (triple[0], triple[2]) if n in new_vars]
                if introduced:
                    adjacent = [t for t in graph.triples if t[0] == introduced[0] or t[1] != ":instance" and t[2] == introduced[0]]
                    endpoints = {v for t in adjacent if t[1] != ":instance" for v in (t[0], t[2])} - set(introduced)
                    related = [t for t in removed if t[0] in endpoints and t[2] in endpoints]
                    if kind == "reify-attributes":
                        value = next(t[2] for t in adjacent if t[1] == ":instance")
                        related = [t for t in removed if t[0] in endpoints and t[2] == value]
                elif kind in ("dereify", "dereify-safe"):
                    for node in set(old.variables()) - set(graph.variables()):
                        component = [t for t in removed if t[0] == node]
                        endpoints = {t[2] for t in component if t[1] != ":instance"}
                        if triple[0] in endpoints and triple[2] in endpoints:
                            related.extend(component)
                if not related:
                    raise ValueError("Transformation has no unambiguous input origin")
                provenance = {key: sorted({value for t in related for value in origins[t][key]}) for key in ("nodes", "edges")}
                origins[triple] = provenance
                if triple[1] == ":instance":
                    node_origins[triple[0]] = provenance
            if claim not in graph.variables():
                raise ValueError("Transformation would remove the claim anchor")
        elif kind == "indicate-branches":
            graph = transform.indicate_branches(graph, model)
            layout_only = True
        else:
            raise ValueError(f"Unsupported transformation: {kind}")
        if top not in graph.variables():
            raise ValueError("Transformation would remove the display root")
        graph.top = top
    # Transformations can introduce roles (e.g. dereification); apply the same
    # profile to their output and to the maps that trace them back to input.
    graph = penman.Graph([canonical_triple(t) for t in graph.triples], top=graph.top,
        metadata=graph.metadata, epidata={canonical_triple(t): ep for t, ep in graph.epidata.items()})
    origins = {canonical_triple(t): value for t, value in origins.items()}
    literals = {canonical_triple(t): value for t, value in literals.items()}
    if len(set(graph.triples)) != len(graph.triples):
        raise ValueError("Canonical roles produce duplicate triples; review their occurrences")
    variables = graph.variables()
    nodes = [{"id": t.source, "concept": t.target} for t in graph.instances()]
    edges, edge_map, node_map = [], {}, {}
    for node in nodes:
        origin = node_origins.get(node["id"])
        if origin and origin != {"nodes": [node["id"]], "edges": []}:
            node_map[node["id"]] = origin
    for index, triple in enumerate(graph.triples):
        start, role, end = triple
        if role == ":instance" or layout_only and role == model.top_role:
            continue
        origin = origins.get(triple)
        if origin is None:
            raise ValueError("Transformed relation lost its input origin")
        edge_id = origin["edges"][0] if len(origin["edges"]) == 1 else f"prepared:e{index}"
        if any(e["id"] == edge_id for e in edges):
            edge_id = f"prepared:e{index}"
        if end not in variables:
            node_id = literals.get(triple, f"literal:prepared:{index}")
            nodes.append({"id": node_id, "concept": str(constant.evaluate(end)), "literal": end})
            if origin["nodes"] != [node_id]:
                node_map[node_id] = origin
            end = node_id
        edges.append({"id": edge_id, "from": start, "role": role, "to": end})
        if origin != {"nodes": [], "edges": [edge_id]}:
            edge_map[edge_id] = origin
    output = {"top": graph.top, "assertionTop": claim, "nodes": nodes, "edges": edges}
    if graph_id is not None:
        output["id"] = graph_id
    return {"ok": True, "graph": output, "penman": penman.encode(graph, model=model, indent=2),
        "origins": {"nodes": node_map, "edges": edge_map}, "diagnostics": [], "skipped": skipped,
        **({"metadata": graph.metadata} if graph.metadata else {}),
        "alignments": [{"triple": t, "indices": list(a.indices), "prefix": a.prefix, "kind": kind}
            for kind, alignments in (("node", surface.alignments(graph)), ("role", surface.role_alignments(graph))) for t, a in alignments.items()]}


def handle(request):
    profile = request.get("profile", PROFILE)
    canonical = lambda t: model.deinvert(model.canonicalize(t))
    if profile != PROFILE:
        from amr_normalization import PROFILE as NORMALIZED_PROFILE, canonical_triple
        if profile != NORMALIZED_PROFILE:
            raise ValueError("Unsupported preparation profile")
        canonical = canonical_triple
    items = request.get("graphs", [])
    if not isinstance(items, list) or len(items) > MAX_GRAPHS:
        raise ValueError("At most 128 graphs per batch")
    results = []
    roles = request.get("roles", [])
    if not isinstance(roles, list) or len(roles) > 2000 or any(not isinstance(role, str) or not re.fullmatch(r":[\w-]+", role) for role in roles):
        raise ValueError("Invalid role inventory")
    role_map = {}
    for role in roles:
        start, normalized_role, end = canonical(("source", role, "target"))
        role_map[role] = {"role": normalized_role, "inverse": start == "target"}
    for item in items:
        try:
            results.append(prepare(item, canonical))
        except (ValueError, KeyError, TypeError, PenmanError) as error:
            results.append({"ok": False, "diagnostics": [{"message": str(error)}]})
    return {"version": 1, "profile": profile, "penmanVersion": penman.__version__, "results": results, "roles": role_map}


def serve():
    """One request per line, one response per line, until stdin closes."""
    for line in sys.stdin:
        try:
            response = handle(json.loads(line))
        except Exception as error:
            response = {"error": str(error)}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    if "--serve" in sys.argv:
        serve()
    else:
        try:
            json.dump(handle(json.load(sys.stdin)), sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        except Exception as error:
            json.dump({"error": str(error)}, sys.stdout)
            sys.stdout.write("\n")
            sys.exit(1)
