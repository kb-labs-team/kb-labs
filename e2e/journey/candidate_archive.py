"""List built journey pack-extra outputs that must travel to batch consumers."""
from __future__ import annotations

import json
import sys
from pathlib import Path, PurePosixPath


def pack_extra_dist_paths(workspace_root: Path) -> list[str]:
    registry_path = workspace_root / "e2e" / "scripts" / "pack-extras.json"
    try:
        extras = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("declared journey pack-extra registry is missing or invalid") from error
    if not isinstance(extras, list):
        raise ValueError("declared journey pack-extra registry must be an array")

    paths: list[str] = []
    for index, extra in enumerate(extras):
        directory = extra.get("directory") if isinstance(extra, dict) else None
        if not isinstance(directory, str) or not directory:
            raise ValueError(f"journey pack-extra entry {index} has no directory")
        relative = PurePosixPath(directory)
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise ValueError(f"journey pack-extra entry {index} has an unsafe directory")
        dist_path = workspace_root.joinpath(*relative.parts, "dist")
        if not dist_path.is_dir():
            raise ValueError(f"declared journey pack-extra output is missing: {relative}/dist")
        paths.append(f"./{relative.as_posix()}/dist")
    return paths


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: candidate_archive.py <workspace-root>", file=sys.stderr)
        return 2
    try:
        for path in pack_extra_dist_paths(Path(sys.argv[1]).resolve()):
            print(path)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
