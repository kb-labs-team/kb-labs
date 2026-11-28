#!/usr/bin/env python3
"""Emit allowlisted diagnostic counters and lifecycle projections only."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

LIMIT = 1_048_576
VERSION = re.compile(r"^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$")
CATALOG_FALLBACK = {
    "KB_ADAPTER_CREDENTIALS_MISSING",
    "KB_CONFIG_REQUIRED",
    "KB_HOST_UNHEALTHY",
    "KB_INSTALL_INCOMPATIBLE_COMPONENTS",
    "KB_RUNTIME_UNEXPECTED",
}
HOST_STATES = {"stopped", "running", "unhealthy", "host-exited"}
SEVERITIES = {"info", "warning", "error", "fatal"}
CHECK_IDS = {
    "receipt", "config", "host-spec", "host-state", "host-process", "adapters", "health",
    "project-runtimes",
    "auth", "client-profile", "client-runtime-config",
}
ADAPTER_SLOTS = {
    "logger", "analytics", "vectorStore", "llm", "embeddings", "cache", "config",
    "storage", "eventBus", "invoke", "documentDatabase", "kvStore", "logs",
    "artifacts", "snapshotManager", "notifier",
}
UPSTREAMS = {
    "gateway", "rest", "workflow", "marketplace", "marketplace-registry", "marketplace-state",
    "state", "state-daemon", "mcp", "mcp-daemon", "studio", "registry",
}
AUTH_ISSUES = {"no_active_admin"}
SIGNATURES = {
    "ECONNRESET": re.compile(r"\bECONNRESET\b", re.IGNORECASE),
    "socket_hang_up": re.compile(r"socket hang up", re.IGNORECASE),
    "ECONNREFUSED": re.compile(r"\bECONNREFUSED\b", re.IGNORECASE),
    "ETIMEDOUT": re.compile(r"\bETIMEDOUT\b", re.IGNORECASE),
    "EPIPE": re.compile(r"\bEPIPE\b", re.IGNORECASE),
    "uncaught_exception": re.compile(r"uncaughtException", re.IGNORECASE),
    "unhandled_rejection": re.compile(r"unhandledRejection", re.IGNORECASE),
}
CODE_PATTERN = re.compile(r"\b[A-Z][A-Z0-9_]{2,80}\b")


def catalog_codes() -> set[str]:
    paths = [
        Path("/opt/kb-journey/core/platform/src/error-envelope/errors.catalog.json"),
        Path(__file__).resolve().parents[2] / "core/platform/src/error-envelope/errors.catalog.json",
    ]
    codes = set(CATALOG_FALLBACK)
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        entries = payload.get("codes", []) if isinstance(payload, dict) else []
        for item in entries:
            if isinstance(item, dict) and isinstance(item.get("code"), str):
                codes.add(item["code"])
        break
    return codes


CATALOG_CODES = catalog_codes()


def read_tail(path: str | None) -> bytes:
    if path is None:
        return sys.stdin.buffer.read(LIMIT)[-LIMIT:]
    source = Path(path)
    with source.open("rb") as stream:
        stream.seek(0, 2)
        size = stream.tell()
        stream.seek(max(0, size - LIMIT))
        return stream.read(LIMIT)


def valid_code(value: Any) -> bool:
    return isinstance(value, str) and value in CATALOG_CODES


def safe_check_id(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    if value in CHECK_IDS:
        return True
    for prefix, allowed in (("adapter:", ADAPTER_SLOTS), ("upstream:", UPSTREAMS), ("auth:", AUTH_ISSUES)):
        if value.startswith(prefix) and value[len(prefix):] in allowed:
            return True
    return False


def safe_projection(command: str, platform_root: str) -> int:
    try:
        result = subprocess.run(
            ["kb-create", command, "--platform-root", platform_root, "--json"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        print(json.dumps({"command": command, "exitCode": 127, "projectionFailed": True}, sort_keys=True))
        return 0
    record: dict[str, Any] = {"command": command, "exitCode": result.returncode}
    try:
        payload = json.loads(result.stdout)
        if not isinstance(payload, dict):
            raise ValueError("unexpected payload")
        error = payload.get("error")
        if isinstance(error, dict) and valid_code(error.get("code")):
            record["errorCode"] = error["code"]
        data = payload.get("data", payload)
        if not isinstance(data, dict):
            raise ValueError("unexpected data")
        for key in ("ok", "installed", "running", "reachable", "bootstrapCompleted", "kbShimCorrect"):
            if isinstance(data.get(key), bool):
                record[key] = data[key]
        for key in ("installedVersion", "runningVersion", "platformVersion"):
            value = data.get(key)
            if isinstance(value, str) and VERSION.fullmatch(value):
                record[key] = value
        host_state = data.get("hostState")
        if isinstance(host_state, str) and host_state in HOST_STATES:
            record["hostState"] = host_state
        host = data.get("host")
        if isinstance(host, dict):
            projected = {}
            if isinstance(host.get("state"), str) and host["state"] in HOST_STATES:
                projected["state"] = host["state"]
            if isinstance(host.get("healthy"), bool):
                projected["healthy"] = host["healthy"]
            if type(host.get("pid")) is int and 0 <= host["pid"] <= 2**31 - 1:
                projected["pid"] = host["pid"]
            if type(host.get("restartCount")) is int and 0 <= host["restartCount"] <= 100_000:
                projected["restartCount"] = host["restartCount"]
            if projected:
                record["host"] = projected
        host_exit = data.get("hostExit")
        if isinstance(host_exit, dict):
            projected_exit = {}
            for key in ("died", "exhausted"):
                if isinstance(host_exit.get(key), bool):
                    projected_exit[key] = host_exit[key]
            for key in ("restartsUsed",):
                if type(host_exit.get(key)) is int and 0 <= host_exit[key] <= 100_000:
                    projected_exit[key] = host_exit[key]
            if projected_exit:
                record["hostExit"] = projected_exit
        if command == "doctor":
            codes: dict[str, int] = {}
            findings = data.get("findings")
            if isinstance(findings, list):
                for finding in findings:
                    if not isinstance(finding, dict):
                        continue
                    code = finding.get("code")
                    severity = finding.get("severity")
                    if valid_code(code):
                        codes[code] = codes.get(code, 0) + 1
                    if isinstance(severity, str) and severity in SEVERITIES:
                        key = "finding" + severity.title()
                        record[key] = record.get(key, 0) + 1
            if codes:
                record["findingCodes"] = codes
            for section_name in ("installation", "platform"):
                section = data.get(section_name)
                if not isinstance(section, dict):
                    continue
                projected_section: dict[str, Any] = {}
                if isinstance(section.get("ok"), bool):
                    projected_section["ok"] = section["ok"]
                checks = section.get("checks")
                if isinstance(checks, list):
                    projected_checks = []
                    for check in checks:
                        if not isinstance(check, dict) or not safe_check_id(check.get("id")):
                            continue
                        item = {"id": check["id"]}
                        if isinstance(check.get("ok"), bool):
                            item["ok"] = check["ok"]
                        if valid_code(check.get("code")):
                            item["code"] = check["code"]
                        projected_checks.append(item)
                    projected_section["checks"] = projected_checks
                record[section_name] = projected_section
    except Exception:
        # Preserve the process exit code while failing closed on malformed output.
        record["projectionFailed"] = True
    print(json.dumps(record, sort_keys=True))
    return 0


def safe_log_summary(sample: bytes, source: str) -> dict[str, Any]:
    text = sample.decode("utf-8", errors="replace")
    codes: dict[str, int] = {}
    for match in CODE_PATTERN.findall(text):
        if match in CATALOG_CODES:
            codes[match] = codes.get(match, 0) + 1
    return {
        "source": source,
        "present": True,
        "bytesSampled": len(sample),
        "lineCount": len(text.splitlines()),
        "signatures": {name: len(pattern.findall(text)) for name, pattern in SIGNATURES.items()},
        "catalogCodes": codes,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--file")
    source.add_argument("--command", choices=("status", "doctor"))
    source.add_argument("--stdin", action="store_true")
    parser.add_argument("--platform-root", default="/workspace/kb-e2e")
    parser.add_argument("--source", default="stdin")
    args = parser.parse_args()
    if args.command:
        return safe_projection(args.command, args.platform_root)
    try:
        sample = read_tail(args.file if args.file else None)
    except (FileNotFoundError, UnicodeDecodeError):
        print(json.dumps({"source": args.source, "present": False}, sort_keys=True))
        return 0
    print(json.dumps(safe_log_summary(sample, args.source), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
