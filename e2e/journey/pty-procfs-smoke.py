#!/usr/bin/env python3
"""Hosted smoke for the journey runner's effective procfs permissions."""
from __future__ import annotations

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


def _effective_capabilities() -> int:
    for line in Path("/proc/self/status").read_text(encoding="ascii").splitlines():
        if line.startswith("CapEff:"):
            return int(line.split(":", 1)[1].strip(), 16)
    raise RuntimeError("/proc/self/status has no CapEff field")


def _terminal_announcement(transcript: bytes) -> str | None:
    marker = b"PTY-PROCFS-SMOKE:"
    marker_start = transcript.find(marker)
    if marker_start < 0:
        return None
    line_end = transcript.find(b"\n", marker_start)
    if line_end < 0:
        return None
    line = transcript[marker_start + len(marker):line_end].removesuffix(b"\r")
    return line.decode("ascii")


def _read_blocked_on_tty(pid: int, tid: int, tty: str) -> bool:
    if os.readlink(f"/proc/{pid}/fd/0") != tty:
        return False
    task_stat = Path(f"/proc/{pid}/task/{tid}/stat").read_text(encoding="ascii")
    state = task_stat.rpartition(")")[2].split()[0]
    if state not in {"S", "D"}:
        return False
    syscall = Path(f"/proc/{pid}/task/{tid}/syscall").read_text(encoding="ascii").split()
    read_nr = READ_SYSCALLS.get(platform.machine().lower())
    return read_nr is not None and len(syscall) >= 2 and int(syscall[0]) == read_nr and int(syscall[1], 16) == 0


def main() -> int:
    uid = os.getuid()
    machine = platform.machine().lower()
    if uid == 0:
        raise RuntimeError("smoke must run as the non-root UID selected by e2e/journey/run.sh")
    read_nr = READ_SYSCALLS.get(machine)
    if read_nr is None:
        raise RuntimeError(f"unsupported Linux architecture for syscall probe: {machine}")
    if not (_effective_capabilities() & (1 << CAP_SYS_PTRACE)):
        raise RuntimeError("CAP_SYS_PTRACE is absent from the runner process effective capability set")

    pid, master_fd = pty.fork()
    if pid == 0:
        tty = os.ttyname(0)
        os.write(1, f"PTY-PROCFS-SMOKE:{tty}\n".encode("ascii"))
        os.read(0, 1)
        os._exit(0)

    deadline = time.monotonic() + 5
    transcript = bytearray()
    try:
        tty = _terminal_announcement(transcript)
        while tty is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("PTY child did not finish announcing its controlling terminal")
            readable, _, _ = select.select([master_fd], [], [], remaining)
            if readable:
                chunk = os.read(master_fd, 4096)
                if not chunk:
                    raise RuntimeError("PTY child exited before finishing its terminal announcement")
                transcript.extend(chunk)
                tty = _terminal_announcement(transcript)
        while time.monotonic() < deadline:
            try:
                if _read_blocked_on_tty(pid, pid, tty):
                    print(
                        "PTY procfs readiness probe PASS "
                        f"uid={uid} arch={machine} kernel={platform.release()} "
                        "(full journey still required)"
                    )
                    return 0
            except (FileNotFoundError, ProcessLookupError):
                break
            # Poll only for positive kernel evidence; expiry below is a failure.
            time.sleep(0.02)
        raise RuntimeError("procfs did not prove the same-UID child blocked in read(0) on its controlling PTY")
    finally:
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
        print(f"PTY procfs readiness smoke FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
