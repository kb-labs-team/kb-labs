#!/usr/bin/env python3
"""Run the journey while recording a result if Python startup itself fails."""
from __future__ import annotations
from journey_values import journey_value

import json
import os
import runpy
import shlex
import signal
import sys
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from platform_state_dump import dump_platform_state, failure_dump_environment
from dispatch_registry import RUNNERS
from scoreboard import write_scoreboards
from journey_resources import case_catalog_root, journey_module
from invocations import print_report_text, write_report_json, write_report_text
from journey_selection import JourneySelection, JourneySelectionError, read_journey_selection, use_journey_selection


class RunnerSignalTermination(RuntimeError):
    def __init__(self, signum: int):
        self.signum = signum
        super().__init__(f"received {signal.Signals(signum).name}")


@contextmanager
def _runner_signal_handlers():
    previous = {}

    def terminate(signum, _frame):
        raise RunnerSignalTermination(signum)

    try:
        for name in ("SIGTERM", "SIGINT", "SIGHUP"):
            signum = getattr(signal, name, None)
            if signum is not None:
                previous[signum] = signal.signal(signum, terminate)
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def _failure_message(error: BaseException) -> str:
    if isinstance(error, SystemExit):
        code = error.code
        return f"SystemExit: {code!r}"
    return f"{error.__class__.__name__}: {error}"


def write_case_scoreboards(summary_path: str | Path) -> None:
    report_dir = Path(summary_path).parent
    write_scoreboards(report_dir, case_catalog_root())


def record_runner_failure(summary_path: str | Path, mode: str, error: BaseException, phase: str,
                          selection: JourneySelection | None = None) -> None:
    name = "journey selection metadata" if phase == "selection" else "runner startup" if phase == "startup" else "runner crash"
    step = {
        "name": name,
        "capability": "journey.runner",
        "mode": mode,
        "status": "FAIL",
        "duration_seconds": 0.0,
        "message": _failure_message(error),
    }
    target = Path(summary_path).with_name(f"service-{mode}.json")
    try:
        result = json.loads(target.read_text())
        if not isinstance(result, dict) or not isinstance(result.get("steps"), list):
            raise ValueError("existing journey result has an invalid shape")
    except (OSError, json.JSONDecodeError, ValueError):
        result = {
            "schema": "kb.service-journey/v1",
            "run_id": f"runner-{mode}",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "duration_seconds": 0.0,
            "status": "FAIL",
            "first_failure": step,
            "steps": [],
        }
    result["steps"].append(step)
    result["status"] = "FAIL"
    result["first_failure"] = result.get("first_failure") or step
    if selection and selection.requested:
        case_run = result.get("case_run")
        if not isinstance(case_run, dict):
            case_run = {
                "schema": "kb.qa-case-run/v2",
                "runId": result.get("run_id", f"runner-{mode}"),
                "mode": mode,
                "claims": [],
            }
        recorded_selection = case_run.get("selection", [])
        if not isinstance(recorded_selection, list) or any(not isinstance(item, str) for item in recorded_selection):
            recorded_selection = []
        case_run["selection"] = sorted(set(recorded_selection).union(selection.requested))
        case_run["selectedClaims"] = sorted(selection.claims)
        case_run["selectedOwningSteps"] = {
            name: sorted(claims) for name, claims in selection.owning_steps.items()
        }
        result["case_run"] = case_run
    write_report_json(target, result)


