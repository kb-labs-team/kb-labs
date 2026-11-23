"""Collect real, redacted artifacts for the clean-install evidence pilot."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Mapping

from invocations import write_report_text
from redaction import redact_report_value, redact_text


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _observed_candidate(steps: list[Mapping[str, Any]]) -> str | None:
    provenance = next((step for step in steps if step.get("name") == "candidate provenance"), None)
    details = provenance.get("details") if isinstance(provenance, Mapping) else None
    commit = details.get("candidateCommit") if isinstance(details, Mapping) else None
    return f"git:{commit}" if isinstance(commit, str) and commit.strip() else None


def _step_invocations(path: Path, claim_id: str) -> str | None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
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
    return json.dumps(redacted, indent=2, ensure_ascii=False) + "\n"


def collect_clean_install_case_evidence(case_run: Mapping[str, Any], steps: list[Mapping[str, Any]], *,
                                        report_root: str | Path, config_path: str | Path,
                                        invocation_log_path: str | Path,
                                        profile: Mapping[str, str]) -> dict[str, Any]:
    """Upgrade PC-001.2 to evidence v3, retaining only artifacts observed on disk."""
    claims = case_run.get("claims")
    if not isinstance(claims, list) or not any(
        isinstance(claim, Mapping) and claim.get("claimId") == "PC-001.2" for claim in claims
    ):
        return dict(case_run)

    run_id = case_run.get("runId")
    mode = case_run.get("mode")
    result: dict[str, Any] = {
        "schema": "kb.qa-case-run/v3",
        "runId": run_id if isinstance(run_id, str) else "",
        "mode": mode if mode in {"local", "secured"} else "local",
        "claims": [dict(claim) for claim in claims if isinstance(claim, Mapping)],
    }
    candidate_id = _observed_candidate(steps)
    if candidate_id:
        result["candidateId"] = candidate_id
    if profile and all(isinstance(key, str) and key and isinstance(value, str) and value for key, value in profile.items()):
        result["profile"] = dict(profile)

    claim = next(item for item in result["claims"] if item.get("claimId") == "PC-001.2")
    artifact_root = Path(report_root) / "qa-evidence" / hashlib.sha256(str(run_id).encode()).hexdigest()[:16]
    try:
        source_config = Path(config_path)
        if source_config.is_file() and not source_config.is_symlink():
            config_ref = (artifact_root / "redacted-platform-config.jsonc").relative_to(Path(report_root)).as_posix()
            config_target = Path(report_root) / config_ref
            source_contents = source_config.read_text(encoding="utf-8")
            redacted_config = _redacted_config(source_contents)
            if redacted_config:
                write_report_text(config_target, redact_text(redacted_config, os.environ), env=os.environ)
                claim["configRef"] = config_ref
                claim["configDigest"] = _sha256(config_target)
    except (OSError, UnicodeError, ValueError):
        pass

    log_contents = _step_invocations(Path(invocation_log_path), "PC-001.2")
    if log_contents:
        try:
            log_ref = (artifact_root / "step-PC-001.2.log").relative_to(Path(report_root)).as_posix()
            log_target = Path(report_root) / log_ref
            write_report_text(log_target, log_contents, env=os.environ)
            claim["logRef"] = log_ref
            claim["logDigest"] = _sha256(log_target)
        except (OSError, UnicodeError, ValueError):
            pass
    return result
