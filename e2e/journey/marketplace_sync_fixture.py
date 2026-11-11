from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import Mapping

from invocations import BackgroundCommand, open_http, start_background_command


def marketplace_sync_fixture_command(workspace_root: Path, *, fixture_path: Path | None = None,
                                     request_recorder: bool = False) -> list[str]:
    fixture = fixture_path or (
        Path(__file__).resolve().parents[1] / "platform" / "fixtures" / "marketplace-sync-server.mjs")
    command = ["node", str(fixture), str(workspace_root)]
    if request_recorder:
        command.append("--request-recorder")
    return command


def start_marketplace_sync_fixture(workspace_root: Path, env: dict[str, str], *,
                                  request_recorder: bool = False):
    command = marketplace_sync_fixture_command(workspace_root, request_recorder=request_recorder)
    process = start_background_command(
        command, cwd=workspace_root, env=env)
    if not process.wait_for_output('"url":', 30):
        process.terminate()
        process.wait(timeout=10)
        details = "".join(process.lines).strip()
        return None, None, f"Marketplace sync fixture did not become ready: {details}"
    try:
        message = json.loads("".join(process.lines).splitlines()[0])
        url = message["url"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        process.terminate()
        process.wait(timeout=10)
        details = "".join(process.lines).strip()
        return None, None, f"Marketplace sync fixture returned invalid readiness data: {error}; {details}"
    if not isinstance(url, str) or not url:
        process.terminate()
        process.wait(timeout=10)
        return None, None, "Marketplace sync fixture readiness URL is invalid"
    return process, url, None


def marketplace_sync_request_count(url: str, env: Mapping[str, str]) -> int:
    request = urllib.request.Request(f"{url.rstrip('/')}/__journey/request-count")
    status, body, _ = open_http(urllib.request.urlopen, request, timeout=10, env=env)
    if status != 200:
        raise RuntimeError(f"Marketplace sync fixture request count failed: HTTP {status}")
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise RuntimeError(f"Marketplace sync fixture returned an invalid request count: {error}") from error
    count = payload.get("count") if isinstance(payload, dict) else None
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        raise RuntimeError("Marketplace sync fixture returned an invalid request count")
    return count


def stop_marketplace_sync_fixture(process: BackgroundCommand) -> str | None:
    returncode = process.stop(timeout=10)
    if returncode != 0:
        return f"Marketplace sync fixture exited {returncode}: {''.join(process.lines).strip()}"
    return None