def _record_process_failure(summary_path: str | Path, mode: str, error: BaseException,
                            phase: str, namespace: dict | None = None,
                            selection: JourneySelection | None = None) -> None:
    report = Path(summary_path)
    reason = _failure_message(error)
    diagnostic = report.with_name("journey-diagnostics.log")
    diagnostic_written = False
    try:
        trace = "".join(traceback.format_exception(type(error), error, error.__traceback__))
        write_report_text(diagnostic, f"\n== Journey {phase} failure ==\n{reason}\n{trace}\n", append=True)
        diagnostic_written = True
    except BaseException as diagnostic_error:
        print_report_text(f"Journey failure diagnostics could not be written: {diagnostic_error}",
                          stream=sys.stderr, flush=True)

    try:
        from service_steps import Journey

        journey = namespace.get("CASE_JOURNEY") if namespace is not None else None
        if isinstance(journey, Journey):
            journey.write_json(report.with_name(f"service-{mode}.json"))
    except BaseException as partial_error:
        print_report_text(f"Journey partial results could not be written: {partial_error}",
                          stream=sys.stderr, flush=True)

    try:
        record_runner_failure(summary_path, mode, error, phase, selection)
        write_case_scoreboards(summary_path)
    except BaseException as write_error:
        print_report_text(f"Journey runner {phase} failed; could not write result: {write_error}",
                          stream=sys.stderr, flush=True)
    message = f"Journey runner crashed: {reason}" if phase == "crash" else f"Journey runner {phase} failed: {reason}"
    if diagnostic_written:
        message += f"\nNext: {shlex.join(['cat', str(diagnostic)])}"
    print_report_text(message, stream=sys.stdout, flush=True)


def run_runner(runner_path: str | Path, summary_path: str | Path, mode: str,
               selection: JourneySelection | None = None) -> int:
    namespace = None
    phase = "startup"
    exit_code = 0
    try:
        with _runner_signal_handlers():
            namespace = runpy.run_path(str(runner_path), run_name="journey_runner_module")
            phase = "crash"
            exit_code = int(namespace["main"]())
    except BaseException as error:
        if isinstance(error, SystemExit) and error.code in (None, 0):
            exit_code = 0
        else:
            try:
                report = Path(summary_path)
                environment = namespace.get("env") if namespace is not None else None
                dump = namespace.get("STATE_DUMP_GUARD") if namespace is not None else None
                write_dump = dump.dump if dump is not None else dump_platform_state
                write_dump(
                    namespace.get("PLATFORM", Path.home() / "kb-platform") if namespace is not None
                    else Path.home() / "kb-platform",
                    report.parent, mode=mode,
                    front=journey_value("KB_JOURNEY_FRONT_DOOR", "agent"),
                    scenario=journey_value("KB_JOURNEY_SCENARIO", "commit"),
                    variant=journey_value("KB_JOURNEY_VARIANT", "default"),
                    first_failure=_failure_message(error),
                    env=failure_dump_environment(
                        namespace.get("ACTIVE_MAIN_ENV") if namespace is not None else None,
                        namespace.get("LAST_COMMAND_ENV") if namespace is not None else None,
                        environment or os.environ,
                    ),
                    cwd=namespace.get("LAST_COMMAND_CWD") if namespace is not None else None,
                    admin_password="JourneyPassw0rd!" if mode == "secured" else "",
                )
            except BaseException as dump_error:
                print_report_text(f"Journey state dump failed: {dump_error.__class__.__name__}: {dump_error}",
                                  stream=sys.stderr, flush=True)
            _record_process_failure(summary_path, mode, error, phase, namespace, selection)
            exit_code = 1
    finally:
        cleanup = namespace.get("cleanup") if namespace is not None else None
        if callable(cleanup):
            try:
                cleanup()
            except BaseException as cleanup_error:
                _record_process_failure(summary_path, mode, cleanup_error, "crash", namespace, selection)
                exit_code = 1
    return exit_code


def main() -> int:
    summary_path = journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md")
    mode = "secured" if journey_value("KB_JOURNEY_VARIANT", "default").endswith("secured") else "local"
    selection = None
    try:
        selection = read_journey_selection(os.environ, strict=True)
        with use_journey_selection(selection):
            runner = RUNNERS.get(selection.runner_selector)
            if runner is None:
                raise ValueError(f"unknown registered journey runner {selection.runner_selector!r}")
            runner_path = journey_module("runner.py")
            mode = runner.mode
            return run_runner(runner_path, summary_path, mode, selection)
    except BaseException as error:
        if isinstance(error, SystemExit) and error.code in (None, 0):
            return 0
        phase = "selection" if isinstance(error, JourneySelectionError) else "crash"
        _record_process_failure(summary_path, mode, error, phase, selection=selection)
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print_report_text(f"Journey runner failed: {error.__class__.__name__}: {error}",
                          stream=sys.stderr, flush=True)
        raise SystemExit(1)
