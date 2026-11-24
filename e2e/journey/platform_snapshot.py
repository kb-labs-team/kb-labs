"""Helpers for checking that installed-platform fixtures remain unchanged."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from journey_resources import active_platform_root


def _platform_snapshot(platform_root: Path) -> tuple[str, tuple[tuple[str, str], ...]]:
    """Capture the sealed receipt and every installed package version."""
    content_root = active_platform_root(platform_root)
    receipt = content_root / ".kb" / "v2" / "receipt.json"
    receipt_hash = hashlib.sha256(receipt.read_bytes()).hexdigest()
    packages = []
    for package_file in sorted((content_root / "node_modules").rglob("package.json")):
        try:
            package = json.loads(package_file.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        name = package.get("name")
        version = package.get("version")
        if isinstance(name, str) and isinstance(version, str):
            packages.append((str(package_file.relative_to(content_root / "node_modules")), f"{name}@{version}"))
    return receipt_hash, tuple(packages)
