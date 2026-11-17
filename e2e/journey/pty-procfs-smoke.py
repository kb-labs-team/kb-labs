#!/usr/bin/env python3
"""Hosted diagnostic for procfs access to the real Go wizard PTY child."""
from __future__ import annotations

import errno
import fcntl
import os
import platform
import pty
import select
import signal
import subprocess
import sys
import termios
import time
from pathlib import Path


CAP_SYS_PTRACE = 19
READ_SYSCALLS = {"x86_64": 0, "amd64": 0, "aarch64": 63, "arm64": 63}
WIZARD_PROMPT = b"Project directory (press Enter to install without a project): "
WIZARD_BINARY = "/opt/pty/wizard-pty"
WIZARD_INDEX = "/opt/pty/release-index.json"


def _process_status(pid: int) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in Path(f"/proc/{pid}/status").read_text(encoding="ascii").splitlines():
        key, separator, value = line.partition(":")
        if separator and key in {"Uid", "CapPrm", "CapEff", "CapBnd", "Seccomp", "NoNewPrivs"}:
            result[key] = value.strip()
    return result


def _capability_status(status: dict[str, str], key: str) -> str:
    value = status.get(key)
    if value is None:
        return "unavailable"
    return str(bool(int(value, 16) & (1 << CAP_SYS_PTRACE))).lower()


def _wizard_prompt_ready(transcript: bytes) -> bool:
    return WIZARD_PROMPT in transcript


def _error_name(error: OSError) -> str:
    return errno.errorcode.get(error.errno or 0, f"ERRNO_{error.errno}")


def _proc_stat(pid: int) -> tuple[int, int, int, str] | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except OSError:
        return None
    fields = stat.rpartition(")")[2].split()
    if len(fields) < 5:
        return None
    return int(fields[1]), int(fields[3]), int(fields[4]), fields[0]


def _descendant_pids(root_pid: int) -> list[int]:
    root = _proc_stat(root_pid)
    if root is None:
        return []
    pids = {root_pid}
    parents: dict[int, int] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        pid = int(entry.name)
        details = _proc_stat(pid)
        if details is not None:
            parents[pid] = details[0]
    changed = True
    while changed:
        changed = False
        for pid, parent in parents.items():
            if parent in pids and pid not in pids:
                pids.add(pid)
                changed = True
    return sorted(pids)


def _decode_linux_device_number(encoded: int) -> tuple[int, int]:
    major = ((encoded >> 8) & 0xFFF) | ((encoded >> 32) & ~0xFFF)
    minor = (encoded & 0xFF) | ((encoded >> 12) & ~0xFF)
    return major, minor


def _task_syscall(pid: int) -> str:
    read_nr = READ_SYSCALLS.get(platform.machine().lower())
    try:
        tasks = list(Path(f"/proc/{pid}/task").iterdir())
    except OSError as error:
        return f"taskdir-{_error_name(error)}"

    errors: set[str] = set()
    observed_syscalls: set[str] = set()
    for task in tasks:
        try:
            stat = Path(task, "stat").read_text(encoding="ascii")
            state = stat.rpartition(")")[2].split()[0]
        except OSError as error:
            errors.add(f"stat:{_error_name(error)}")
            continue
        if state not in {"S", "D"}:
            continue
        try:
            syscall = Path(task, "syscall").read_text(encoding="ascii").split()
        except OSError as error:
            errors.add(f"syscall:{_error_name(error)}")
            continue
        if read_nr is None or len(syscall) < 2:
            continue
        try:
            syscall_number = int(syscall[0], 10)
            observed_syscalls.add(str(syscall_number))
            if syscall_number == read_nr and int(syscall[1], 16) == 0:
                return "read0"
        except ValueError:
            continue
    if errors:
        return "denied:" + "+".join(sorted(errors))
    if observed_syscalls:
        return "not-read0:" + "+".join(sorted(observed_syscalls))
    return "no-blocked-task"


def _procfs_probe(root_pid: int, tty: str, expected_uid: int) -> tuple[int, str]:
    terminal_stat = os.stat(tty)
    terminal_device = (os.major(terminal_stat.st_rdev), os.minor(terminal_stat.st_rdev))
    summaries: list[str] = []
    pids = _descendant_pids(root_pid)
    for pid in pids:
        details = _proc_stat(pid)
        if details is None:
            continue
        _, session_id, tty_nr, _ = details
        if session_id != root_pid or _decode_linux_device_number(tty_nr) != terminal_device:
            continue
        try:
            status = _process_status(pid)
            uid_fields = status.get("Uid", "").split()
            uid_match = bool(uid_fields) and int(uid_fields[0]) == expected_uid
        except OSError:
            status = {}
            uid_match = False
        try:
            fd_result = "match" if os.readlink(f"/proc/{pid}/fd/0") == tty else "mismatch"
        except OSError as error:
            fd_result = _error_name(error)
        syscall_result = _task_syscall(pid) if fd_result == "match" else "not-read"
        summaries.append(
            f"uid={'match' if uid_match else 'unknown-or-different'},fd0={fd_result},syscall={syscall_result}"
        )
    return len(summaries), ";".join(summaries) if summaries else "no-pty-descendants"


