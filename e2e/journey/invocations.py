"""Shared, redacted invocation evidence for journey commands and HTTP calls."""
from __future__ import annotations
from journey_values import journey_value

from contextvars import ContextVar
from functools import lru_cache
import json
import inspect
import errno
import fcntl
import os
import pty
import platform
from pathlib import Path
import re
import shlex
import select
import signal
import shutil
import struct
import subprocess
from subprocess import CalledProcessError, CompletedProcess, PIPE, STDOUT, TimeoutExpired
import sys
import tempfile
import termios
import threading
import time
from typing import Any, Callable, Mapping, MutableMapping, NoReturn
from urllib.error import HTTPError, URLError

import redaction
import jsonl
from journey_resources import workspace_resource, workspace_tool_entrypoints

class PtyReadinessUnsupported(RuntimeError):
    """The operating system cannot report whether a PTY child is reading its terminal."""


_LINUX_READ_SYSCALLS = {"x86_64": 0, "amd64": 0, "aarch64": 63, "arm64": 63}
MAX_ERROR_LOG_BYTES = 1024 * 1024


def _parse_proc_stat(stat: str) -> tuple[int, int, int, str] | None:
    fields = stat.rpartition(")")[2].split()
    if len(fields) < 5:
        return None
    return int(fields[1]), int(fields[3]), int(fields[4]), fields[0]  # parent, session, tty, state


def _proc_stat(pid: int) -> tuple[int, int, int, str] | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except FileNotFoundError:
        return None
    except PermissionError as error:
        raise PtyReadinessUnsupported(
            "Linux procfs process state is not readable with this user's permissions"
        ) from error
    return _parse_proc_stat(stat)


def _pty_reader_pids(root_pid: int) -> list[int]:
    proc = Path("/proc")
    root = _proc_stat(root_pid)
    if root is None:
        return []
    pids = {root_pid}
    parent_by_pid: dict[int, int] = {}
    for entry in proc.iterdir():
        if not entry.name.isdecimal():
            continue
        pid = int(entry.name)
        try:
            details = _proc_stat(pid)
        except PtyReadinessUnsupported:
            continue
        if details is not None:
            parent_by_pid[pid] = details[0]
    changed = True
    while changed:
        changed = False
        for pid, parent in parent_by_pid.items():
            if parent in pids and pid not in pids:
                pids.add(pid)
                changed = True
    return sorted(pids)


def _decode_linux_device_number(encoded: int) -> tuple[int, int]:
    major = ((encoded >> 8) & 0xFFF) | ((encoded >> 32) & ~0xFFF)
    minor = (encoded & 0xFF) | ((encoded >> 12) & ~0xFF)
    return major, minor


def _linux_terminal_reader(pid: int, terminal_path: str) -> tuple[int, int, str] | None:
    """Return the exact task blocked reading fd 0 from this controlling PTY."""
    if not sys.platform.startswith("linux"):
        raise PtyReadinessUnsupported(
            f"PTY read readiness is not supported on {platform.system()}; the journey requires Linux procfs"
        )
    machine = platform.machine().lower()
    read_syscall = _LINUX_READ_SYSCALLS.get(machine)
    if read_syscall is None:
        raise PtyReadinessUnsupported(
            f"PTY read readiness is not supported for Linux architecture {machine}"
        )
    try:
        pids = _pty_reader_pids(pid)
        terminal_stat = os.stat(terminal_path)
    except OSError as error:
        raise PtyReadinessUnsupported(f"Linux procfs process state is unavailable: {error}") from error
    terminal_device = (os.major(terminal_stat.st_rdev), os.minor(terminal_stat.st_rdev))
    for child_pid in pids:
        details = _proc_stat(child_pid)
        if details is None:
            continue
        _, session_id, controlling_tty, _ = details
        if (session_id != pid
                or _decode_linux_device_number(controlling_tty) != terminal_device):
            continue
        try:
            if os.readlink(f"/proc/{child_pid}/fd/0") != terminal_path:
                continue
            tasks = Path(f"/proc/{child_pid}/task").iterdir()
            for task in tasks:
                task_state = _parse_proc_stat(Path(task, "stat").read_text(encoding="ascii"))
                if task_state is None or task_state[3] not in {"S", "D"}:
                    continue
                syscall = Path(task, "syscall").read_text(encoding="ascii").split()
                if len(syscall) >= 2:
                    try:
                        is_terminal_read = (int(syscall[0], 10) == read_syscall
                                            and int(syscall[1], 16) == 0)
                    except ValueError:
                        continue
                    if is_terminal_read:
                        return child_pid, int(task.name), " ".join(syscall)
        except FileNotFoundError:
            continue
        except PermissionError as error:
            raise PtyReadinessUnsupported(
                "Linux procfs syscall state is not readable with this user's permissions"
            ) from error
        except OSError:
            continue
    return None


def pty_terminal_read_ready(pid: int, terminal_path: str) -> bool:
    """Report a child task blocked in read(0) on this controlling PTY."""
    return _linux_terminal_reader(pid, terminal_path) is not None


def _terminal_pending_input(slave_fd: int) -> int:
    """Return bytes queued for the child to read, including no-echo input."""
    value = bytearray(struct.pack("i", 0))
    fcntl.ioctl(slave_fd, termios.TIOCINQ, value, True)
    return struct.unpack("i", value)[0]


def _drain_pty(master: int, transcript: bytearray) -> bool:
    """Drain all output currently queued on the PTY master; report new bytes."""
    changed = False
    while True:
        try:
            chunk = os.read(master, 8192)
        except BlockingIOError:
            return changed
        except OSError as error:
            if error.errno in (errno.EIO, errno.EBADF):
                return changed
            raise
        if not chunk:
            return changed
        transcript.extend(chunk)
        changed = True


def _acquire_controlling_terminal(slave_fd: int) -> None:
    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

_STEP_ID: ContextVar[str] = ContextVar("journey_step_id", default="journey.setup")
_REPORT_ROOT: ContextVar[Path | None] = ContextVar("journey_report_root", default=None)
_UNEXPECTED_DIAGNOSTICS: ContextVar[list[dict[str, Any]] | None] = ContextVar("journey_unexpected_diagnostics", default=None)
# `root.go` routes these registered commands to JSON stream executors. Every
# other registered kb-create command returns one ADR-0049 document.
def store_report_secret(env: MutableMapping[str, str], key: str, value: str, source: str) -> str:
    """Validate and store a harness credential where subprocesses and reports can redact it."""
    if not redaction.is_secret_key(key):
        raise AssertionError(f"{source} must use a secret-like environment key")
    if len(value) < redaction.MIN_SECRET_VALUE_LENGTH:
        raise AssertionError(f"{source} must contain at least {redaction.MIN_SECRET_VALUE_LENGTH} characters for safe journey reporting")
    env[key] = value
    return value


