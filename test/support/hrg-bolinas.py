"""Independent Bolinas recognition of productions emitted by the engine compiler."""
import hashlib
import importlib.util
import json
from pathlib import Path
import signal
import sys
import time

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("bolinas_manage", REPO / "tools/bolinas.py")
manage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manage)
runtime, manifest = manage.verify()
sys.path.insert(0, str(runtime))
from common.hgraph.hgraph import Hgraph
from common.grammar import Grammar
from common.cfg import NonterminalLabel
from common import log
from parser_td.td_rule import TdRule
from parser_td.parser_td import ParserTD
log.LOG = set()

def hgraph(vertices, terminals, external=()):
    graph = Hgraph()
    graph.roots = ["hub"]
    graph["hub"]
    graph.node_to_concepts["hub"] = None
    for vertex in vertices:
        graph[vertex]
        graph.node_to_concepts[vertex] = None
    for label, ends in terminals:
        graph._add_triple("hub", label, tuple(ends), warn=False)
    graph.external_nodes = {v: i for i, v in enumerate(external)}
    graph.rev_external_nodes = {i: v for v, i in graph.external_nodes.items()}
    return graph

def symbol(valence):
    return "N" + hashlib.sha256(json.dumps(valence, sort_keys=True).encode()).hexdigest()

def timeout(*_):
    raise TimeoutError("Recognition exceeded 5 seconds")

signal.signal(signal.SIGALRM, timeout)
payload = json.load(sys.stdin)
results = []
for domain in sorted(set(g["domain"] for g in payload)):
    graphs = [g for g in payload if g["domain"] == domain]
    grammar = Grammar(nodelabels=False)
    grammar.start_symbol = symbol([])
    grammar.is_synchronous = False
    grammar.rhs1_type = "hypergraph"
    grammar.rhs2_type = None
    unique = {}
    for graph in graphs:
        for rule in graph["extraction"]["rules"]:
            if not rule["terminals"] and len(rule["children"]) == 1 and len(rule["vertices"]) == rule["rank"] and rule["children"][0]["ports"] == list(range(rule["rank"])):
                continue
            head = symbol(graph["valences"][rule["id"]])
            terminals = [(t["label"], list(map(str, t["ports"]))) for t in rule["terminals"]]
            children = [(symbol(graph["valences"][c["id"]]), list(map(str, c["ports"]))) for c in rule["children"]]
            key = json.dumps([head, len(rule["vertices"]), terminals, children])
            unique[key] = (head, rule, terminals, children)
    for i, (head, rule, terminals, children) in enumerate(unique.values(), 1):
        terminals = terminals + [(NonterminalLabel(label, str(j)), ends) for j, (label, ends) in enumerate(children)]
        rhs = hgraph(list(map(str, range(len(rule["vertices"])))), terminals, list(map(str, range(rule["rank"]))))
        grammar[i] = TdRule(i, head, 0.0, rhs, None, nodelabels=False)
    grammar._compute_reachability_table_lookup()
    for graph in graphs:
        start = time.perf_counter()
        signal.setitimer(signal.ITIMER_REAL, 5)
        try:
            target = hgraph(graph["vertices"], [(t["label"], t["vertices"]) for t in graph["terminals"]])
            chart = next(ParserTD(grammar).parse_graphs([target]))
            results.append({"id": graph["id"], "domain": domain, "recognized": bool(chart.get("START")), "rules": len(grammar), "ms": (time.perf_counter() - start) * 1000})
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
print(json.dumps({"runtimeCommit": manifest["commit"], "upstream": manifest["upstreamCommit"], "results": results}))