def _wizard_command(mode: str) -> list[str]:
    if mode == "fixture":
        return [WIZARD_BINARY, "/tmp"]
    if mode == "installed":
        return [
            WIZARD_BINARY, "install", "--registry", "http://verdaccio:4873",
            "--index", WIZARD_INDEX,
            "--platform-root", "/tmp/kb-journey-pty-procfs-platform",
        ]
    raise RuntimeError(f"unsupported wizard smoke mode: {mode}")


def _yama_ptrace_scope() -> str:
    try:
        return Path("/proc/sys/kernel/yama/ptrace_scope").read_text(encoding="ascii").strip()
    except OSError as error:
        return f"unavailable:{_error_name(error)}"


def _procfs_hidepid() -> str:
    try:
        for line in Path("/proc/mounts").read_text(encoding="ascii").splitlines():
            fields = line.split()
            if len(fields) < 4 or fields[1] != "/proc":
                continue
            options = fields[3].split(",")
            return next((option.split("=", 1)[1] for option in options if option.startswith("hidepid=")), "none")
        return "not-mounted"
    except OSError as error:
        return f"unavailable:{_error_name(error)}"


def _lsm_label(pid: int | str) -> str:
    try:
        return Path(f"/proc/{pid}/attr/current").read_text(encoding="ascii").strip()
    except OSError as error:
        return f"unavailable:{_error_name(error)}"


def main() -> int:
    uid = os.getuid()
    machine = platform.machine().lower()
    mode = os.environ.get("KB_JOURNEY_PTY_WIZARD_MODE", "fixture")
    read_nr = READ_SYSCALLS.get(machine)
    if uid == 0:
        raise RuntimeError("smoke must run as the non-root UID selected by e2e/journey/run.sh")
    if read_nr is None:
        raise RuntimeError(f"unsupported Linux architecture for syscall probe: {machine}")
    if not os.path.isfile(WIZARD_BINARY) or not os.access(WIZARD_BINARY, os.X_OK):
        raise RuntimeError("compiled wizard PTY fixture is unavailable in the smoke container")
    if mode == "installed" and not os.path.isfile(WIZARD_INDEX):
        raise RuntimeError("producer release index is unavailable in the smoke container")
    wizard_command = _wizard_command(mode)

    self_status = _process_status("self")
    effective_ptrace = _capability_status(self_status, "CapEff")
    master_fd, slave_fd = pty.openpty()
    tty = os.ttyname(slave_fd)
    os.set_blocking(master_fd, False)
    process = subprocess.Popen(
        wizard_command,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        start_new_session=True,
        preexec_fn=lambda: fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0),
    )
    pid = process.pid
    os.close(slave_fd)
    deadline = time.monotonic() + 5
    transcript = bytearray()
    try:
        while not _wizard_prompt_ready(transcript):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("real wizard did not finish writing its initial PTY prompt")
            readable, _, _ = select.select([master_fd], [], [], remaining)
            if readable:
                try:
                    chunk = os.read(master_fd, 4096)
                except OSError as error:
                    if error.errno == errno.EIO:
                        chunk = b""
                    else:
                        raise
                if not chunk:
                    raise RuntimeError("real wizard exited before finishing its initial PTY prompt")
                transcript.extend(chunk)

        try:
            wizard_status = _process_status(pid)
            wizard_status_error = "none"
        except OSError as error:
            wizard_status = {}
            wizard_status_error = _error_name(error)
        wizard_uid = wizard_status.get("Uid", "").split()
        wizard_uid_match = str(bool(wizard_uid) and int(wizard_uid[0]) == uid).lower()
        candidate_count, procfs_result = _procfs_probe(pid, tty, uid)
        print(
            "wizard-procfs-diagnostic "
            f"mode={mode} pty_launch=popen_controlling_tty uid={uid} arch={machine} kernel={platform.release()} "
            f"wizard_uid_match={wizard_uid_match} "
            f"runner_cap_sys_ptrace={_capability_status(self_status, 'CapPrm')}/"
            f"{effective_ptrace}/{_capability_status(self_status, 'CapBnd')} "
            f"wizard_cap_sys_ptrace={_capability_status(wizard_status, 'CapPrm')}/"
            f"{_capability_status(wizard_status, 'CapEff')}/{_capability_status(wizard_status, 'CapBnd')} "
            f"wizard_seccomp={wizard_status.get('Seccomp', 'unavailable')} "
            f"wizard_no_new_privs={wizard_status.get('NoNewPrivs', 'unavailable')} "
            f"wizard_status={wizard_status_error} "
            f"yama_ptrace_scope={_yama_ptrace_scope()} "
            f"proc_hidepid={_procfs_hidepid()} "
            f"lsm={_lsm_label(pid)} "
            f"pty_descendants={candidate_count} candidates=[{procfs_result}]"
        )
        has_read0 = any(
            "uid=match" in candidate and "fd0=match" in candidate and "syscall=read0" in candidate
            for candidate in procfs_result.split(";")
        )
        if not has_read0:
            raise RuntimeError("real wizard PTY read could not be proven through procfs")
        print(f"{mode} wizard PTY procfs probe PASS (full journey still required)")
        return 0
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"wizard procfs smoke FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
