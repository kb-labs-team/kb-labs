"""Executable inventory shared by workflow assertions, planning, and evidence checks."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class WorkflowStepSpec:
    id: str
    name: str
    cases: tuple[str, ...] = ()
    modes: tuple[str, ...] = ("local", "secured")
    capability: str = "workflow"


WORKFLOW_STEP_SPECS = (
    WorkflowStepSpec("workflow-S-002.1", "initialize solo project workflow", ("S-002.1",)),
    WorkflowStepSpec("workflow-S-002.2", "lint solo project workflow", ("S-002.2",)),
    WorkflowStepSpec("workflow-S-002.3", "start solo project workflow", ("S-002.3",)),
    WorkflowStepSpec("workflow-S-002.4", "inspect solo project workflow result", ("S-002.4",)),
    WorkflowStepSpec("workflow-S-002.5", "find solo project workflow in history", ("S-002.5",)),
    WorkflowStepSpec("workflow-S-002.6", "report unknown workflow run", ("S-002.6",)),
    WorkflowStepSpec("workflow-S-008.1", "start active workflow for cancellation", ("S-008.1",)),
    WorkflowStepSpec("workflow-S-008.2", "request workflow cancellation", ("S-008.2",)),
    WorkflowStepSpec("workflow-S-008.3", "verify cancelled workflow status", ("S-008.3",)),
    WorkflowStepSpec("workflow-S-008.4", "reject cancellation after workflow finished", ("S-008.4",)),
    WorkflowStepSpec("workflow-S-041.17", "secured auth precedes unregistered project resolution",
                     ("S-041.17",), ("secured",)),
    WorkflowStepSpec("workflow-S-007.4", "secured CLI deny-by-default authentication",
                     ("S-007.4", "S-041.7", "S-041.8", "S-041.12"), ("secured",)),
    WorkflowStepSpec("workflow-S-027.1", "start live progress workflow", ("S-027.1",)),
    WorkflowStepSpec("workflow-S-027.2", "watch live workflow progress", ("S-027.2",)),
    WorkflowStepSpec("workflow-S-027.3", "verify live workflow terminal result", ("S-027.3",)),
    WorkflowStepSpec("workflow-prepare-rerun", "prepare failed workflow run for rerun"),
    WorkflowStepSpec("workflow-S-143.1", "rerun all workflow jobs", ("S-143.1",)),
    WorkflowStepSpec("workflow-S-143.2", "verify rerun result and inputs", ("S-143.2",)),
    WorkflowStepSpec("workflow-S-143.3", "rerun failed jobs only", ("S-143.3",)),
    WorkflowStepSpec("workflow-S-143.4", "report unknown rerun source", ("S-143.4",)),
    WorkflowStepSpec("workflow-S-044.1", "enable workflow cron schedule", ("S-044.1",)),
    WorkflowStepSpec("workflow-S-044.2", "observe scheduled workflow run and log", ("S-044.2",)),
    WorkflowStepSpec("workflow-S-044.3", "disable cron and verify no later run", ("S-044.3", "S-044.4")),
    WorkflowStepSpec("workflow-S-044.5", "enable cron again", ("S-044.5",)),
    WorkflowStepSpec("workflow-S-044.6", "report invalid cron expression", ("S-044.6",)),
    WorkflowStepSpec("workflow-S-044.7", "report unknown workflow target", ("S-044.7",)),
    WorkflowStepSpec("workflow-S-044.8", "refuse enabling plugin cron", ("S-044.8",)),
    WorkflowStepSpec("workflow-S-044.9", "accept standard cron field range", ("S-044.9",)),
    WorkflowStepSpec("workflow-install-plugin-cron", "install plugin cron fixture"),
    WorkflowStepSpec("workflow-S-006.3", "discover installed project workflow definitions", ("S-006.3",)),
    WorkflowStepSpec("workflow-S-007.5", "report workflow service health", ("S-007.5",)),
    WorkflowStepSpec("workflow-S-007.1", "start workflow with input", ("S-007.1",)),
    WorkflowStepSpec("workflow-S-007.2", "verify terminal status and submitted input",
                     ("S-007.2", "S-056.1", "PC-002.5")),
    WorkflowStepSpec("workflow-S-007.3", "verify input appears in workflow log", ("S-007.3",)),
    WorkflowStepSpec("workflow-S-029.1", "start failing workflow", ("S-029.1",)),
    WorkflowStepSpec("workflow-S-029.2", "inspect failed step and error", ("S-029.2",)),
    WorkflowStepSpec("workflow-S-009.4", "inspect failed run history details", ("S-009.4",)),
    WorkflowStepSpec("workflow-S-029.3", "inspect failing command logs", ("S-029.3",)),
    WorkflowStepSpec("workflow-S-009.1", "list recent workflow history", ("S-009.1",)),
    WorkflowStepSpec("workflow-S-009.2", "inspect selected successful run", ("S-009.2",)),
    WorkflowStepSpec("workflow-S-009.3", "inspect selected successful run logs", ("S-009.3",)),
    WorkflowStepSpec("workflow-S-056.2", "restart host and verify project availability", ("S-056.2",)),
    WorkflowStepSpec("workflow-S-056.3", "read workflow history and logs after restart", ("S-056.3",)),
    WorkflowStepSpec("workflow-S-028.1", "lint real-work workflow", ("S-028.1",)),
    WorkflowStepSpec("workflow-S-028.2", "lint real-work workflow", ("S-028.2",)),
    WorkflowStepSpec("workflow-S-028.3", "run real shell work and inspect outputs", ("S-028.3",)),
)

WORKFLOW_STEP_BY_ID = {spec.id: spec for spec in WORKFLOW_STEP_SPECS}
if len(WORKFLOW_STEP_BY_ID) != len(WORKFLOW_STEP_SPECS):
    raise ValueError("workflow domain step IDs must be unique")


def workflow_cases_for_mode(mode: str) -> tuple[str, ...]:
    if mode not in {"local", "secured"}:
        raise ValueError(f"unsupported workflow mode {mode!r}")
    return tuple(sorted({case for spec in WORKFLOW_STEP_SPECS if mode in spec.modes
                         for case in spec.cases}))


def workflow_step_ids_for_mode(mode: str) -> tuple[str, ...]:
    if mode not in {"local", "secured"}:
        raise ValueError(f"unsupported workflow mode {mode!r}")
    return tuple(spec.id for spec in WORKFLOW_STEP_SPECS if mode in spec.modes)


def workflow_step_cases(step_id: str, mode: str) -> tuple[str, ...]:
    spec = WORKFLOW_STEP_BY_ID.get(step_id)
    if spec is None:
        raise ValueError(f"unknown workflow domain step ID {step_id!r}")
    if mode not in spec.modes:
        raise ValueError(f"workflow step {step_id!r} is not registered for mode {mode!r}")
    return spec.cases
