"""Build the small SEMCAT adapter, install its pinned dependency, or verify both."""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parent.parent
sys.path.insert(0, str(HERE / "adapter"))
from semcat_provenance import digest, source_fingerprint, verify_files


def source_files(directory):
    return {str(path.relative_to(directory)): path for path in directory.rglob("*") if path.is_file()
            and not any(part in ("__pycache__", "build", "dist") or part.endswith(".egg-info")
                        for part in path.relative_to(directory).parts)}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_inputs(root):
    manifest = json.loads((root / "UPSTREAM.json").read_text())
    if manifest.get("schemaVersion") != 2:
        raise ValueError("Unsupported SEMCAT upstream manifest")
    metadata = tomllib.loads((root / "adapter" / "pyproject.toml").read_text())["project"]
    archive = manifest["archive"]
    repository = manifest["repository"]
    if archive["url"] != f'{repository}/archive/{manifest["commit"]}.tar.gz':
        raise ValueError("Archive dependency differs from the pinned commit")
    dependency = f'{manifest["package"]} @ {archive["url"]}#sha256={archive["sha256"]}'
    if metadata["dependencies"] != [dependency]:
        raise ValueError("Package dependency differs from UPSTREAM.json")
    if not manifest["files"] or any(len(value) != 64 for value in manifest["files"].values()):
        raise ValueError("Invalid runtime source hashes")
    if set(source_files(root / "adapter")) != {"semcat_bridge.py", "semcat_provenance.py", "pyproject.toml", "LICENSE"}:
        raise ValueError("Adapter must contain only its bridge, provenance, packaging and license")
    return manifest


def verify_tree(source, directory):
    verify_files(source, lambda name: directory / name)
    if source_files(directory).keys() != set(source["files"]) | {"SOURCE.json"}:
        raise ValueError("Assembled SEMCAT file inventory differs from SOURCE.json")
    if json.loads((directory / "SOURCE.json").read_text()) != source:
        raise ValueError("Assembled SEMCAT source manifest differs from the current inputs")


def assemble(root=HERE, build_root=None):
    manifest = validate_inputs(root)
    build_root = build_root or REPOSITORY / ".proj" / "semcat-builds"
    build_root.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".assemble-", dir=build_root))
    try:
        for name, path in source_files(root / "adapter").items():
            shutil.copyfile(path, temporary / name)
        for name in ("UPSTREAM.json", "README.md"):
            shutil.copyfile(root / name, temporary / name)
        source = {"schemaVersion": 2, "repository": manifest["repository"],
                  "upstreamCommit": manifest["upstream"]["commit"], "runtimeCommit": manifest["commit"],
                  "runtime": {key: manifest[key] for key in ("package", "version", "files", "archive")},
                  "files": {name: sha256(path) for name, path in sorted(source_files(temporary).items())}}
        source["runtimeFingerprint"] = digest(source["runtime"])
        source["fingerprint"] = source_fingerprint(source)
        (temporary / "SOURCE.json").write_text(json.dumps(source, indent=2) + "\n")
        destination = build_root / source["fingerprint"]
        if destination.exists():
            verify_tree(source, destination)
        else:
            temporary.rename(destination)
            temporary = None
        return destination, source
    finally:
        if temporary is not None:
            shutil.rmtree(temporary)


def verify_installation(source, python):
    code = "import json; from semcat_provenance import installed_source; print(json.dumps(installed_source()))"
    result = subprocess.run([python, "-I", "-c", code], capture_output=True, text=True)
    if result.returncode:
        raise ValueError("Installed SEMCAT verification failed:\n" + result.stderr.strip()
                         + "\nReinstall with: npm run setup:python")
    installed = json.loads(result.stdout)
    if installed["fingerprint"] != source["fingerprint"]:
        raise ValueError("Installed SEMCAT is stale: " + installed["fingerprint"][:12]
                         + "; current source: " + source["fingerprint"][:12]
                         + ". Reinstall with npm run setup:python.")
    return installed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "install", "verify"))
    parser.add_argument("--python", default=os.environ.get("PENMAN_PYTHON", sys.executable), help="Target interpreter")
    parser.add_argument("--no-deps", action="store_true", help="Use dependencies already installed in the target environment")
    parser.add_argument("--no-build-isolation", action="store_true", help="Use the target environment's setuptools")
    args = parser.parse_args()
    try:
        directory, source = assemble()
        print("Runtime:", source["runtimeCommit"], flush=True)
        print("Source:", source["fingerprint"], flush=True)
        if args.command == "build":
            print("Build:", directory)
            return
        if args.command == "install":
            command = ["uv", "pip", "install", "--python", args.python, "--reinstall-package", "tendora-semcat"]
            if args.no_deps:
                command.append("--no-deps")
            if args.no_build_isolation:
                command.append("--no-build-isolation")
            subprocess.run(command + [str(directory)], check=True)
        installed = verify_installation(source, args.python)
        print("Verified adapter", installed["packageVersion"], "and runtime", installed["runtimeVersion"], "in", args.python)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
