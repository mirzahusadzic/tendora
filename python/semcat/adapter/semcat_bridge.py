# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Mirza Husadzic
"""Bounded JSON transport around the authored SEMCAT implementations."""
import json
import math
import os
import signal
import sys
import warnings
from importlib.metadata import version

os.environ.setdefault("SOLVER_NAME", "HIGHS")
import pandas as pd
import penman
from penman.models.amr import model
from rose import RoSE, scorer_hash
from smatchpp import Smatchpp, solvers, preprocess
from smatchpp.align import GraphAligner
from smatchpp.score import IDTripleMatcher
from smatchpp.eval_statistics import f1_score
from calc_SEMCAT import build_semcat
from amr_normalization import PROFILE as NORMALIZATION_PROFILE
from semcat_provenance import installed_source

PROFILE = "semcat-runtime-e00a02b-tendora-v3"
UPSTREAM = "5c5d4bd5a15cf1e1a0db05b16610ee39a90f7c2d"
original_matchings = scorer_hash._enumerate_all_matching


class TraceAligner(GraphAligner):
    def align(self, *args):
        result = super().align(*args)
        self.mapping = self._get_var_map(result[0], result[1])
        return result


def compare_pair(pair, options, resources=None):
    seconds = options.get("timeLimitSeconds", 2)
    max_pairs = options.get("maxPairs", 20000)
    max_mappings = options.get("maxMappings", 100000)
    alpha, iterations = options.get("alpha", 0.25), options.get("iterations", 3)
    if not 0 < seconds <= 30 or not 0 <= alpha <= 1 or not isinstance(iterations, int) or not 2 <= iterations <= 8:
        raise ValueError("Invalid comparison parameters")
    if not isinstance(max_pairs, int) or max_pairs < 1 or not isinstance(max_mappings, int) or max_mappings < 1:
        raise ValueError("Invalid comparison bounds")
    graphs = [penman.decode(pair[key], model=model) for key in ["reference", "hypothesis"]]
    for graph in graphs:
        if not graph.instances() or any(not t.target for t in graph.instances()):
            raise ValueError("A graph must contain defined concepts")
        if len(graph.triples) > 2000:
            raise ValueError("Comparison graph exceeds 2000 triples")
        if options.get("ignoreWiki", True):
            graph.triples = [t for t in graph.triples if t[1] != ":wiki"]
    if len(graphs[0].variables()) * len(graphs[1].variables()) > max_pairs:
        raise TimeoutError("Alignment pair limit")

    def bounded_matchings(left, right):
        count = 1
        for label in left.keys() & right.keys():
            a, b = len(left[label]), len(right[label])
            count *= math.perm(max(a, b), min(a, b))
            if count > max_mappings:
                raise TimeoutError("Global correspondence limit")
        return original_matchings(left, right)
    scorer_hash._enumerate_all_matching = bounded_matchings

    matcher = IDTripleMatcher()
    solver = solvers.ILP(max_seconds=seconds)
    aligner = TraceAligner(matcher, solver)
    # The authored scorer/extractor hold read-only frame tables. Build them once
    # per batch; keep each pair's solver, alignment and normalization separate.
    if resources is None:
        resources = {}
    local = Smatchpp(triplematcher=matcher, graph_aligner=aligner, alignmentsolver=solver,
        graph_standardizer=preprocess.AMRGraphStandardizer(lower=False, remove_quote=False, relabel_vars=False),
        **resources)
    resources.update(graph_scorer=local.graph_scorer, subgraph_extractor=local.subgraph_extractor)
    matches, bounds, _ = local.process_pair(*(penman.encode(g, model=model) for g in graphs))
    local_score = float(f1_score(matches["main"]))
    lower, upper = map(float, bounds)
    complete = abs(lower - upper) < 1e-6 and abs(lower - float(matches["main"][0])) < 1e-6
    global_score = float(RoSE(num_iterations=iterations, ignore_wiki_role=options.get("ignoreWiki", True)).compute_graph_similarity(*graphs))
    frame = pd.DataFrame([
        dict(index=0, name="pair", item=0, metric="ESMATCH++mac", score=local_score),
        dict(index=0, name="pair", item=0, metric="RoSE3-99", score=global_score),
    ])
    aggregate = build_semcat(frame, alpha=alpha, require_both=True)
    score = float(aggregate.loc[aggregate.metric == "SEMCAT", "score"].iloc[0])
    reference, hypothesis = local.last_normalization
    correspondence = [[reference["origins"][a[3:]], hypothesis["origins"][b[3:]]]
        for a, b in aligner.mapping if a and b and a[3:] in reference["origins"] and b[3:] in hypothesis["origins"]]
    return dict(profile=PROFILE, score=score if complete else None, complete=complete,
        local=dict(score=local_score if complete else None, objectiveLowerBound=lower, objectiveUpperBound=upper,
                   complete=complete, correspondence=correspondence, correspondenceComplete=False),
        global_=dict(score=global_score, complete=True, iterations=iterations),
        standardized=dict(reference=reference["penman"], hypothesis=hypothesis["penman"]),
        origins=dict(reference=reference["origins"], hypothesis=hypothesis["origins"]))


def compare(request):
    source = installed_source()
    pairs = request.get("comparisons", [])
    if not isinstance(pairs, list) or len(pairs) > 128:
        raise ValueError("At most 128 comparisons")
    timeout = request.get("pairTimeoutSeconds", max(5, request.get("timeLimitSeconds", 2) + 1))
    if not 0 < timeout <= 60:
        raise ValueError("Invalid pair timeout")
    previous = signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("Pair deadline")))
    results, resources = [], {}
    try:
        for pair in pairs:
            signal.setitimer(signal.ITIMER_REAL, timeout)
            try:
                result = compare_pair(pair, request, resources)
                result["global"] = result.pop("global_")
            except Exception as error:
                result = dict(profile=PROFILE, score=None, complete=False,
                    state="limited" if isinstance(error, TimeoutError) else "error", reason=str(error))
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
            results.append(result)
    finally:
        signal.signal(signal.SIGALRM, previous)
        scorer_hash._enumerate_all_matching = original_matchings
    return dict(version=1, profile=PROFILE, normalizationProfile=NORMALIZATION_PROFILE, upstream=UPSTREAM, source=source, results=results,
        parameters=dict(alpha=request.get("alpha", 0.25), aggregation="authored: weights 1 and 1-alpha",
                        solver="Python-MIP/" + os.environ["SOLVER_NAME"]),
        versions={name: version(name) for name in ["tendora-semcat", "penman", "networkx", "mip", "highspy", "pandas", "numpy", "scipy", "semcat-runtime"]})


def main():
    warnings.filterwarnings("ignore", message="The hashes produced for directed graphs changed")
    try:
        raw = sys.stdin.read(16 * 1024 * 1024 + 1)
        if len(raw.encode()) > 16 * 1024 * 1024:
            raise ValueError("Comparison input exceeds 16 MB")
        json.dump(compare(json.loads(raw)), sys.stdout, ensure_ascii=False, allow_nan=False)
    except Exception as error:
        json.dump({"error": str(error)}, sys.stdout)
        sys.exit(1)


if __name__ == "__main__":
    main()
