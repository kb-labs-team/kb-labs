"""Version identity for the default npm Commit project fixture."""
from __future__ import annotations

import json
from pathlib import Path


def commit_fixture_source_version(workspace: Path) -> str:
    manifest_path = workspace / "plugins/commit/package.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    name = manifest.get("name")
    version = manifest.get("version")
    if name != "@kb-labs/commit" or not isinstance(version, str) or not version:
        raise RuntimeError(f"Commit fixture source manifest is missing package identity or version: {manifest_path}")
    return version
