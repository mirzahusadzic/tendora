"""Derive the offline lexical index from the pinned public PropBank archive."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

HERE = Path(__file__).resolve().parent
RELEASE = "v3.4.0"
COMMIT = "4087fa9ab5c40907c34ff91a56acc2cab1670145"
ARCHIVE_SHA256 = "b59a978cb05fd7e2d9f175633bf93716ca279b42dd55ab8a425599f5040d67b8"


def derive(archive):
    raw = Path(archive).read_bytes()
    if hashlib.sha256(raw).hexdigest() != ARCHIVE_SHA256:
        raise ValueError("PropBank archive does not match the pinned SHA-256")
    frames = {}
    duplicates = []
    with zipfile.ZipFile(archive) as source:
        for path in sorted(source.namelist()):
            if "/frames/" not in path or not path.endswith(".xml"):
                continue
            root = ET.fromstring(source.read(path))
            for roleset in root.iter("roleset"):
                identifier = re.sub(r"\.(\d+)$", r"-\1", roleset.attrib["id"]).replace("_", "-")
                aliases = sorted({
                    a.text.strip()
                    for a in roleset.findall("./aliases/alias")
                    if a.text and a.text.strip()
                })
                # Annotated predicate surfaces include irregular inflections. Do
                # not collect argument text as evidence for a predicate lemma.
                forms = sorted({
                    " ".join(r.itertext()).strip()
                    for r in roleset.findall("./example/propbank/rel")
                } - {""})
                roles = {
                    ":ARG" + r.attrib["n"]: r.get("descr", "")
                    for r in roleset.findall("./roles/role")
                    if r.get("n", "").isdigit()
                }
                entry = [
                    roleset.get("name", ""), aliases, forms, roles,
                    [path.split("/frames/", 1)[1]],
                ]
                if identifier in frames:
                    duplicates.append(identifier)
                    previous = frames[identifier]
                    entry[0] = "; ".join(sorted({previous[0], entry[0]}))
                    for column in (1, 2, 4):
                        entry[column] = sorted(set(previous[column] + entry[column]))
                    entry[3] = {
                        role: "; ".join(sorted({
                            v for v in [previous[3].get(role), roles.get(role)] if v
                        }))
                        for role in sorted(set(previous[3]) | set(roles))
                    }
                frames[identifier] = entry
        license_path = next(p for p in source.namelist() if p.endswith("/LICENSE"))
        license_bytes = source.read(license_path)
    source = {
        "repository": "https://github.com/propbank/propbank-frames",
        "release": RELEASE,
        "commit": COMMIT,
        "archive": "https://codeload.github.com/propbank/propbank-frames/zip/refs/tags/" + RELEASE,
        "archiveSha256": ARCHIVE_SHA256,
        "license": "CC-BY-SA-4.0",
    }
    # One roleset per line keeps changes to this derived resource reviewable.
    rows = [
        json.dumps(k) + ":" + json.dumps(frames[k], ensure_ascii=False, separators=(",", ":"))
        for k in sorted(frames)
    ]
    index = (
        '{"schema":"propbank-lexicon-v1","source":'
        + json.dumps(source, separators=(",", ":"))
        + ',"frames":{\n' + ',\n'.join(rows) + '\n}}\n'
    ).encode()
    manifest = {
        **source,
        "frames": len(frames),
        "mergedRolesets": duplicates,
        "indexSha256": hashlib.sha256(index).hexdigest(),
        "licenseSha256": hashlib.sha256(license_bytes).hexdigest(),
    }
    return {
        "lexicon.json": index,
        "LICENSE": license_bytes,
        "UPSTREAM.json": (json.dumps(manifest, indent=2) + "\n").encode(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", nargs="?", help="Downloaded, pinned v3.4.0 ZIP")
    parser.add_argument(
        "--check", action="store_true",
        help="Check hashes, and regeneration if an archive is supplied",
    )
    args = parser.parse_args()
    if args.check:
        manifest = json.loads((HERE / "UPSTREAM.json").read_text())
        for name, key in [("lexicon.json", "indexSha256"), ("LICENSE", "licenseSha256")]:
            if hashlib.sha256((HERE / name).read_bytes()).hexdigest() != manifest[key]:
                raise ValueError("Changed PropBank resource: " + name)
        if args.archive:
            for name, content in derive(args.archive).items():
                if (HERE / name).read_bytes() != content:
                    raise ValueError("Regeneration differs: " + name)
        print("PropBank lexical resource verified")
    else:
        if not args.archive:
            parser.error("An archive is required to regenerate")
        for name, content in derive(args.archive).items():
            (HERE / name).write_bytes(content)
        print("Wrote PropBank lexical resource")


if __name__ == "__main__":
    main()
