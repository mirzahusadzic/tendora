# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Mirza Husadzic
"""Verify adapter and pinned runtime contents without loading the solver."""
import hashlib
import json
from importlib.metadata import distribution
from importlib.util import find_spec
from pathlib import Path, PurePosixPath


def digest(value):
    data = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(data.encode()).hexdigest()


def source_fingerprint(source):
    return digest({key: source[key] for key in (
        "schemaVersion", "repository", "upstreamCommit", "runtimeCommit", "runtime", "files"
    )})


def check_files(files, locate, label):
    changed = []
    for name, expected in files.items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Invalid source path: " + name)
        path = locate(name)
        if path is None or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            changed.append(name)
    if changed:
        raise ValueError(label + " source differs from its manifest: " + ", ".join(changed))


def verify_files(source, locate):
    if source.get("schemaVersion") != 2 or source["fingerprint"] != source_fingerprint(source):
        raise ValueError("SEMCAT source manifest fingerprint does not match its contents")
    if source["runtimeFingerprint"] != digest(source["runtime"]):
        raise ValueError("SEMCAT runtime fingerprint does not match its contents")
    check_files(source["files"], locate, "Adapter")


def verify_runtime(runtime, package):
    if package.version != runtime["version"]:
        raise ValueError("Installed SEMCAT runtime version differs from its manifest")
    records = {str(item): package.locate_file(item).resolve() for item in package.files or []}
    check_files(runtime["files"], records.get, "Runtime")
    # Reject imports shadowed by a different checkout or distribution.
    for name, path in records.items():
        if name not in runtime["files"] or not name.endswith(".py"):
            continue
        if "/" not in name or name.count("/") == 1 and name.endswith("/__init__.py"):
            module = name.removesuffix("/__init__.py").removesuffix(".py")
            spec = find_spec(module)
            if spec is None or not spec.origin or Path(spec.origin).resolve() != path:
                raise ValueError("Loaded SEMCAT module differs from the installed runtime: " + module)


def installed_source():
    package = distribution("tendora-semcat")
    records = {str(item): package.locate_file(item).resolve() for item in package.files or []}

    def locate(name):
        if name in records:
            return records[name]
        suffix = "/share/tendora-semcat/" + name
        return next((path for key, path in records.items() if key.endswith(suffix)), None)

    manifest = locate("SOURCE.json")
    if manifest is None:
        raise ValueError("Installed SEMCAT has no source manifest; reinstall with python/semcat/manage.py")
    if records.get("semcat_provenance.py") != Path(__file__).resolve():
        raise ValueError("Loaded SEMCAT provenance module differs from the installed distribution")
    bridge = find_spec("semcat_bridge")
    if bridge is None or not bridge.origin or Path(bridge.origin).resolve() != records.get("semcat_bridge.py"):
        raise ValueError("Loaded SEMCAT adapter differs from the installed distribution")
    source = json.loads(manifest.read_text())
    verify_files(source, locate)
    verify_runtime(source["runtime"], distribution(source["runtime"]["package"]))
    return {key: source[key] for key in (
        "repository", "upstreamCommit", "runtimeCommit", "runtimeFingerprint", "fingerprint"
    )} | {"packageVersion": package.version, "runtimeVersion": source["runtime"]["version"]}
