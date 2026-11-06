"""Newline-framed JSONL records used by journey artifacts."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class JsonlRecord:
    line_number: int
    value: Any | None
    error: str | None


def _reject_non_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant {value}")


def read_jsonl(path: str | Path, *, errors: str = "strict") -> list[JsonlRecord]:
    """Read LF-framed records, retaining malformed rows with their line numbers."""
    text = Path(path).read_text(encoding="utf-8", errors=errors)
    return read_jsonl_text(text)


def read_jsonl_text(text: str, *, skip_blank: bool = False) -> list[JsonlRecord]:
    """Parse LF-framed JSON records from an in-memory stream."""
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    records = []
    for line_number, line in enumerate(lines, 1):
        if skip_blank and not line.strip():
            continue
        try:
            value = json.loads(line, parse_constant=_reject_non_json_constant)
        except (json.JSONDecodeError, ValueError) as error:
            records.append(JsonlRecord(line_number, None, str(error)))
        else:
            records.append(JsonlRecord(line_number, value, None))
    return records


def encode_jsonl_record(value: Any, *, ensure_ascii: bool = False) -> bytes:
    """Encode one compact JSON record with its LF framing."""
    return (json.dumps(value, separators=(",", ":"), ensure_ascii=ensure_ascii) + "\n").encode("utf-8")


def encode_jsonl_records(values: Iterable[Any], *, ensure_ascii: bool = False) -> str:
    """Encode a complete LF-framed JSONL stream."""
    return "".join(encode_jsonl_record(value, ensure_ascii=ensure_ascii).decode("utf-8")
                   for value in values)


def write_jsonl(path: str | Path, values: Iterable[Any], *, append: bool = False,
                ensure_ascii: bool = False) -> None:
    """Write each value as one compact JSON record terminated by LF."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a" if append else "w", encoding="utf-8", newline="\n") as stream:
        stream.write(encode_jsonl_records(values, ensure_ascii=ensure_ascii))