def export_project_identity_to_child_environment(
    env: MutableMapping[str, str], *, project_id: str | None = None, project_root: str | None = None,
    project_b_id: str | None = None, project_b_root: str | None = None,
) -> None:
    """Expose state-backed project identities only to a child process."""
    if project_id:
        env["KB_JOURNEY_PROJECT_ID"] = project_id
    elif project_id == "":
        env.pop("KB_JOURNEY_PROJECT_ID", None)
    if project_root:
        env["KB_JOURNEY_PROJECT_ROOT"] = project_root
    elif project_root == "":
        env.pop("KB_JOURNEY_PROJECT_ROOT", None)
    if project_b_id:
        env["KB_JOURNEY_PROJECT_B_ID"] = project_b_id
    elif project_b_id == "":
        env.pop("KB_JOURNEY_PROJECT_B_ID", None)
    if project_b_root:
        env["KB_JOURNEY_PROJECT_B_ROOT"] = project_b_root
    elif project_b_root == "":
        env.pop("KB_JOURNEY_PROJECT_B_ROOT", None)


def _invalid_ux_result(message: str) -> NoReturn:
    evidence = invocation_link(_STEP_ID.get())
    suffix = f" ({evidence})" if evidence else ""
    raise ValueError(f"{message}{suffix}")


def decode_ux_success_result(value: Any) -> Any:
    """Validate a shared success envelope and return its payload."""
    if (not isinstance(value, dict) or value.get("ok") is not True
            or "data" not in value or set(value) - {"ok", "data", "meta"}
            or ("meta" in value and not isinstance(value["meta"], dict))):
        _invalid_ux_result("response is not a valid UX success envelope")
    return value["data"]


def decode_ux_error_result(value: Any) -> Any:
    """Validate a shared failure envelope and return its error payload."""
    error = value.get("error") if isinstance(value, dict) else None
    if (not isinstance(value, dict) or value.get("ok") is not False
            or set(value) != {"ok", "error"} or not isinstance(error, dict)
            or not isinstance(error.get("code"), str) or not isinstance(error.get("message"), str)):
        _invalid_ux_result("response is not a valid UX error envelope")
    return error


def _cli_process_result(result: Any) -> tuple[str, int]:
    if type(result) is not subprocess.CompletedProcess:
        _invalid_ux_result("CLI result reader requires a subprocess.CompletedProcess from the shared invocation boundary")
    stdout = result.stdout or ""
    if isinstance(stdout, bytes):
        stdout = stdout.decode(errors="replace")
    if not isinstance(stdout, str) or not isinstance(result.returncode, int):
        _invalid_ux_result("CLI process result has invalid stdout or exit status")
    return stdout, result.returncode


@lru_cache(maxsize=1)
def _error_catalog_entries() -> dict[str, dict[str, Any]]:
    catalog_path = workspace_resource("core", "platform", "src", "error-envelope", "errors.catalog.json")
    try:
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        _invalid_ux_result(f"cannot read the shared error catalog at {catalog_path}: {error}")
    return {entry["code"]: entry for entry in catalog.get("codes", []) if isinstance(entry, dict)
            and isinstance(entry.get("code"), str)}


def catalogued_error_hint(code: str, **values: str) -> str:
    """Render a catalogued error hint from its authoritative template."""
    entry = _error_catalog_entries().get(code)
    if entry is None:
        _invalid_ux_result(f"error code {code} is missing from the shared error catalog")
    hint = entry.get("hint")
    if not isinstance(hint, str):
        _invalid_ux_result(f"catalogued error {code} has no hint template")
    try:
        return hint.format_map(values)
    except KeyError as error:
        _invalid_ux_result(f"catalogued error {code} hint needs template value {error.args[0]}")


def catalogued_error_message(code: str) -> str:
    """Read a catalogued error message from its authoritative entry."""
    entry = _error_catalog_entries().get(code)
    if entry is None:
        _invalid_ux_result(f"error code {code} is missing from the shared error catalog")
    message = entry.get("message")
    if not isinstance(message, str):
        _invalid_ux_result(f"catalogued error {code} has no message")
    return message


@lru_cache(maxsize=None)
def _catalog_exit_status(code: str) -> tuple[str, int] | None:
    entry = _error_catalog_entries().get(code)
    if entry is None:
        return None
    exit_class = entry.get("processExitClass")
    if exit_class == "input-refusal":
        return exit_class, 2
    if exit_class == "operation-failure":
        return exit_class, 1
    _invalid_ux_result(f"catalogued error {code} has no supported process exit class")


@lru_cache(maxsize=1)
def _go_cli_binary_names() -> frozenset[str]:
    names = set()
    for main_source in workspace_tool_entrypoints():
        try:
            source = main_source.read_text(encoding="utf-8")
        except OSError as error:
            _invalid_ux_result(f"cannot read Go CLI entrypoint {main_source}: {error}")
        if (re.search(r"(?m)^package\s+main\s*$", source)
                and '"github.com/kb-labs/clikit/command"' in source):
            names.add(main_source.parent.name)
    return frozenset(names)


def _is_go_cli_result(result: subprocess.CompletedProcess[str]) -> bool:
    arguments = result.args if isinstance(result.args, (list, tuple)) else shlex.split(str(result.args))
    return bool(arguments) and Path(str(arguments[0])).name in _go_cli_binary_names()


def _validate_error_process_status(error: dict[str, Any], process_status: int,
                                  terminal_status: int | None = None) -> None:
    code = error.get("code")
    if not isinstance(code, str):
        return
    classification = _catalog_exit_status(code)
    if classification is None:
        return
    exit_class, expected = classification
    if process_status != expected or (terminal_status is not None and terminal_status != expected):
        _invalid_ux_result(
            f"catalogued error {code} ({exit_class}) has process status {process_status} "
            f"and terminal status {terminal_status}; expected {expected}"
        )


