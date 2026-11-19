#!/usr/bin/env python3
"""Validate local image build inputs required by the Registry journey profile."""
from pathlib import Path
import sys


REQUIRED = (
    ".kb/deploy/state-daemon/node_modules",
    ".kb/deploy/state-daemon/dist",
    ".kb/deploy/marketplace-registry-app/node_modules",
    ".kb/deploy/marketplace-registry-app/dist",
    ".kb/deploy/image-default/kb.config.json",
)


def missing_inputs(root: Path) -> list[str]:
    return [item for item in REQUIRED if not (root / item).exists()]


if __name__ == "__main__":
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    missing = missing_inputs(root)
    if missing:
        print("Registry journey producer artifact is missing required image inputs: "
              + ", ".join(missing)
              + "; next: rerun the producer with e2e/journey/batch.sh prepare after deploy-input preparation",
              file=sys.stderr)
        raise SystemExit(1)
