#!/usr/bin/env python3
"""Emit aggregate Docker resource measurements without container identifiers."""

from __future__ import annotations

import json
import re
import sys

NUMBER = re.compile(r"^\s*(\d{1,12}(?:\.\d{1,3})?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)?\s*$", re.IGNORECASE)
CPU = re.compile(r"^\s*(\d{1,6}(?:\.\d{1,3})?)%\s*$")
PIDS = re.compile(r"^[0-9]{1,9}$")
SCALE = {
    "b": 1,
    "kb": 1000,
    "mb": 1000**2,
    "gb": 1000**3,
    "tb": 1000**4,
    "kib": 1024,
    "mib": 1024**2,
    "gib": 1024**3,
    "tib": 1024**4,
}


def bytes_value(value: object) -> int | None:
    if not isinstance(value, str):
        return None
    match = NUMBER.fullmatch(value)
    if not match:
        return None
    unit = (match.group(2) or "B").lower()
    return int(float(match.group(1)) * SCALE[unit])


def main() -> int:
    records = []
    for line in sys.stdin:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            records.append(payload)

    cpu_total = 0.0
    used_total = 0
    limit_total = 0
    process_total = 0
    cpu_count = memory_count = process_count = 0
    for record in records:
        cpu = record.get("CPUPerc")
        cpu_match = CPU.fullmatch(cpu) if isinstance(cpu, str) else None
        if cpu_match:
            cpu_total += float(cpu_match.group(1))
            cpu_count += 1
        memory = record.get("MemUsage")
        if isinstance(memory, str) and "/" in memory:
            used, limit = memory.split("/", 1)
            used_bytes, limit_bytes = bytes_value(used), bytes_value(limit)
            if used_bytes is not None and limit_bytes is not None:
                used_total += used_bytes
                limit_total += limit_bytes
                memory_count += 1
        processes = record.get("PIDs")
        if isinstance(processes, str) and PIDS.fullmatch(processes):
            process_total += int(processes)
            process_count += 1

    print(json.dumps({
        "containerCount": len(records),
        "cpuPercentTotal": round(cpu_total, 2) if cpu_count else None,
        "cpuContainerCount": cpu_count,
        "memoryBytesUsedTotal": used_total if memory_count else None,
        "memoryBytesLimitTotal": limit_total if memory_count else None,
        "memoryContainerCount": memory_count,
        "processCountTotal": process_total if process_count else None,
        "processContainerCount": process_count,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