def validate_catalogued_cli_status(result: Any) -> None:
    """Check catalogued diagnostics on every captured invocation, including failures not later decoded by a step."""
    if type(result) is subprocess.CompletedProcess:
        stdout, process_status = _cli_process_result(result)
    elif isinstance(result, dict):
        stdout, process_status = result.get("stdout", ""), result.get("returncode")
    else:
        stdout, process_status = getattr(result, "stdout", ""), getattr(result, "returncode", None)
    if isinstance(stdout, bytes):
        stdout = stdout.decode(errors="replace")
    if not isinstance(stdout, str) or not isinstance(process_status, int):
        return
    documents = []
    try:
        documents.append(json.loads(stdout))
    except json.JSONDecodeError:
        rows = jsonl.read_jsonl_text(stdout, skip_blank=True)
        if any(row.error is not None for row in rows):
            return
        documents.extend(row.value for row in rows)
    terminal_statuses = [document.get("meta", {}).get("stream", {}).get("exitCode")
                         for document in documents if isinstance(document, dict)
                         and document.get("meta", {}).get("stream", {}).get("terminal") is True]
    for document in documents:
        if isinstance(document, dict) and document.get("ok") is False:
            error = document.get("error")
            if isinstance(error, dict) and isinstance(error.get("code"), str):
                terminal_status = terminal_statuses[-1] if terminal_statuses else None
                _validate_error_process_status(error, process_status, terminal_status)


def _validate_go_cli_invocation(argv: list[str], result: Any) -> None:
    if argv and Path(str(argv[0])).name in _go_cli_binary_names():
        validate_catalogued_cli_status(result)


