"""Install or verify the pinned Bolinas fork used by optional research checks."""

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PIN = Path(__file__).with_suffix(".json")
CHECKOUT = ROOT / ".deps" / "bolinas"


def pin():
    value = json.loads(PIN.read_text())
    if (value["repository"] != "https://github.com/mirzahusadzic/bolinas"
            or not re.fullmatch(r"[a-f0-9]{40}", value["commit"])):
        raise ValueError("Invalid Bolinas dependency pin")
    return value


def git(directory, *args):
    return subprocess.run(
        ["git", "-C", str(directory), *args], check=True,
        capture_output=True, text=True,
    ).stdout.strip()


def verify(directory=CHECKOUT):
    manifest = pin()
    if not (directory / ".git").is_dir():
        raise ValueError("Bolinas is not installed. Run npm run setup:bolinas.")
    if git(directory, "rev-parse", "HEAD") != manifest["commit"]:
        raise ValueError("Bolinas revision differs from tools/bolinas.json. "
                         "Move .deps/bolinas aside and run npm run setup:bolinas.")
    if git(directory, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("The Bolinas checkout has local changes; restore or move it aside.")
    return directory, manifest


def install():
    if CHECKOUT.exists():
        return verify()
    manifest = pin()
    CHECKOUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".bolinas-", dir=CHECKOUT.parent))
    try:
        git(temporary, "init", "--quiet")
        git(temporary, "remote", "add", "origin", manifest["repository"] + ".git")
        git(temporary, "fetch", "--depth=1", "origin", manifest["commit"])
        git(temporary, "checkout", "--detach", "FETCH_HEAD")
        verify(temporary)
        temporary.rename(CHECKOUT)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return verify()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "verify", "test"))
    args = parser.parse_args()
    try:
        directory, manifest = install() if args.command == "install" else verify()
        print("Bolinas:", manifest["commit"], "in", directory, flush=True)
        if args.command == "test":
            subprocess.run([sys.executable, "-B", str(directory / "test_port.py")], check=True)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        detail = error.stderr if isinstance(error, subprocess.CalledProcessError) else str(error)
        parser.exit(1, (detail or str(error)).strip() + "\n")


if __name__ == "__main__":
    main()
