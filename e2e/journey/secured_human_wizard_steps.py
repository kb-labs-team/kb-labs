"""Claim registration for the secured interactive installer journey."""
from __future__ import annotations

from collections.abc import Callable


def register_secured_human_wizard_install(journey, wizard_passed: bool, host_reachable: bool):
    if not wizard_passed:
        failure = "secured TTY wizard did not apply the selected plan safely"
    elif not host_reachable:
        failure = "secured TTY wizard applied the plan but the installed host was not running and reachable"
    else:
        failure = ""
    return journey.step(
        "secured human wizard install",
        "platform.install",
        lambda: failure or None,
        cases=["S-305.1"],
        requires=("step:candidate provenance",),
        runners=("human-secured:default",),
    )


def register_secured_human_wizard_status(journey, passed: bool) -> None:
    journey.step(
        "secured human wizard running status",
        "platform.install",
        lambda: None if passed else "secured interactive install did not leave a running, reachable host",
        cases=["S-305.3"],
        requires=("step:candidate provenance",),
        runners=("human-secured:default",),
    )


def register_secured_human_wizard_auth(journey, action: Callable[[], None]) -> None:
    journey.step(
        "secured human wizard administrator API and CLI authentication",
        "auth.invite-reset",
        lambda: action(),
        cases=["S-305.2"],
        runners=("human-secured:default",),
    )
