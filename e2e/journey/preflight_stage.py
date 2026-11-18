#!/usr/bin/env python3
"""Run a journey producer stage with safe live timing events and full log capture."""

import argparse
from datetime import datetime, timezone
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path


def _emit(line):
    print(line, flush=True)


def _timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _group_exists(group_id):
    try:
        os.killpg(group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _signal_group(group_id, signum):
    try:
        os.killpg(group_id, signum)
    except ProcessLookupError:
        pass


def run_logged_stage(stage, log_path, command, *, heartbeat_seconds=60, termination_grace_seconds=2, emit=_emit, cwd=None):
    """Run command into log_path and emit timestamps without forwarding its output."""
    if heartbeat_seconds <= 0:
        raise ValueError("heartbeat_seconds must be positive")
    if termination_grace_seconds < 0:
        raise ValueError("termination_grace_seconds cannot be negative")
    started = time.monotonic()
    emit(f"journey stage={stage} event=start at={_timestamp()}")
    stop = threading.Event()

    def heartbeat():
        while not stop.wait(heartbeat_seconds):
            elapsed = int(time.monotonic() - started)
            emit(f"journey stage={stage} event=heartbeat at={_timestamp()} elapsed_seconds={elapsed}")

    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    watcher = threading.Thread(target=heartbeat, daemon=True)
    received_signals = []
    signal_time = []
    previous_handlers = {}

    def record_signal(signum, _frame):
        if not received_signals:
            received_signals.append(signum)
            signal_time.append(time.monotonic())

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        previous_handlers[signum] = signal.signal(signum, record_signal)

    try:
        with open(log_path, "w", encoding="utf-8", errors="replace") as log_file:
            try:
                process = subprocess.Popen(
                    command, cwd=cwd, stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True,
                )
            except OSError:
                emit(f"journey stage={stage} event=end status=fail exit_code=127 at={_timestamp()} elapsed_seconds=0")
                return 127
            group_id = process.pid
            watcher.start()
            status = None
            try:
                while status is None and not received_signals:
                    try:
                        status = process.wait(timeout=0.1)
                    except subprocess.TimeoutExpired:
                        continue

                if received_signals:
                    _signal_group(group_id, received_signals[0])
                    deadline = signal_time[0] + termination_grace_seconds
                    while time.monotonic() < deadline and _group_exists(group_id):
                        if status is None:
                            try:
                                status = process.wait(timeout=min(0.05, max(0.001, deadline - time.monotonic())))
                            except subprocess.TimeoutExpired:
                                pass
                        else:
                            time.sleep(min(0.05, max(0.001, deadline - time.monotonic())))

                    if _group_exists(group_id):
                        _signal_group(group_id, signal.SIGKILL)

                    if status is None:
                        try:
                            status = process.wait(timeout=max(termination_grace_seconds, 0.1))
                        except subprocess.TimeoutExpired:
                            # Keep cleanup bounded; a daemon reaper collects the leader if the OS
                            # delays SIGKILL delivery (for example, while it is in uninterruptible IO).
                            _signal_group(group_id, signal.SIGKILL)
                            reaper = threading.Thread(target=process.wait, daemon=True)
                            reaper.start()
                            status = 128 + received_signals[0]
            finally:
                stop.set()
                if watcher.is_alive():
                    watcher.join()
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    if status is None:
        status = process.wait(timeout=0)
    if received_signals:
        status = 128 + received_signals[-1]
    elif status < 0:
        status = 128 + -status
    elapsed = int(time.monotonic() - started)
    result = "pass" if status == 0 else "fail"
    emit(f"journey stage={stage} event=end status={result} exit_code={status} at={_timestamp()} elapsed_seconds={elapsed}")
    return status


def main(argv=None):
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="action", required=True)
    run = commands.add_parser("run")
    run.add_argument(
        "--stage", required=True,
        choices=("reset", "lockfile", "build", "candidate", "unit", "artifact-package"),
    )
    run.add_argument("--log", required=True)
    run.add_argument("--heartbeat-seconds", type=float, default=60)
    run.add_argument("--termination-grace-seconds", type=float, default=2)
    run.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("run requires a command after --")
    return run_logged_stage(
        args.stage, args.log, command,
        heartbeat_seconds=args.heartbeat_seconds,
        termination_grace_seconds=args.termination_grace_seconds,
    )


if __name__ == "__main__":
    sys.exit(main())
