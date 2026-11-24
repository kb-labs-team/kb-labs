"""Access the installed CLI's session for one Gateway origin in journey fixtures."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


def _origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise AssertionError("Invalid Gateway URL in session data")
    return parsed.scheme, parsed.hostname, parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)


def gateway_session(data: dict, gateway: str) -> dict | None:
    origin = _origin(gateway)
    entries = data.get("sessions")
    if not isinstance(entries, list):
        raise AssertionError("Expected a sessions array")
    matches = [row for row in entries if row.get("gatewayUrl") and _origin(row["gatewayUrl"]) == origin]
    if len(matches) > 1:
        raise AssertionError("Multiple sessions found for the selected Gateway")
    return matches[0] if matches else None


@dataclass
class SavedGatewaySession:
    path: Path
    store: dict
    record: dict

    @classmethod
    def from_status(cls, status: dict, gateway: str) -> SavedGatewaySession:
        row = gateway_session(status, gateway)
        if not row or row.get("authenticated") is not True or not row.get("path"):
            raise AssertionError("kb auth status omitted the saved session for the selected Gateway")
        path = Path(row["path"])
        store = json.loads(path.read_text())
        record = gateway_session(store, gateway)
        if store.get("version") != 1 or record is None:
            raise AssertionError("Missing selected Gateway session in the CLI session store")
        return cls(path, store, record)

    def expire(self) -> None:
        self.record["expiresAt"] = 0
        self.path.write_text(json.dumps(self.store) + "\n")

    def remove(self) -> None:
        self.store["sessions"].remove(self.record)
        if self.store["sessions"]:
            self.path.write_text(json.dumps(self.store) + "\n")
        else:
            self.path.unlink()