def read_ux_cli_result(result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    """Parse a CLI JSON result and validate its UX success or error envelope."""
    stdout, returncode = _cli_process_result(result)
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError as error:
        try:
            _invalid_ux_result("CLI response is not JSON")
        except ValueError as failure:
            raise failure from error
    if not isinstance(value, dict):
        _invalid_ux_result("CLI response is not an object")
    if value.get("ok") is True:
        decode_ux_success_result(value)
    else:
        error = decode_ux_error_result(value)
        if _is_go_cli_result(result):
            _validate_error_process_status(error, returncode)
    if (returncode == 0) != (value["ok"] is True):
        _invalid_ux_result("CLI exit code does not match its UX result envelope")
    return value


def read_ux_cli_stream(result: subprocess.CompletedProcess[str]) -> list[dict[str, Any]]:
    """Validate JSONL UX records and the terminal record's process status."""
    stdout, returncode = _cli_process_result(result)
    records = []
    for row in jsonl.read_jsonl_text(stdout, skip_blank=True):
        if row.error is not None:
            try:
                _invalid_ux_result("CLI stream contains a non-JSON record")
            except ValueError as failure:
                raise failure from ValueError(row.error)
        value = row.value
        if not isinstance(value, dict):
            _invalid_ux_result("CLI stream record is not an object")
        if value.get("ok") is True:
            decode_ux_success_result(value)
        else:
            decode_ux_error_result(value)
        records.append(value)
    if not records:
        _invalid_ux_result("CLI stream is empty")
    result_records = []
    for record in records[:-1]:
        meta = record.get("meta", {})
        stream_meta = meta.get("stream", {}) if isinstance(meta, dict) else {}
        if isinstance(stream_meta, dict) and stream_meta.get("result") is True:
            result_records.append(record)
    terminal = records[-1]
    terminal_meta = terminal.get("meta", {})
    stream = terminal_meta.get("stream", {}) if isinstance(terminal_meta, dict) else {}
    exit_code = stream.get("exitCode") if isinstance(stream, dict) else None
    failures = [record for record in records[:-1] if record.get("ok") is False]
    if _is_go_cli_result(result):
        for record in failures:
            _validate_error_process_status(decode_ux_error_result(record), returncode, exit_code)
    if (terminal.get("ok") is not True or terminal.get("data", "not-null") is not None
            or not isinstance(stream, dict) or stream.get("terminal") is not True
            or exit_code not in {0, 1, 2}
            or returncode != exit_code):
        _invalid_ux_result("CLI stream terminal record does not match its process exit code")
    if len(result_records) > 1:
        _invalid_ux_result("CLI stream contains multiple result records")
    if exit_code == 0 and any(record.get("ok") is not True for record in records[:-1]):
        _invalid_ux_result("successful CLI stream contains an error record")
    if exit_code != 0 and not any(record.get("ok") is False for record in records[:-1]):
        _invalid_ux_result("failed CLI stream omits its error record")
    return records


def read_kb_create_cli_result(command: str, result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    """Read the single document or JSON stream actually emitted by kb-create."""
    try:
        envelope = read_ux_cli_result(result)
    except ValueError as document_error:
        try:
            records = read_ux_cli_stream(result)
        except ValueError as stream_error:
            raise document_error from stream_error
        result_records = [record for record in records[:-1]
                          if record.get("ok") is True
                          and record.get("meta", {}).get("stream", {}).get("result") is True]
        failures = [record for record in records[:-1] if record.get("ok") is False]
        if result.returncode == 0:
            if len(result_records) != 1:
                _invalid_ux_result(f"kb-create {command} stream must contain exactly one result record")
            return result_records[0]
        if len(failures) != 1:
            _invalid_ux_result(f"kb-create {command} stream must contain exactly one error result")
        return failures[0]
    if result.returncode == 0:
        return envelope
    _validate_error_process_status(decode_ux_error_result(envelope), result.returncode)
    return envelope


def describe_cli_failure(command: str, stdout: str, stderr: str, returncode: int) -> str:
    """Describe a failed CLI invocation using its typed error when available."""
    detail = " ".join(f"{stdout} {stderr}".split())
    words = shlex.split(command)
    result = subprocess.CompletedProcess(words, returncode, stdout, stderr)
    if len(words) > 1 and words[0] == "kb-create":
        try:
            value = read_kb_create_cli_result(words[1], result)
        except ValueError:
            value = None
    else:
        try:
            value = read_ux_cli_result(result)
        except ValueError:
            value = None
    if isinstance(value, dict) and isinstance(value.get("error"), dict):
        error = value["error"]
        detail = "; ".join(part for part in (
            str(error.get("code") or ""),
            str(error.get("message") or ""),
            f"hint: {error['hint']}" if error.get("hint") else "",
        ) if part)
    return f"{command} exited {returncode}" + (f": {detail}" if detail else ": no output")


def read_ux_http_result(body: bytes, status: int) -> dict[str, Any]:
    """Parse an HTTP JSON result and require its status to carry a UX envelope."""
    try:
        value = json.loads(body)
    except (json.JSONDecodeError, TypeError) as error:
        try:
            _invalid_ux_result("HTTP response is not JSON")
        except ValueError as failure:
            raise failure from error
    if not isinstance(value, dict):
        _invalid_ux_result("HTTP response is not an object")
    if 200 <= status < 300:
        decode_ux_success_result(value)
    else:
        decode_ux_error_result(value)
    return value


def invocation_context(*, step_id: str | None = None, report_root: str | Path | None = None):
    """Set the current case step and invocation destination for a scope."""
    class Context:
        def __enter__(self):
            self.step_token = _STEP_ID.set(step_id or _STEP_ID.get())
            self.report_token = _REPORT_ROOT.set(Path(report_root) if report_root else _REPORT_ROOT.get())
            self.unexpected_error_diagnostics: list[dict[str, Any]] = []
            self.diagnostics_token = _UNEXPECTED_DIAGNOSTICS.set(self.unexpected_error_diagnostics)
            return self

        def __exit__(self, *_exc):
            _UNEXPECTED_DIAGNOSTICS.reset(self.diagnostics_token)
            _STEP_ID.reset(self.step_token)
            _REPORT_ROOT.reset(self.report_token)
    return Context()


def write_report_json(path: str | Path, value: Any, *, env: Mapping[str, str] | None = None,
                      indent: int | None = 2,
                      ensure_ascii: bool = False, secrets: tuple[str, ...] = ()) -> Any:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    redacted = redaction.redact_report_value(value, env, secrets)
    rendered = json.dumps(redacted, indent=indent, ensure_ascii=ensure_ascii) + "\n"
    with target.open("w", encoding="utf-8") as stream:
        stream.write(rendered)
    return redacted


def write_report_jsonl(path: str | Path, value: Any, *, env: Mapping[str, str] | None = None,
                       append: bool = True, ensure_ascii: bool = False,
                       secrets: tuple[str, ...] = ()) -> Any:
    redacted = redaction.redact_report_value(value, env, secrets)
    jsonl.write_jsonl(path, [redacted], append=append, ensure_ascii=ensure_ascii)
    return redacted


def write_report_text(path: str | Path, value: str, *, env: Mapping[str, str] | None = None,
                      append: bool = False, secrets: tuple[str, ...] = ()) -> str:
    rendered = redaction.redact_text(value, env, secrets)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a" if append else "w", encoding="utf-8") as stream:
        stream.write(rendered)
    return rendered


def print_report_text(value: str, *, env: Mapping[str, str] | None = None,
                      stream=None, end: str = "\n", flush: bool = False) -> str:
    rendered = redaction.redact_text(value, env)
    output = stream or sys.stdout
    output.write(rendered + end)
    if flush:
        output.flush()
    return rendered


def _error_envelope_from_response(stdout: str, stderr: str) -> dict[str, str] | None:
    for body in (stdout, stderr):
        try:
            response = json.loads(body)
        except json.JSONDecodeError:
            continue
        if not isinstance(response, dict):
            continue
        error = response.get("error")
        if not isinstance(error, dict):
            continue
        code = error.get("code")
        area = error.get("area")
        if not isinstance(code, str) or not isinstance(area, str):
            continue
        envelope = {"code": code, "area": area}
        stage = error.get("stage")
        if isinstance(stage, str):
            envelope["stage"] = stage
        return envelope
    return None


def record_invocation(*, kind: str, argv: list[str], cwd: str | Path | None,
                      env: Mapping[str, str] | None, exit_code: int | None,
                      stdout: str = "", stderr: str = "", duration_seconds: float,
                      url: str | None = None, request_body: str | None = None,
                      invocation_evidence: list[str] | None = None,
                      error: str | None = None) -> dict[str, Any] | None:
    root = _REPORT_ROOT.get()
    if root is None:
        path = journey_value("KB_JOURNEY_INVOCATIONS")
        root = Path(path) if path else None
    if root is None:
        return None
    effective_env = env if env is not None else os.environ
    correlated_log_query = _failure_log_query(kind, exit_code, argv, stdout, stderr, cwd, effective_env)
    kb_environment = {key: value for key, value in effective_env.items() if key.startswith("KB_")}
    record = {
        "step_id": _STEP_ID.get(),
        "kind": kind,
        "argv": argv,
        "url": url,
        "request_body": request_body,
        "cwd": str(cwd or Path.cwd()),
        "home_label": effective_env.get("KB_JOURNEY_HOME_LABEL", "main"),
        "exit_code": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "error": error,
        "duration_seconds": round(duration_seconds, 3),
    }
    error_envelope = _error_envelope_from_response(stdout, stderr)
    if error_envelope is not None:
        record["error_envelope"] = error_envelope
    if kind == "command":
        record["kb_environment"] = kb_environment
        shim = _kb_shim_evidence(effective_env)
        if shim is not None:
            record["kb_shim"] = shim
    if exit_code not in (None, 0):
        captured = _capture_typed_error_files(kind, argv, stdout, stderr, exit_code, effective_env)
        invocation_evidence = list(dict.fromkeys([*(invocation_evidence or []), *captured]))
    if invocation_evidence:
        record["invocation_evidence"] = invocation_evidence
    if correlated_log_query:
        record["correlated_log_query"] = correlated_log_query
        if correlated_log_query.get("code") == "KB_RUNTIME_UNEXPECTED":
            correlation_id = correlated_log_query.get("correlationId")
            query_result = correlated_log_query.get("result")
            if not isinstance(correlation_id, str):
                unexpected_diagnostic = {"queryError": correlated_log_query.get("queryError")}
            elif isinstance(query_result, dict):
                unexpected_diagnostic = {
                    "correlationId": correlation_id,
                    "logs": logs_from_query_envelope(query_result),
                }
            else:
                unexpected_diagnostic = {
                    "correlationId": correlation_id,
                    "queryError": correlated_log_query.get("queryError", "log query did not return a result"),
                }
            collector = _UNEXPECTED_DIAGNOSTICS.get()
            if collector is not None:
                collector.append(unexpected_diagnostic)
    target = root / "invocations" / "calls.jsonl"
    return write_report_jsonl(target, record, env=effective_env, append=True, ensure_ascii=False)


def _kb_shim_evidence(env: Mapping[str, str]) -> dict[str, str] | None:
    configured = env.get("KB_JOURNEY_CLI_PATH")
    found = configured or shutil.which("kb", path=env.get("PATH"))
    if found is None:
        return None
    path = Path(found)
    absolute_path = os.path.abspath(path)
    realpath = os.path.realpath(absolute_path)
    target = os.readlink(absolute_path) if os.path.islink(absolute_path) else realpath
    return {"path": absolute_path, "realpath": realpath, "target": target}


def _capture_typed_error_files(kind: str, argv: list[str], stdout: str, stderr: str,
                               exit_code: int, env: Mapping[str, str] | None) -> list[str]:
    """Copy bounded, redacted files named by failed structured error details."""
    root = _REPORT_ROOT.get()
    if root is None:
        configured = journey_value("KB_JOURNEY_INVOCATIONS")
        root = Path(configured) if configured else None
    if root is None:
        return []
    output = stdout or stderr
    try:
        result = None
        if kind == "command" and argv and Path(argv[0]).name == "kb-create" and len(argv) > 1:
            process_result = CompletedProcess(argv, exit_code, stdout, stderr)
            result = read_kb_create_cli_result(argv[1], process_result)
        else:
            result = json.loads(output)
    except (json.JSONDecodeError, ValueError):
        return []
    error = result.get("error") if isinstance(result, dict) and result.get("ok") is False else None
    details = error.get("details") if isinstance(error, dict) else None
    if not isinstance(details, dict):
        return []
    paths = []
    ordered_paths = [details.get("logPath"), *details.values()]
    for value in ordered_paths:
        if not isinstance(value, str):
            continue
        candidate = Path(value)
        try:
            if candidate.is_file() and candidate not in paths:
                paths.append(candidate)
        except OSError:
            continue
    if not paths:
        return []
    calls = root / "invocations" / "calls.jsonl"
    try:
        invocation_number = len(jsonl.read_jsonl(calls)) + 1
    except OSError:
        invocation_number = 1
    references = []
    for ordinal, source in enumerate(paths, 1):
        try:
            with source.open("rb") as stream:
                data = stream.read(MAX_ERROR_LOG_BYTES + 1)
        except OSError:
            continue
        truncated = len(data) > MAX_ERROR_LOG_BYTES
        contents = data[:MAX_ERROR_LOG_BYTES].decode("utf-8", errors="replace")
        if truncated:
            contents += "\n[truncated by journey evidence limit]\n"
        target = root / "invocations" / "evidence" / f"{invocation_number:04d}-{ordinal:02d}-{source.name}"
        write_report_text(target, contents, env=env)
        references.append(str(target.relative_to(root)))
    return references


class PtyCommandTimeout(subprocess.TimeoutExpired):
    """PTY timeout retaining the terminal output received before the deadline."""

    def __init__(self, cmd: list[str], timeout: float, transcript: str):
        super().__init__(cmd, timeout, output=transcript)

    def __str__(self) -> str:
        details = [f"PTY command timed out after {self.timeout}s"]
        if self.output:
            details.append(f"transcript received:\n{self.output}")
        else:
            details.append("no output received before the timeout")
        return "\n".join(details)


def invocation_link(step_id: str) -> str | None:
    root = _REPORT_ROOT.get()
    if root is None:
        path = journey_value("KB_JOURNEY_INVOCATIONS")
        root = Path(path) if path else None
    if root is None:
        return None
    target = root / "invocations" / "calls.jsonl"
    try:
        matching = [(record.line_number, record.value)
                    for record in jsonl.read_jsonl(target)
                    if record.error is None and isinstance(record.value, dict)
                    and record.value.get("step_id") == step_id]
    except OSError:
        return None
    if not matching:
        return None
    number, record = matching[-1]
    reference = f"invocations/calls.jsonl:{number}"
    evidence = record.get("invocation_evidence")
    if evidence:
        reference += f"; copied report evidence: {', '.join(evidence)}"
    return reference


def parse_error_correlation_id(
    stdout: str,
    stderr: str = "",
    *,
    expected_code: str,
) -> tuple[bool, str | None]:
    """Read a catalogued failure code and correlation ID from JSON or human output."""
    try:
        result = json.loads(stdout)
    except json.JSONDecodeError:
        result = None
    error = result.get("error") if isinstance(result, dict) and result.get("ok") is False else None
    if isinstance(error, dict) and error.get("code") == expected_code:
        correlation_id = error.get("correlationId")
        return True, correlation_id if isinstance(correlation_id, str) and correlation_id else None

    retrieval_command = 'kb logs query --correlation-id '
    for output in (stderr, stdout):
        if expected_code not in output:
            continue
        before, separator, after = output.partition(retrieval_command)
        if separator and before:
            correlation_id = after.split('"', 1)[0].split()[0:1]
            if correlation_id:
                return True, correlation_id[0]
        return True, None
    return False, None


def logs_from_query_envelope(envelope: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Extract records from the real CLI query result nested in its command envelope."""
    command_result = envelope.get("data")
    query_result = command_result.get("data") if isinstance(command_result, dict) else None
    logs = query_result.get("logs") if isinstance(query_result, dict) else None
    return [record for record in logs if isinstance(record, dict)] if isinstance(logs, list) else []


def _failure_log_query(kind: str, exit_code: int | None, argv: list[str], stdout: str, stderr: str,
                       cwd: str | Path | None, env: Mapping[str, str] | None) -> dict[str, Any] | None:
    if exit_code is None or (exit_code == 0 and kind == "command") or (exit_code < 400 and kind == "http"):
        return None
    effective_env = env if env is not None else os.environ
    error: dict[str, Any] | None = None
    for output in (stdout, stderr):
        try:
            result = json.loads(output)
        except json.JSONDecodeError:
            result = None
        candidates = result if isinstance(result, list) else [result]
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            candidate_error = candidate.get("error")
            if isinstance(candidate_error, dict) and (
                    candidate.get("ok") is False or kind == "http"):
                error = candidate_error
                break
        if error is not None:
            break
    kb_cli = _kb_shim_evidence(effective_env)
    invoked_cli = (_resolve_invoked_executable(argv[0], cwd, effective_env)
                   if kind == "command" and argv else None)
    is_installed_cli = bool(kind == "command" and kb_cli is not None
                            and invoked_cli == kb_cli["realpath"])
    if kind == "command" and not is_installed_cli:
        return None
    is_unexpected, human_correlation_id = (
        parse_error_correlation_id(
            stdout,
            stderr,
            expected_code="KB_RUNTIME_UNEXPECTED",
        ) if kind == "command" and is_installed_cli
        else (False, None)
    )
    if error is None and not is_unexpected:
        return None
    correlation_id = error.get("correlationId") if error is not None else human_correlation_id
    code = error.get("code") if error is not None else "KB_RUNTIME_UNEXPECTED"
    if not isinstance(correlation_id, str) or not correlation_id:
        return {"code": code, "queryError": "failed result omitted its correlationId"}
    if kb_cli is None:
        return {"code": code, "correlationId": correlation_id,
                "queryError": "installed kb CLI is not available on the invocation PATH"}
    query_cli = invoked_cli if is_installed_cli else kb_cli["path"]
    try:
        query = subprocess.run(
            [query_cli, "logs", "query", "--correlation-id", correlation_id, "--json"],
            cwd=str(cwd) if cwd else None,
            env=dict(effective_env),
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as query_error:
        diagnostic = {"code": code, "correlationId": correlation_id, "queryError": str(query_error)}
    else:
        try:
            query_result = json.loads(query.stdout)
        except json.JSONDecodeError:
            query_result = None
        if query.returncode != 0 or not isinstance(query_result, dict) or query_result.get("ok") is not True:
            diagnostic = {"code": code, "correlationId": correlation_id,
                          "queryError": query.stderr.strip() or query.stdout.strip() or f"query exited {query.returncode}",
                          "exitCode": query.returncode}
        else:
            diagnostic = {"code": code, "correlationId": correlation_id, "result": query_result}
    return diagnostic


def _resolve_invoked_executable(executable: str, cwd: str | Path | None,
                                env: Mapping[str, str]) -> str | None:
    if os.path.dirname(executable):
        path = Path(executable)
        if not path.is_absolute() and cwd is not None:
            path = Path(cwd) / path
        candidate = str(path)
    else:
        candidate = shutil.which(executable, path=env.get("PATH"))
    return os.path.realpath(candidate) if candidate is not None else None


def run_command(argv: list[str], *, cwd: str | Path | None = None,
                env: Mapping[str, str] | None = None, timeout: float = 300,
                runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
                monitor_process: Callable[[int], None] | None = None,
                **kwargs: Any) -> subprocess.CompletedProcess[str]:
    started = time.monotonic()
    if runner is None and monitor_process is not None:
        return _run_monitored_command(argv, cwd=cwd, env=env, timeout=timeout,
                                      monitor_process=monitor_process, started=started, **kwargs)
    runner = runner or subprocess.run
    options = {
        "cwd": str(cwd) if cwd else None,
        "env": dict(env) if env is not None else None,
        "capture_output": True,
        "text": True,
        "timeout": timeout,
        **kwargs,
    }
    try:
        signature = inspect.signature(runner)
        accepts_kwargs = any(parameter.kind is inspect.Parameter.VAR_KEYWORD
                             for parameter in signature.parameters.values())
        if not accepts_kwargs:
            options = {key: value for key, value in options.items() if key in signature.parameters}
    except (TypeError, ValueError):
        pass
    try:
        result = runner(argv, **options)
    except (OSError, subprocess.TimeoutExpired) as error:
        record_invocation(kind="command", argv=argv, cwd=cwd, env=env, exit_code=None,
                          duration_seconds=time.monotonic() - started, error=str(error))
        raise
    _validate_go_cli_invocation(argv, result)
    raw_stdout = result.stdout or ""
    raw_stderr = result.stderr or ""
    stdout = raw_stdout.decode(errors="replace") if isinstance(raw_stdout, bytes) else raw_stdout
    stderr = raw_stderr.decode(errors="replace") if isinstance(raw_stderr, bytes) else raw_stderr
    record_invocation(kind="command", argv=argv, cwd=cwd, env=env,
                      exit_code=result.returncode, stdout=stdout, stderr=stderr,
                      duration_seconds=time.monotonic() - started)
    return result


def run_harness_command(argv: list[str], *, timeout: float = 300) -> subprocess.CompletedProcess[str]:
    """Run harness infrastructure commands through the shared process owner."""
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)


def run_with_runner(runner: Callable[..., subprocess.CompletedProcess[str]], argv: list[str],
                    **kwargs: Any) -> subprocess.CompletedProcess[str]:
    """Use the evidence helper for real or injected command runners without double-recording."""
    if runner is run_command:
        return run_command(argv, **kwargs)
    return run_command(argv, runner=runner, **kwargs)


def _run_monitored_command(argv: list[str], *, cwd: str | Path | None,
                           env: Mapping[str, str] | None, timeout: float,
                           monitor_process: Callable[[int], None], started: float,
                           **kwargs: Any) -> subprocess.CompletedProcess[str]:
    options = dict(kwargs)
    options.pop("capture_output", None)
    text_mode = options.pop("text", True)
    merge_stderr = options.pop("stderr", None) is subprocess.STDOUT
    input_value = options.pop("input", None)
    stdin_value = options.pop("stdin", subprocess.PIPE if input_value is not None else subprocess.DEVNULL)
    with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        try:
            process = subprocess.Popen(argv, cwd=str(cwd) if cwd else None,
                                       env=dict(env) if env is not None else None,
                                       stdin=stdin_value, stdout=stdout_file,
                                       stderr=subprocess.STDOUT if merge_stderr else stderr_file,
                                       **options)
            if input_value is not None:
                raw_input = input_value.encode() if isinstance(input_value, str) else input_value
                assert process.stdin is not None
                process.stdin.write(raw_input)
                process.stdin.close()
            deadline = started + timeout
            while process.poll() is None:
                monitor_process(process.pid)
                if time.monotonic() >= deadline:
                    process.kill()
                    process.wait()
                    stdout_file.seek(0)
                    stderr_file.seek(0)
                    stdout, stderr = stdout_file.read(), stderr_file.read()
                    record_invocation(kind="command", argv=argv, cwd=cwd, env=env,
                                      exit_code=process.returncode,
                    stdout=stdout.decode(errors="replace"),
                    stderr="" if merge_stderr else stderr.decode(errors="replace"),
                                      duration_seconds=time.monotonic() - started,
                                      error=f"timed out after {timeout}s")
                    raise subprocess.TimeoutExpired(argv, timeout, output=stdout, stderr=stderr)
                time.sleep(0.05)
            stdout_file.seek(0)
            stderr_file.seek(0)
            stdout, stderr = stdout_file.read(), stderr_file.read()
        except OSError as error:
            record_invocation(kind="command", argv=argv, cwd=cwd, env=env, exit_code=None,
                              duration_seconds=time.monotonic() - started, error=str(error))
            raise
    rendered_stdout = stdout.decode(errors="replace") if text_mode else stdout
    rendered_stderr = stderr.decode(errors="replace") if text_mode else stderr
    completed = subprocess.CompletedProcess(argv, process.returncode,
                                              stdout=rendered_stdout, stderr=rendered_stderr)
    _validate_go_cli_invocation(argv, completed)
    record_invocation(kind="command", argv=argv, cwd=cwd, env=env,
                      exit_code=process.returncode,
                      stdout=rendered_stdout if isinstance(rendered_stdout, str) else rendered_stdout.decode(errors="replace"),
                      stderr=("" if merge_stderr else
                              rendered_stderr if isinstance(rendered_stderr, str) else rendered_stderr.decode(errors="replace")),
                      duration_seconds=time.monotonic() - started)
    return completed


def run_pty_command(argv: list[str], *, cwd: str | Path | None = None,
                    env: Mapping[str, str] | None = None, timeout: float = 900,
                    on_output: Callable[[str], str | bytes | None] | None = None,
                    on_read_ready: Callable[[str], str | bytes | None] | None = None,
                    monitor_process: Callable[[int], None] | None = None,
                    start_new_session: bool = False,
                    raise_on_timeout: bool = True) -> tuple[subprocess.CompletedProcess[str], float]:
    """Run a command on a PTY and record its complete transcript and case step."""
    if on_read_ready and not sys.platform.startswith("linux"):
        raise PtyReadinessUnsupported(
            f"PTY read readiness is not supported on {platform.system()}; the journey requires Linux procfs"
        )
    if on_read_ready and not start_new_session:
        raise ValueError("PTY read readiness requires a new session with a controlling terminal")
    started = time.monotonic()
    master, slave = pty.openpty()
    if on_read_ready:
        os.set_blocking(master, False)
    terminal_path = os.ttyname(slave)
    process = None
    transcript = bytearray()
    timed_out = False
    try:
        process = subprocess.Popen(argv, cwd=str(cwd) if cwd else None,
                                   env=dict(env) if env is not None else None,
                                   stdin=slave, stdout=slave, stderr=slave,
                                   close_fds=True, start_new_session=start_new_session,
                                   preexec_fn=(lambda: _acquire_controlling_terminal(slave))
                                   if on_read_ready else None)
        if not on_read_ready:
            os.close(slave)
            slave = -1
        deadline = started + timeout
        while process.poll() is None and time.monotonic() < deadline:
            if monitor_process:
                monitor_process(process.pid)
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                if on_read_ready:
                    output_changed = _drain_pty(master, transcript)
                else:
                    try:
                        chunk = os.read(master, 8192)
                    except OSError:
                        remaining = max(0, deadline - time.monotonic())
                        try:
                            process.wait(timeout=remaining)
                        except subprocess.TimeoutExpired:
                            timed_out = True
                        break
                    output_changed = bool(chunk)
                    transcript.extend(chunk)
                if output_changed and on_output:
                    answer = on_output(transcript.decode(errors="replace"))
                    if answer:
                        os.write(master, answer.encode() if isinstance(answer, str) else answer)
            if on_read_ready:
                # Readiness is one invariant: the same child task is still
                # blocked in terminal read(0), all output queued before that
                # read has been drained into the transcript, and the PTY has
                # no input bytes left from an answer already sent by this owner.
                observed_reader = _linux_terminal_reader(process.pid, terminal_path)
                if observed_reader is not None:
                    drained = _drain_pty(master, transcript)
                    if drained and on_output:
                        answer = on_output(transcript.decode(errors="replace"))
                        if answer:
                            os.write(master, answer.encode() if isinstance(answer, str) else answer)
                    confirmed_reader = _linux_terminal_reader(process.pid, terminal_path)
                    if (confirmed_reader == observed_reader
                            and _terminal_pending_input(slave) == 0):
                        answer = on_read_ready(transcript.decode(errors="replace"))
                        if answer:
                            os.write(master, answer.encode() if isinstance(answer, str) else answer)
        if process.poll() is None and time.monotonic() >= deadline:
            timed_out = True
        if timed_out:
            if start_new_session:
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
            process.wait()
        else:
            process.wait()
            while True:
                readable, _, _ = select.select([master], [], [], 0)
                if not readable:
                    break
                try:
                    chunk = os.read(master, 8192)
                except OSError:
                    break
                if not chunk:
                    break
                transcript.extend(chunk)
                if on_output:
                    answer = on_output(transcript.decode(errors="replace"))
                    if answer:
                        os.write(master, answer.encode() if isinstance(answer, str) else answer)
    except OSError as error:
        record_invocation(kind="command", argv=argv, cwd=cwd, env=env, exit_code=None,
                          stdout=transcript.decode(errors="replace"),
                          duration_seconds=time.monotonic() - started,
                          error=f"{error.__class__.__name__}: {error}")
        raise
    except BaseException:
        if process is not None and process.poll() is None:
            try:
                if start_new_session:
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except ProcessLookupError:
                pass
            process.wait()
        raise
    finally:
        if slave >= 0:
            try:
                os.close(slave)
            except OSError:
                pass
        os.close(master)
    rendered = transcript.decode(errors="replace")
    completed = subprocess.CompletedProcess(argv, process.returncode, stdout=rendered, stderr="")
    _validate_go_cli_invocation(argv, completed)
    duration = time.monotonic() - started
    error = (f"timed out after {timeout}s" if rendered else
             f"no output received before the timeout ({timeout}s)") if timed_out else None
    record_invocation(kind="command", argv=argv, cwd=cwd, env=env,
                      exit_code=process.returncode, stdout=rendered,
                      duration_seconds=duration, error=error)
    if timed_out and raise_on_timeout:
        raise PtyCommandTimeout(argv, timeout, rendered)
    return completed, duration


def run_streaming_command(argv: list[str], *, cwd: str | Path | None = None,
                          env: Mapping[str, str] | None = None, timeout: float = 300,
                          on_output_line: Callable[[str], None] | None = None,
                          start_new_session: bool = False) -> tuple[subprocess.CompletedProcess[str], float]:
    """Stream combined subprocess output while retaining the full transcript as evidence."""
    started = time.monotonic()
    transcript_parts: list[str] = []
    output_thread: threading.Thread | None = None
    try:
        process = subprocess.Popen(argv, cwd=str(cwd) if cwd else None,
                                   env=dict(env) if env is not None else None,
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   bufsize=1, start_new_session=start_new_session)

        def copy_output() -> None:
            assert process.stdout is not None
            with process.stdout as stream:
                for line in stream:
                    transcript_parts.append(line)
                    if on_output_line:
                        on_output_line(line.rstrip("\r\n"))

        output_thread = threading.Thread(target=copy_output, daemon=True)
        output_thread.start()
        try:
            return_code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            if start_new_session:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            else:
                process.kill()
                process.wait()
            return_code = process.returncode
            duration = time.monotonic() - started
            transcript = "".join(transcript_parts)
            record_invocation(kind="command", argv=argv, cwd=cwd, env=env,
                              exit_code=return_code, stdout=transcript,
                              duration_seconds=duration, error=f"timed out after {timeout}s")
            raise subprocess.TimeoutExpired(argv, timeout, output=transcript)
        finally:
            output_thread.join()
    except OSError as error:
        duration = time.monotonic() - started
        record_invocation(kind="command", argv=argv, cwd=cwd, env=env, exit_code=None,
                          stdout="".join(transcript_parts), duration_seconds=duration,
                          error=f"{error.__class__.__name__}: {error}")
        raise
    duration = time.monotonic() - started
    transcript = "".join(transcript_parts)
    completed = subprocess.CompletedProcess(argv, return_code, stdout=transcript, stderr="")
    validate_catalogued_cli_status(completed)
    record_invocation(kind="command", argv=argv, cwd=cwd, env=env,
                      exit_code=return_code, stdout=transcript,
                      duration_seconds=duration)
    return completed, duration


class BackgroundCommand:
    """A recorded long-running process whose complete output is drained in the helper."""

    def __init__(self, process: subprocess.Popen[str], argv: list[str], cwd: str | Path | None,
                 env: Mapping[str, str] | None, started: float):
        self.process = process
        self.argv = argv
        self.cwd = cwd
        self.env = env
        self.started = started
        self.lines: list[str] = []
        self.changed = threading.Condition()
        self.recorded = False
        self.reader = threading.Thread(target=self._read_output, daemon=True)
        self.reader.start()

    def _read_output(self) -> None:
        assert self.process.stdout is not None
        with self.process.stdout as stream:
            for line in stream:
                with self.changed:
                    self.lines.append(line)
                    self.changed.notify_all()
        with self.changed:
            self.changed.notify_all()

    def poll(self) -> int | None:
        return self.process.poll()

    def wait_for_output(self, expected: str, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        with self.changed:
            while expected not in "".join(self.lines) and self.process.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self.changed.wait(remaining)
            return expected in "".join(self.lines)

    def terminate(self) -> None:
        self.process.terminate()

    def stop(self, timeout: float = 10) -> int:
        """Stop a background process and guarantee it is reaped before returning."""
        if self.process.poll() is None:
            self.process.terminate()
        try:
            return self.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.process.kill()
            return self.wait(timeout=timeout)

    def wait(self, timeout: float | None = None) -> int:
        try:
            result = self.process.wait(timeout=timeout)
        finally:
            if self.process.poll() is not None:
                self.reader.join()
                self._record()
        return result

    def _record(self) -> None:
        if self.recorded:
            return
        self.recorded = True
        record_invocation(kind="command", argv=self.argv, cwd=self.cwd, env=self.env,
                          exit_code=self.process.returncode, stdout="".join(self.lines),
                          duration_seconds=time.monotonic() - self.started)


def start_background_command(argv: list[str], *, cwd: str | Path | None = None,
                             env: Mapping[str, str] | None = None) -> BackgroundCommand:
    """Start a background command and capture its full output until it exits."""
    started = time.monotonic()
    try:
        process = subprocess.Popen(argv, cwd=str(cwd) if cwd else None,
                                   env=dict(env) if env is not None else None,
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   bufsize=1)
    except OSError as error:
        record_invocation(kind="command", argv=argv, cwd=cwd, env=env, exit_code=None,
                          duration_seconds=time.monotonic() - started,
                          error=f"{error.__class__.__name__}: {error}")
        raise
    return BackgroundCommand(process, argv, cwd, env, started)


def open_http(opener: Callable[..., Any], request: Any, *, timeout: float,
              env: Mapping[str, str] | None = None) -> tuple[int, bytes, Mapping[str, str]]:
    """Perform and record an HTTP request, including non-2xx responses."""
    started = time.monotonic()
    method = getattr(request, "method", None) or "GET"
    url = getattr(request, "full_url", str(request))
    request_body = getattr(request, "data", None)
    if isinstance(request_body, bytes):
        request_body = request_body.decode(errors="replace")
    elif request_body is not None and not isinstance(request_body, str):
        request_body = str(request_body)
    try:
        with opener(request, timeout=timeout) as response:
            headers = getattr(response, "headers", {})
            status = getattr(response, "status", None) or getattr(response, "code", None) or 200
            result = (status, response.read(), dict(headers.items()) if hasattr(headers, "items") else {})
    except HTTPError as error:
        result = (error.code, error.read(), dict(error.headers.items()) if error.headers else {})
    except (URLError, OSError, TimeoutError) as error:
        record_invocation(kind="http", argv=[method], cwd=Path.cwd(), env=env,
                          exit_code=None, duration_seconds=time.monotonic() - started,
                          url=url, request_body=request_body,
                          error=f"{error.__class__.__name__}: {error}")
        raise
    record_invocation(kind="http", argv=[method], cwd=Path.cwd(), env=env,
                      exit_code=result[0], stdout=result[1].decode(errors="replace"),
                      duration_seconds=time.monotonic() - started, url=url,
                      request_body=request_body)
    return result
