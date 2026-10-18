"""Offline adapter assembly and dependency-drift regression tests."""
import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import manage
from semcat_provenance import verify_files, verify_runtime


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="tendora-semcat-test-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.root = self.directory / "vendor"
        shutil.copytree(manage.HERE, self.root, ignore=shutil.ignore_patterns("__pycache__", "build", "dist", "*.egg-info"))
        self.builds = self.directory / "builds"

    def assemble(self):
        return manage.assemble(self.root, self.builds)

    def test_reproducible_adapter_without_bundled_runtime(self):
        directory, source = self.assemble()
        self.assertEqual((directory, source), self.assemble())
        self.assertEqual(len(source["runtime"]["files"]), 24)
        self.assertNotIn("calc_SEMCAT.py", source["files"])
        self.assertFalse(list(self.builds.glob(".assemble-*")))

    def test_dependency_pin_and_manifest_must_agree(self):
        path = self.root / "UPSTREAM.json"
        manifest = json.loads(path.read_text())
        manifest["commit"] = "0" * 40
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "dependency differs"):
            self.assemble()

    def test_adapter_change_has_new_fingerprint(self):
        directory, source = self.assemble()
        path = self.root / "adapter" / "semcat_bridge.py"
        path.write_bytes(path.read_bytes() + b"\n# adapter change\n")
        changed_directory, changed = self.assemble()
        self.assertNotEqual(source["fingerprint"], changed["fingerprint"])
        self.assertNotEqual(directory, changed_directory)
        self.assertEqual(source["runtimeFingerprint"], changed["runtimeFingerprint"])

    def test_runtime_change_has_new_fingerprint(self):
        _, source = self.assemble()
        path = self.root / "UPSTREAM.json"
        manifest = json.loads(path.read_text())
        manifest["files"]["calc_SEMCAT.py"] = "0" * 64
        path.write_text(json.dumps(manifest))
        _, changed = self.assemble()
        self.assertNotEqual(source["fingerprint"], changed["fingerprint"])
        self.assertNotEqual(source["runtimeFingerprint"], changed["runtimeFingerprint"])

    def test_adapter_cannot_bundle_runtime_modules(self):
        (self.root / "adapter" / "calc_SEMCAT.py").write_text("pass\n")
        with self.assertRaisesRegex(ValueError, "Adapter must contain only"):
            self.assemble()

    def test_payload_manifest_and_inventory_drift_are_rejected(self):
        directory, source = self.assemble()
        locate = lambda name: directory / name
        verify_files(source, locate)
        file = locate("semcat_bridge.py")
        original = file.read_bytes()
        file.write_bytes(original + b"\n# altered\n")
        with self.assertRaisesRegex(ValueError, "semcat_bridge.py"):
            verify_files(source, locate)
        file.write_bytes(original)
        altered = copy.deepcopy(source)
        altered["files"]["semcat_bridge.py"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "fingerprint does not match"):
            verify_files(altered, locate)
        (directory / "extra.py").write_text("pass\n")
        with self.assertRaisesRegex(ValueError, "file inventory"):
            manage.verify_tree(source, directory)

    def test_changed_existing_build_is_rejected(self):
        directory, _ = self.assemble()
        (directory / "semcat_bridge.py").write_text("pass\n")
        with self.assertRaisesRegex(ValueError, "source differs from its manifest"):
            self.assemble()

    def test_runtime_version_modified_files_and_shadowed_imports_are_rejected(self):
        file = self.directory / "calc_SEMCAT.py"
        file.write_text("# fixture runtime\n")
        runtime = {"version": "0.1.0", "files": {file.name: manage.sha256(file)}}
        package = SimpleNamespace(version="0.1.0", files=[file.name], locate_file=lambda _: file)
        with patch("semcat_provenance.find_spec", return_value=SimpleNamespace(origin=str(file))):
            verify_runtime(runtime, package)
            package.version = "0.2.0"
            with self.assertRaisesRegex(ValueError, "runtime version"):
                verify_runtime(runtime, package)
            package.version = "0.1.0"
            file.write_text("# modified runtime\n")
            with self.assertRaisesRegex(ValueError, "Runtime source differs"):
                verify_runtime(runtime, package)
        file.write_text("# fixture runtime\n")
        with patch("semcat_provenance.find_spec", return_value=SimpleNamespace(origin="/another/checkout.py")):
            with self.assertRaisesRegex(ValueError, "Loaded SEMCAT module differs"):
                verify_runtime(runtime, package)

    def test_stale_installation_is_rejected(self):
        _, source = self.assemble()
        result = manage.subprocess.CompletedProcess([], 0, json.dumps({"fingerprint": "old-installed-source"}), "")
        with patch.object(manage.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(ValueError, "Installed SEMCAT is stale"):
                manage.verify_installation(source, "unused-python")


if __name__ == "__main__":
    unittest.main()
