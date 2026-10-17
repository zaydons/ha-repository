#!/usr/bin/env python3
"""Read or bump the Homelab Dashboard app version.

Edits exactly two files under <root>/homelab: the `version:` line in
config.yaml and a new entry at the top of CHANGELOG.md. It treats both files
and the note as plain text: no YAML loading, no imports from the checkout,
nothing executed. The workflows run it from the base branch (main), so a pull
request can't change this script for its own run.

Usage:
  homelab_version.py get  <root>
  homelab_version.py bump <root> <patch|minor> <note>

`bump` prints the new version. The note is reduced to one line of plain text.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

VERSION_LINE = re.compile(r'^version:\s*"?(\d+)\.(\d+)\.(\d+)"?\s*$', re.MULTILINE)
CHANGELOG_TITLE = "# Changelog\n"
MAX_NOTE = 300


def fail(msg: str) -> None:
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


def read_version(config: Path) -> tuple[int, int, int]:
    matches = VERSION_LINE.findall(config.read_text(encoding="utf-8"))
    if len(matches) != 1:
        fail(f"expected exactly one 'version: \"X.Y.Z\"' line in {config}")
    major, minor, patch = (int(part) for part in matches[0])
    return major, minor, patch


def clean_note(note: str) -> str:
    # One line, printable text only, no Markdown structure at the start.
    note = re.sub(r"[\x00-\x1f\x7f]+", " ", note)
    note = re.sub(r"\s+", " ", note).strip().lstrip("#>-*+ ").strip()
    if not note:
        fail("the changelog note is empty")
    if len(note) > MAX_NOTE:
        note = note[: MAX_NOTE - 1].rstrip() + "…"
    return note


def bump(root: Path, kind: str, note: str) -> str:
    config = root / "homelab" / "config.yaml"
    changelog = root / "homelab" / "CHANGELOG.md"
    note = clean_note(note)  # validate before touching any file
    major, minor, patch = read_version(config)
    if kind == "patch":
        patch += 1
    elif kind == "minor":
        minor, patch = minor + 1, 0
    else:
        fail(f"bump must be patch or minor, not {kind!r}")
    new = f"{major}.{minor}.{patch}"

    log = changelog.read_text(encoding="utf-8")
    if not log.startswith(CHANGELOG_TITLE):
        fail(f"{changelog} must start with '{CHANGELOG_TITLE.strip()}'")
    if re.search(rf"^## {re.escape(new)}\s*$", log, re.MULTILINE):
        fail(f"{changelog} already has an entry for {new}")

    text = config.read_text(encoding="utf-8")
    text = VERSION_LINE.sub(f'version: "{new}"', text, count=1)
    config.write_text(text, encoding="utf-8")
    body = log[len(CHANGELOG_TITLE):].lstrip("\n")
    entry = f"## {new}\n\n- {note}\n\n"
    changelog.write_text(f"{CHANGELOG_TITLE}\n{entry}{body}", encoding="utf-8")
    return new


def main(argv: list[str]) -> None:
    if len(argv) == 3 and argv[1] == "get":
        print("{}.{}.{}".format(*read_version(Path(argv[2]) / "homelab" / "config.yaml")))
    elif len(argv) == 5 and argv[1] == "bump":
        print(bump(Path(argv[2]), argv[3], argv[4]))
    else:
        fail(__doc__.split("Usage:")[1].strip())


if __name__ == "__main__":
    main(sys.argv)
