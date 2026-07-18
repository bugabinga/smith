#!/usr/bin/env python3
"""Stable-metadata arch gate (the §3.5 `xtask arch` stand-in).

Reads `cargo metadata` and fails (exit 1) if any package declares a dependency
the rules forbid. No nightly, no cargo-pup — pure Cargo metadata, so it runs on
the same stable toolchain as everything else. Forbidden edges are hard-coded to
mirror the real §11 rule set for this fixture.
"""
import json
import subprocess
import sys

FORBIDDEN = [("wcore", "wai")]  # §11: core must never depend on ai


def main() -> int:
    out = subprocess.run(
        ["cargo", "metadata", "--format-version=1", "--no-deps"],
        capture_output=True, text=True, check=True,
    ).stdout
    meta = json.loads(out)
    by_name = {p["name"]: p for p in meta["packages"]}
    violations = []
    for src, dst in FORBIDDEN:
        pkg = by_name.get(src)
        if not pkg:
            continue
        if any(d["name"] == dst for d in pkg["dependencies"]):
            violations.append((src, dst))
    if violations:
        for s, d in violations:
            print(f"ARCH VIOLATION: {s} -> {d} is forbidden by §11", file=sys.stderr)
        return 1
    print("arch gate clean: no forbidden inter-crate edges")
    return 0


if __name__ == "__main__":
    sys.exit(main())
