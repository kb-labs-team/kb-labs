"""Producer-owned contract for journey scoreboard release gates."""
from __future__ import annotations

from typing import Any


RELEASE_GATING_MODES = ("local",)


class ReleaseGateContractError(ValueError):
    """A scoreboard release-gate declaration violates the producer contract."""


def release_gate_modes(scoreboard: dict[str, Any]) -> list[str]:
    """Return the producer-declared release gates or reject malformed/drifted data."""
    release_gate = scoreboard.get("releaseGate")
    modes = release_gate.get("modes") if isinstance(release_gate, dict) else None
    expected_modes = list(RELEASE_GATING_MODES)
    if modes != expected_modes:
        raise ReleaseGateContractError(
            f"scoreboard releaseGate.modes must equal {expected_modes!r}; got {modes!r}"
        )
    return modes
