"""Collect real, redacted artifacts for the clean-install evidence pilot."""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, Mapping

from invocations import write_report_text
from redaction import redact_report_value, redact_text

_CLEAN_INSTALL_STEP = "PC-001.2"
_DIGEST = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _step_invocations(path: Path, claim_id: str) -> str | None:
    try:
        lines = path.read_bytes().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return None
    selected = []
    for line in lines:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            return None
        if not isinstance(record, dict):
            return None
        step_id = record.get("step_id")
        if isinstance(step_id, str) and claim_id in step_id.split(","):
            selected.append(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
    return "\n".join(selected) + "\n" if selected else None


def _strip_jsonc(contents: str) -> str:
    output = []
    in_string = escaped = line_comment = block_comment = False
    index = 0
    while index < len(contents):
        char = contents[index]
        next_char = contents[index + 1] if index + 1 < len(contents) else ""
        if line_comment:
            if char in "\r\n":
                line_comment = False
                output.append(char)
            index += 1
            continue
        if block_comment:
            if char == "*" and next_char == "/":
                block_comment = False
                output.extend("  ")
                index += 2
            else:
                output.append("\n" if char == "\n" else " ")
                index += 1
            continue
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            index += 1
        elif char == "/" and next_char == "/":
            line_comment = True
            output.extend("  ")
            index += 2
        elif char == "/" and next_char == "*":
            block_comment = True
            output.extend("  ")
            index += 2
        else:
            output.append(char)
            index += 1

    comment_free = "".join(output)
    output = []
    in_string = escaped = False
    for index, char in enumerate(comment_free):
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            output.append(char)
        elif char == ",":
            next_index = index + 1
            while next_index < len(comment_free) and comment_free[next_index].isspace():
                next_index += 1
            if next_index >= len(comment_free) or comment_free[next_index] not in "]}":
                output.append(char)
        else:
            output.append(char)
    return "".join(output)


def _redacted_config(contents: str) -> str | None:
    try:
        value = json.loads(_strip_jsonc(contents))
    except json.JSONDecodeError:
        return None
    if not isinstance(value, dict):
        return None
    redacted = redact_report_value(value, os.environ)
    return redact_text(json.dumps(redacted, indent=2, ensure_ascii=False) + "\n", os.environ)


def capture_clean_install_artifacts(*, report_root: str | Path, run_id: str,
                                   config_path: str | Path, installation_root: str | Path,
                                   invocation_log_path: str | Path) -> dict[str, str]:
    """Copy only the actual config and calls for PC-001.2 while the install still exists."""
    captured: dict[str, str] = {}
    report_dir = Path(report_root)
    artifact_dir = report_dir / "qa-evidence" / hashlib.sha256(run_id.encode()).hexdigest()[:16]
    try:
        install_root = Path(installation_root).resolve(strict=True)
        source_config = Path(config_path)
        resolved_config = source_config.resolve(strict=True)
        if (resolved_config.is_relative_to(install_root)
                and resolved_config.is_file() and source_config.is_file()):
            contents = resolved_config.read_bytes().decode("utf-8", errors="replace")
            redacted_config = _redacted_config(contents)
            if redacted_config:
                target = artifact_dir / "redacted-platform-config.jsonc"
                write_report_text(target, redacted_config, env=os.environ)
                captured["configRef"] = target.relative_to(report_dir).as_posix()
                captured["configDigest"] = _sha256(target)
    except (OSError, RuntimeError, ValueError):
        pass

    try:
        log_contents = _step_invocations(Path(invocation_log_path), _CLEAN_INSTALL_STEP)
        if log_contents:
            target = artifact_dir / f"step-{_CLEAN_INSTALL_STEP}.log"
            write_report_text(target, log_contents, env=os.environ)
            captured["logRef"] = target.relative_to(report_dir).as_posix()
            captured["logDigest"] = _sha256(target)
    except (OSError, RuntimeError, ValueError):
        pass
    return captured


def apply_clean_install_case_evidence(case_run: Mapping[str, Any], steps: list[Mapping[str, Any]], *,
                                      profile: Mapping[str, str], candidate_digest: str | None,
                                      candidate_verified: bool, artifacts: Mapping[str, str]) -> dict[str, Any]:
    """Bind captured evidence to the recorded result without changing its status."""
    claims = case_run.get("claims")
    if not isinstance(claims, list) or not any(
        isinstance(claim, Mapping) and claim.get("claimId") == _CLEAN_INSTALL_STEP for claim in claims
    ):
        return dict(case_run)

    result: dict[str, Any] = {
        "schema": "kb.qa-case-run/v3",
        "runId": case_run.get("runId") if isinstance(case_run.get("runId"), str) else "",
        "mode": case_run.get("mode") if case_run.get("mode") in {"local", "secured"} else "local",
        "claims": [dict(claim) for claim in claims if isinstance(claim, Mapping)],
    }
    provenance = next((step for step in steps if step.get("name") == "candidate provenance"), None)
    valid_candidate = (candidate_verified and isinstance(provenance, Mapping)
                       and provenance.get("status") == "PASS"
                       and isinstance(candidate_digest, str) and _DIGEST.fullmatch(candidate_digest))
    if valid_candidate:
        result["candidateId"] = f"sha256:{candidate_digest.lower()}"
    if profile and all(isinstance(key, str) and key and isinstance(value, str) and value for key, value in profile.items()):
        result["profile"] = dict(profile)

    claim = next(item for item in result["claims"] if item.get("claimId") == _CLEAN_INSTALL_STEP)
    for key in ("configRef", "configDigest", "logRef", "logDigest"):
        value = artifacts.get(key)
        if isinstance(value, str) and value:
            claim[key] = value
    return result
