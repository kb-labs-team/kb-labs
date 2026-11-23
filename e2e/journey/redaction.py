"""Secret redaction shared by journey invocations and platform snapshots."""
from __future__ import annotations

import os
import re
from typing import Any, Mapping

# Only long values are safe to replace globally: shorter secrets can be ordinary
# identifiers, exit codes, URL fragments, or path components in useful evidence.
MIN_SECRET_VALUE_LENGTH = 12
_SECRET_ARGUMENT_NAME = r"(?:password|token|secret|api[-_]?key|private[-_]?key)"
_SECRET_ARGUMENT = re.compile(rf"(?i)^--{_SECRET_ARGUMENT_NAME}$")
_SECRET_ARGUMENT_TEXT = re.compile(
    rf"(?i)(--{_SECRET_ARGUMENT_NAME}(?:=\s*|\s+))([^\s,;]+)"
)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)(\b[A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*=\s*)[^\s]+"
)
_SECRET_JSON_VALUE = re.compile(
    r'(?i)(["\']?(?:password|token|secret|apiKey|key)["\']?\s*:\s*)("(?:\\.|[^"\\])*"|\'[^\']*\'|[^,}\]\s]+)'
)
_SECRET_JSON_KEY = re.compile(r"(?i)(password|token|secret|apiKey|key)")
_URL_USERINFO = re.compile(r"(?i)([a-z][a-z0-9+.-]*://)([^/\s?#@]+@)")


def is_secret_key(key: str) -> bool:
    """Return whether an environment key is covered by the report redactor."""
    return any(part in key.upper() for part in ("PASSWORD", "TOKEN", "SECRET", "API_KEY"))


def _secret_values(env: Mapping[str, str] | None, extra: tuple[str, ...] = ()) -> set[str]:
    environments = (os.environ, env) if env is not None else (os.environ,)
    secrets = {value for values in environments for key, value in values.items()
               if len(value) >= MIN_SECRET_VALUE_LENGTH and is_secret_key(key)}
    return secrets | {secret for secret in extra if len(secret) >= MIN_SECRET_VALUE_LENGTH}


def redact_text(value: str, env: Mapping[str, str] | None = None,
                secrets: tuple[str, ...] = ()) -> str:
    """Redact known values, secret flags, assignments and JSONC secret fields."""
    for secret in _secret_values(env, secrets):
        value = value.replace(secret, "[REDACTED]")
    value = _SECRET_ASSIGNMENT.sub(r"\1[REDACTED]", value)
    value = _SECRET_JSON_VALUE.sub(r'\1"[REDACTED]"', value)
    value = _SECRET_ARGUMENT_TEXT.sub(r"\1[REDACTED]", value)
    return _URL_USERINFO.sub(r"\1[REDACTED]@", value)


def redact_argv(argv: list[Any], env: Mapping[str, str] | None = None,
                secrets: tuple[str, ...] = ()) -> list[Any]:
    """Redact secret values passed as separate or inline command arguments."""
    result: list[Any] = []
    redact_next = False
    for raw in argv:
        argument = raw if isinstance(raw, str) else str(raw)
        if redact_next:
            result.append("[REDACTED]")
            redact_next = False
            continue
        flag, separator, _inline_value = argument.partition("=")
        if argument.startswith("--") and _SECRET_ARGUMENT.search(flag):
            if separator:
                result.append(f"{flag}=[REDACTED]")
            else:
                result.append(argument)
                redact_next = True
            continue
        result.append(redact_text(argument, env, secrets))
    return result


def redact_json(value: Any) -> Any:
    """Redact values under secret-named JSON keys recursively."""
    if isinstance(value, dict):
        return {key: "[REDACTED]" if _SECRET_JSON_KEY.search(str(key)) else redact_json(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [redact_json(item) for item in value]
    return value


def redact_report_value(value: Any, env: Mapping[str, str] | None = None,
                        secrets: tuple[str, ...] = ()) -> Any:
    """Redact strings and secret-keyed fields before journey evidence leaves memory."""
    if isinstance(value, str):
        return redact_text(value, env, secrets)
    if isinstance(value, dict):
        redacted = {}
        for key, item in value.items():
            if str(key).casefold() == "argv" and isinstance(item, list):
                redacted[key] = redact_argv(item, env, secrets)
            else:
                redacted[key] = redact_report_value(item, env, secrets)
        return redact_json(redacted)
    if isinstance(value, list):
        return [redact_report_value(item, env, secrets) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_report_value(item, env, secrets) for item in value)
    return value
