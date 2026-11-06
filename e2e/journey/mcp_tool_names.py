"""Names emitted by the MCP producer for the project's enabled manifests."""
import json
from pathlib import Path

_CATALOG = json.loads((Path(__file__).parent / "generated/project_mcp_tool_names.json").read_text())
DEFAULT_ENABLED_SERVICES = frozenset(_CATALOG["enabledServices"])
SERVICE_TOOLS = _CATALOG["services"]
SERVICE_PREFIXES = frozenset(_CATALOG["servicePrefixes"].values())
COMMIT_TOOLS = _CATALOG["commit"]


def service_tool_names(enabled_service_ids):
    return frozenset(
        tool_name
        for service_id in enabled_service_ids
        for tool_name in SERVICE_TOOLS.get(service_id, {}).values()
    )


def service_family_tool_names(tool_names):
    return frozenset(
        name for name in tool_names
        if isinstance(name, str) and any(name.startswith(prefix) for prefix in SERVICE_PREFIXES)
    )


def commit_tool(command_path: str) -> str:
    return COMMIT_TOOLS[command_path]
