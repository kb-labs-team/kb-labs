#!/usr/bin/env python3
"""Project E2E diagnostic dossiers onto an allowlist before artifact upload."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from summarize_safe_log import CATALOG_CODES, safe_log_summary

SCENARIOS = {"default", "reset", "pressure", "secured", "local", "oauth", "unsecured", "baseline", "candidate"}
STATUSES = {"passed", "failed", "blocked", "skipped", "cancelled"}
FAILURE_PHASES = {"setup", "bootstrap", "reset", "test", "cleanup", "scenario-apply", "teardown", "scenario-reset"}
FAILURE_KINDS = {"test-failure", "service-failure", "collection-failure", "startup-failure", "scenario-apply", "scenario-reset"}
COLLECTION_STATUSES = {"complete", "partial", "not-collected"}


def enum(value: Any, allowed: set[str]) -> str:
    return value if isinstance(value, str) and value in allowed else "unknown"


def project_metric_file(path: Path, counters: Counter[str]) -> tuple[int, int]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return 0, 0
    services = payload.get("services") if isinstance(payload, dict) else None
    if not isinstance(services, dict):
        return 0, 0
    failures = 0
    statuses = 0
    for value in services.values():
        if not isinstance(value, dict):
            continue
        if value.get("ok") is False:
            failures += 1
        status = value.get("status")
        if type(status) is int and 100 <= status <= 599:
            counters[f"http_{status}"] += 1
            statuses += 1
        error = value.get("error")
        if isinstance(error, str):
            safe = safe_log_summary(error.encode("utf-8", errors="replace"), "metric-error")
            for name, count in safe["signatures"].items():
                counters[name] += count
            for code, count in safe["catalogCodes"].items():
                if code in CATALOG_CODES:
                    counters[code] += count
    return failures, statuses


def project_scenario(directory: Path) -> dict[str, Any]:
    summary_path = directory / "summary.json"
    try:
        raw = json.loads(summary_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}
    counters: Counter[str] = Counter()
    metric_failures = 0
    metric_statuses = 0
    metric_files = list((directory / "metrics").glob("*.json")) if (directory / "metrics").is_dir() else []
    for path in metric_files:
        failures, statuses = project_metric_file(path, counters)
        metric_failures = max(metric_failures, failures)
        metric_statuses = max(metric_statuses, statuses)
    return {
        "scenario": enum(directory.name, SCENARIOS),
        "suite": enum(raw.get("suite"), {"auth", "gateway", "marketplace", "marketplace-registry", "mcp", "mind", "oauth", "platform", "plugins", "rest-api", "services", "studio", "workflows"}),
        "status": enum(raw.get("status"), STATUSES),
        "failurePhase": enum(raw.get("failurePhase"), FAILURE_PHASES),
        "failureKind": enum(raw.get("failureKind"), FAILURE_KINDS),
        "collectionStatus": enum(raw.get("collectionStatus"), COLLECTION_STATUSES),
        "failedTestCount": len(raw.get("failedTests")) if isinstance(raw.get("failedTests"), list) else 0,
        "failedServiceCount": len(raw.get("failedServices")) if isinstance(raw.get("failedServices"), list) else 0,
        "collectionErrorCount": len(raw.get("collectionErrors")) if isinstance(raw.get("collectionErrors"), list) else 0,
        "metricFailureCount": metric_failures,
        "metricHttpStatusCount": metric_statuses,
        "safeErrorCounts": dict(sorted(counters.items())),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("diagnostics_dir")
    args = parser.parse_args()
    root = Path(args.diagnostics_dir)
    scenarios = [project_scenario(path.parent) for path in sorted(root.glob("*/summary.json"))]
    print(json.dumps({"schemaVersion": 1, "scenarioCount": len(scenarios), "scenarios": scenarios}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
