#!/usr/bin/env python3
"""Run a journey producer stage with safe live timing events and full log capture."""

import argparse
import sys

from invocations import run_logged_stage


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
