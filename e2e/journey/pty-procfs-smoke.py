#!/usr/bin/env python3
"""Hosted diagnostic for procfs access to the real Go wizard PTY child."""
from __future__ import annotations

import errno
import os
import platform
import pty
import select
import signal
import sys
import time
from pathlib import Path


CAP_SYS_PTRACE = 19
READ_SYSCALLS = {"x86_64": 0, "amd64": 0, "aarch64": 63, "arm64": 63}
WIZARD_PROMPT = b"Project directory (press Enter to install without a project): "
WIZARD_BINARY = "/opt/pty/wizard-pty"


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


def _procfs_probe(pid: int, tty: str) -> tuple[str, str]:
    try:
        fd_target = os.readlink(f"/proc/{pid}/fd/0")
        fd_result = "match" if fd_target == tty else "mismatch"
    except OSError as error:
        fd_result = _error_name(error)

    read_nr = READ_SYSCALLS.get(platform.machine().lower())
    try:
        tasks = list(Path(f"/proc/{pid}/task").iterdir())
    except OSError as error:
        return fd_result, f"taskdir-{_error_name(error)}"

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
                return fd_result, "read0"
        except ValueError:
            continue
    if errors:
        return fd_result, "denied:" + "+".join(sorted(errors))
    if observed_syscalls:
        return fd_result, "not-read0:" + "+".join(sorted(observed_syscalls))
    return fd_result, "no-blocked-task"


def _read_pipe_line(fd: int, deadline: float) -> bytes:
    transcript = bytearray()
    while b"\n" not in transcript:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("wizard PTY bootstrap did not finish")
        readable, _, _ = select.select([fd], [], [], remaining)
        if not readable:
            continue
        chunk = os.read(fd, 256)
        if not chunk:
            raise RuntimeError("wizard PTY bootstrap closed before reporting its terminal")
        transcript.extend(chunk)
    return bytes(transcript).split(b"\n", 1)[0]


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
    read_nr = READ_SYSCALLS.get(machine)
    if uid == 0:
        raise RuntimeError("smoke must run as the non-root UID selected by e2e/journey/run.sh")
    if read_nr is None:
        raise RuntimeError(f"unsupported Linux architecture for syscall probe: {machine}")
    if not os.path.isfile(WIZARD_BINARY) or not os.access(WIZARD_BINARY, os.X_OK):
        raise RuntimeError("compiled wizard PTY fixture is unavailable in the smoke container")

    self_status = _process_status("self")
    effective_ptrace = _capability_status(self_status, "CapEff")
    bootstrap_read_fd, bootstrap_write_fd = os.pipe()
    pid, master_fd = pty.fork()
    if pid == 0:
        os.close(bootstrap_read_fd)
        try:
            os.write(bootstrap_write_fd, (os.ttyname(0) + "\n").encode("ascii"))
            os.close(bootstrap_write_fd)
            os.execv(WIZARD_BINARY, [WIZARD_BINARY, "/tmp"])
        except BaseException:
            os._exit(127)

    os.close(bootstrap_write_fd)
    deadline = time.monotonic() + 5
    transcript = bytearray()
    try:
        tty = _read_pipe_line(bootstrap_read_fd, deadline).decode("ascii")
        os.close(bootstrap_read_fd)
        while not _wizard_prompt_ready(transcript):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("real wizard did not finish writing its initial PTY prompt")
            readable, _, _ = select.select([master_fd], [], [], remaining)
            if readable:
                chunk = os.read(master_fd, 4096)
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
        fd_result, syscall_result = _procfs_probe(pid, tty)
        print(
            "wizard-procfs-diagnostic "
            f"uid={uid} arch={machine} kernel={platform.release()} "
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
            f"fd0={fd_result} syscall={syscall_result}"
        )
        if fd_result != "match" or syscall_result != "read0":
            raise RuntimeError("real wizard PTY read could not be proven through procfs")
        print("real wizard PTY procfs probe PASS (full journey still required)")
        return 0
    finally:
        try:
            os.close(bootstrap_read_fd)
        except OSError:
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"wizard procfs smoke FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
