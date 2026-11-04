"""Project MCP journey steps for typed errors, mutations, auth and isolation."""
from __future__ import annotations

from mcp_tool_names import DEFAULT_ENABLED_SERVICES, commit_tool, service_tool_names

from project_service_path import project_service_path

import json
import os
import re
from pathlib import Path
from urllib.parse import quote

from invocations import catalogued_error_hint, invocation_context, run_command
from journey_resources import read_installed_platform_resource
from service_steps import Journey



def _request(*args, step: str, **kwargs):
    # Import lazily because service_runner also registers these step functions.
    from service_runner import request_mcp
    return request_mcp(*args, step=step, **kwargs)


def _ux_request(*args, **kwargs):
    # Agent-session REST routes use the platform UX envelope, unlike MCP RPC.
    from service_runner import request
    return request(*args, **kwargs)


def _ux_contracts() -> tuple[dict, dict]:
    return (
        json.loads(read_installed_platform_resource("ux-result", "machine-result.schema.json")),
        json.loads(read_installed_platform_resource("error-envelope.schema.json")),
    )


def _schema_errors(value: object, schema: dict, error_schema: dict, path: str = "$", root_schema: dict | None = None) -> list[str]:
    root_schema = root_schema or schema
    ref = schema.get("$ref")
    if isinstance(ref, str):
        if ref.startswith("#/"):
            target = root_schema
            for part in ref[2:].split("/"):
                target = target[part]
        elif ref.endswith("error-envelope.schema.json"):
            target = error_schema
        else:
            return [f"{path}: unsupported schema reference {ref}"]
        return _schema_errors(value, target, error_schema, path, root_schema)
    if "oneOf" in schema:
        matches = [not _schema_errors(value, option, error_schema, path, root_schema) for option in schema["oneOf"]]
        return [] if sum(matches) == 1 else [f"{path}: did not match exactly one schema alternative"]
    errors = []
    expected_type = schema.get("type")
    valid_type = {
        "object": lambda item: isinstance(item, dict),
        "array": lambda item: isinstance(item, list),
        "string": lambda item: isinstance(item, str),
        "boolean": lambda item: isinstance(item, bool),
    }
    if expected_type in valid_type and not valid_type[expected_type](value):
        return [f"{path}: expected {expected_type}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected constant {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: value is outside enum")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{path}: string is too short")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            errors.append(f"{path}: string does not match pattern")
        if schema.get("format") == "uri" and not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", value):
            errors.append(f"{path}: expected URI")
    if isinstance(value, dict):
        missing = set(schema.get("required", [])) - value.keys()
        errors.extend(f"{path}: missing required property {key}" for key in sorted(missing))
        properties = schema.get("properties", {})
        for key, item in value.items():
            if key in properties:
                errors.extend(_schema_errors(item, properties[key], error_schema, f"{path}.{key}", root_schema))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: unexpected property {key}")
            elif isinstance(schema.get("additionalProperties"), dict):
                errors.extend(_schema_errors(item, schema["additionalProperties"], error_schema, f"{path}.{key}", root_schema))
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for index, item in enumerate(value):
            errors.extend(_schema_errors(item, schema["items"], error_schema, f"{path}[{index}]", root_schema))
    return errors


def _matches_machine_result(value: object) -> bool:
    machine_schema, error_schema = _ux_contracts()
    return not _schema_errors(value, machine_schema, error_schema)


def _valid_error_result(body: object) -> str | None:
    result = body.get("result") if isinstance(body, dict) else None
    envelope = result.get("structuredContent") if isinstance(result, dict) else None
    if not isinstance(result, dict) or result.get("isError") is not True:
        return "MCP invalid-argument call did not return isError: true"
    if not _matches_machine_result(envelope):
        return "MCP structuredContent does not match core/platform/contracts/ux-result/machine-result.schema.json"
    error = envelope["error"]
    if not isinstance(error.get("hint"), str) or not error["hint"].strip():
        return "MCP error envelope omitted its hint"
    if not isinstance(error.get("correlationId"), str) or not error["correlationId"].strip():
        return "MCP error envelope omitted its correlationId"
    texts = [item.get("text", "") for item in result.get("content", []) if isinstance(item, dict)]
    text = "\n".join(texts)
    if re.search(r"Traceback|\bat\s+[^\n]+\([^\n]*:\d+:\d+\)|(?:^|\n)(?:Error|TypeError|ReferenceError):|panic:", text):
        return "MCP error text exposed a stack trace"
    if any(value not in text for value in (error["code"], error["message"], error["hint"], error["correlationId"])):
        return "MCP error text omitted its code, message, hint, or correlationId"
    return None


def mcp_ux_result_contract(project_id: str, token: str, *, secured: bool = False) -> str | None:
    status, body, _ = _request(
        project_service_path(project_id, "mcp"), method="POST", token=token,
        step="project MCP UX result contract tools/list",
        accept="application/json, text/event-stream",
        payload={"jsonrpc": "2.0", "id": 2030, "method": "tools/list", "params": {}},
    )
    if status != 200:
        return f"MCP tools/list returned HTTP {status}, expected HTTP 200"
    result = body.get("result") if isinstance(body, dict) else None
    tools = result.get("tools") if isinstance(result, dict) else None
    if not isinstance(tools, list) or not tools:
        return "MCP tools/list did not return the live tool registry"
    for index, tool in enumerate(tools):
        if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
            return f"MCP registry entry {index} has no tool name"
        input_schema = tool.get("inputSchema")
        required = input_schema.get("required", []) if isinstance(input_schema, dict) else []
        arguments = {} if required else {"__ux_invalid_probe__": True}
        status, response = mcp_call(project_id, 2031 + index, tool["name"], arguments, token)
        if status != 200:
            return f"MCP invalid-argument call for {tool['name']} returned HTTP {status}, expected HTTP 200"
        failure = _valid_error_result(response)
        if failure:
            return f"MCP tool {tool['name']}: {failure}"

    if secured:
        diagnostics_status, diagnostics_body = mcp_call(
            project_id, 2090, "kb-labs__mcp_diagnostics", {}, "",
        )
        if diagnostics_status != 401:
            return f"secured diagnostics call without authorization returned HTTP {diagnostics_status}, expected 401"
        if not _matches_machine_result(diagnostics_body):
            return "secured diagnostics call did not return the shared ux-result error envelope"
        diagnostics_error = diagnostics_body["error"]
        if diagnostics_error.get("code") != "KB_AUTH_REQUIRED" or not diagnostics_error.get("hint") or not diagnostics_error.get("correlationId"):
            return "secured diagnostics call returned an incomplete KB_AUTH_REQUIRED envelope"

        no_token_status, no_token_body, _ = _request(
            project_service_path(project_id, "mcp"), method="POST", token="",
            step="secured project MCP UX result contract tools/list without token",
            accept="application/json, text/event-stream",
            payload={"jsonrpc": "2.0", "id": 2091, "method": "tools/list", "params": {}},
        )
        if no_token_status != 401:
            return f"secured MCP request without a token returned HTTP {no_token_status}, expected 401"
        if not _matches_machine_result(no_token_body):
            return "secured MCP request without a token did not return the shared ux-result error envelope"
        no_token_error = no_token_body["error"]
        if no_token_error.get("code") != "KB_AUTH_REQUIRED" or not no_token_error.get("hint") or not no_token_error.get("correlationId"):
            return "secured MCP request without a token returned an incomplete KB_AUTH_REQUIRED envelope"
    return None


def mcp_call(project_id: str, request_id: int, name: str, arguments: dict, token: str = ""):
    status, body, _ = _request(
        project_service_path(project_id, "mcp"),
        method="POST",
        token=token,
        step=f"project MCP tools/call {name}",
        accept="application/json, text/event-stream",
        payload={
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )
    return status, body


def _check_error_result(body: object, expected_code: str, *, argument: str | None = None) -> str | None:
    result = body.get("result") if isinstance(body, dict) else None
    machine_result = result.get("structuredContent") if isinstance(result, dict) else None
    if not isinstance(result, dict) or result.get("isError") is not True:
        return "MCP call did not return an error tool result"
    if not _matches_machine_result(machine_result):
        return "MCP structuredContent does not match the shared machine-result contract"
    envelope = machine_result["error"]
    required = {"code", "area", "stage", "severity", "retryable", "message", "hint", "correlationId"}
    if not required <= envelope.keys():
        return "MCP structuredContent does not contain the full shared error envelope"
    if envelope["code"] != expected_code:
        return f"MCP tool error code was {envelope['code']!r}, expected {expected_code}"
    text_lines = [item.get("text", "") for item in result.get("content", []) if isinstance(item, dict)]
    expected_text = f"{envelope['code']}: {envelope['message']} — {envelope['hint']} (correlationId: {envelope['correlationId']})"
    if expected_text not in text_lines:
        return "MCP tool error text does not match its structured envelope"
    if argument and argument not in envelope.get("message", "") and argument not in str(envelope.get("details", {})):
        return f"MCP validation error did not identify argument {argument!r}"
    return None


def unknown_tool(project_id: str, token: str = "") -> str | None:
    status, body = mcp_call(project_id, 1403, "tool-that-does-not-exist", {}, token)
    if status != 200:
        return f"unknown tool returned HTTP {status}, expected HTTP 200 tool error result"
    failure = _check_error_result(body, "KB_RUNTIME_MCP_UNKNOWN_TOOL")
    if failure:
        return failure
    result = body["result"]
    envelope = result["structuredContent"]["error"]
    if "tools/list" not in envelope["hint"]:
        return "unknown tool error hint did not name tools/list"
    return None


def invalid_arguments(project_id: str, token: str = "") -> str | None:
    status, body = mcp_call(project_id, 1404, commit_tool("commit plan apply"), {"force": "yes"}, token)
    if status != 200:
        return f"invalid arguments returned HTTP {status}, expected HTTP 200 tool error result"
    return _check_error_result(body, "KB_RUNTIME_MCP_INVALID_ARGUMENTS", argument="force")


def secured_auth(project_id: str) -> str | None:
    for token in ("", "not-a-real-token"):
        status, body, _ = _request(
            project_service_path(project_id, "mcp"),
            method="POST",
            payload={"jsonrpc": "2.0", "id": 145, "method": "tools/list", "params": {}},
            token=token,
            step="secured project MCP tools/list token check",
            accept="application/json, text/event-stream",
        )
        if status != 401:
            return f"secured tools/list with {'missing' if not token else 'invalid'} token returned HTTP {status}, expected 401"
        machine_result = body if isinstance(body, dict) else None
        envelope = machine_result.get("error") if isinstance(machine_result, dict) else None
        details = envelope.get("details") if isinstance(envelope, dict) else None
        gateway_url = details.get("gatewayUrl") if isinstance(details, dict) else None
        if (not isinstance(envelope, dict)
                or machine_result.get("ok") is not False
                or envelope.get("code") != "KB_AUTH_REQUIRED"
                or not isinstance(gateway_url, str)
                or envelope.get("hint") != catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl=gateway_url)
                or not isinstance(envelope.get("correlationId"), str)
                or not envelope["correlationId"].strip()):
            return f"secured tools/list with {'missing' if not token else 'invalid'} token returned no KB_AUTH_REQUIRED envelope"
        if isinstance(body, dict) and isinstance(body.get("result"), dict) and body["result"].get("tools"):
            return "secured tools/list returned a tool catalog without valid authentication"
    return None


def opaque_host_credential_mcp_rejection(project_id: str, cleanup_token: str) -> str | None:
    """Prove a registered host credential is refused by secured project MCP."""
    from service_runner import request as gateway_request

    host_id = None
    failure = None
    try:
        profile_status, profile, _ = gateway_request(
            "/auth/me", token=cleanup_token, step="resolve host registration namespace",
        )
        namespace_id = profile.get("tenantId") if isinstance(profile, dict) else None
        if profile_status != 200 or not isinstance(namespace_id, str) or not namespace_id:
            return f"authenticated Gateway profile did not provide a tenantId (HTTP {profile_status})"
        status, raw, _ = gateway_request(
            "/hosts/register", method="POST",
            payload={"name": "journey-mcp-opaque-auth", "namespaceId": namespace_id,
                     "capabilities": [], "workspacePaths": []},
            response_kind="raw", step="register disposable MCP auth host",
        )
        if status != 201:
            return f"host registration returned HTTP {status}, expected HTTP 201"
        try:
            registration = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            return f"host registration returned invalid JSON: {error}"
        host_id = registration.get("hostId") if isinstance(registration, dict) else None
        token = registration.get("machineToken") if isinstance(registration, dict) else None
        if not isinstance(host_id, str) or not isinstance(token, str):
            return "host registration omitted hostId or machineToken"

        status, body, _ = _request(
            project_service_path(project_id, "mcp"), method="POST", token=token,
            payload={"jsonrpc": "2.0", "id": 14510, "method": "tools/list", "params": {}},
            step="secured project MCP opaque host credential check",
            accept="application/json, text/event-stream",
        )
        machine_result = body if isinstance(body, dict) else None
        envelope = machine_result.get("error") if isinstance(machine_result, dict) else None
        details = envelope.get("details") if isinstance(envelope, dict) else None
        gateway_url = details.get("gatewayUrl") if isinstance(details, dict) else None
        if (status != 401 or machine_result is None or machine_result.get("ok") is not False
                or not isinstance(envelope, dict)
                or envelope.get("code") != "KB_AUTH_MCP_CREDENTIAL_REQUIRED"
                or not isinstance(gateway_url, str)
                or envelope.get("hint") != catalogued_error_hint("KB_AUTH_MCP_CREDENTIAL_REQUIRED", gatewayUrl=gateway_url)
                or not isinstance(envelope.get("correlationId"), str)
                or not envelope["correlationId"].strip()):
            failure = "secured project MCP did not refuse the opaque host credential with its catalogued 401 envelope"
    except Exception as error:
        failure = f"opaque host credential MCP check failed: {error}"
    finally:
        if host_id:
            try:
                status, _, _ = gateway_request(
                    f"/hosts/{quote(host_id, safe='')}", method="DELETE", token=cleanup_token,
                    response_kind="raw", step="remove disposable MCP auth host",
                )
                if status != 204 and failure is None:
                    failure = f"disposable host cleanup returned HTTP {status}, expected HTTP 204"
            except Exception as error:
                if failure is None:
                    failure = f"disposable host cleanup failed: {error}"
    return failure


def secured_project_catalog_isolation(project_a: str, project_b: str, token: str) -> str | None:
    """Check authentication and project-scoped catalogs for S-199.5."""
    if not token:
        return "secured project catalog check requires the authenticated journey token"
    for project_id in (project_a, project_b):
        path = project_service_path(project_id, "mcp")
        payload = {"jsonrpc": "2.0", "id": 1995, "method": "tools/list", "params": {}}
        with invocation_context(step_id="mcp.secured-catalog"):
            missing_status, missing_body, _ = _request(
                path, method="POST", payload=payload, accept="application/json, text/event-stream",
                step="project-scoped secured MCP tools/list without token",
            )
        envelope = missing_body.get("error") if isinstance(missing_body, dict) else None
        if (missing_status != 401 or not isinstance(envelope, dict)
                or envelope.get("code") != "KB_AUTH_REQUIRED"
                or not isinstance(envelope.get("correlationId"), str)
                or not envelope["correlationId"].strip()
                or (isinstance(missing_body, dict)
                    and isinstance(missing_body.get("result"), dict)
                    and missing_body["result"].get("tools"))):
            return f"secured tools/list for {project_id} did not return a 401 KB_AUTH_REQUIRED envelope without a catalog"

        with invocation_context(step_id="mcp.secured-catalog"):
            status, body, _ = _request(
                path, method="POST", token=token, payload=payload,
                step="project-scoped secured MCP tools/list with token",
                accept="application/json, text/event-stream",
            )
        if status != 200:
            return f"authenticated tools/list for {project_id} returned HTTP {status}, expected 200"
        result = body.get("result") if isinstance(body, dict) else None
        tools = result.get("tools") if isinstance(result, dict) else None
        if not isinstance(tools, list):
            return f"authenticated tools/list for {project_id} returned no catalog"
        names = {tool.get("name") for tool in tools if isinstance(tool, dict)}
        if project_id == project_a:
            if commit_tool("commit plan apply") not in names:
                return "Project A's authenticated catalog omitted its project-only Commit tool"
            if "kb-labs-review__review_run" in names:
                return "Project A's authenticated catalog included Project B's Review tool"
        else:
            if "kb-labs-review__review_run" not in names:
                return "Project B's authenticated catalog omitted its project-only Review tool"
            if commit_tool("commit plan apply") in names:
                return "Project B's authenticated catalog included Project A's Commit tool"
    return None


def local_auth(project_id: str, enabled_service_ids: frozenset[str] = DEFAULT_ENABLED_SERVICES) -> str | None:
    status, body, _ = _request(
        project_service_path(project_id, "mcp"),
        method="POST",
        payload={"jsonrpc": "2.0", "id": 454, "method": "tools/list", "params": {}},
        token="",
        step="local project MCP tools/list",
        accept="application/json, text/event-stream",
    )
    if status != 200:
        return f"local tokenless tools/list returned HTTP {status}, expected 200"
    result = body.get("result") if isinstance(body, dict) else None
    tools = result.get("tools") if isinstance(result, dict) else None
    if not isinstance(tools, list) or not tools:
        return "local tokenless tools/list did not return the selected project catalog"
    names = {tool.get("name") for tool in tools if isinstance(tool, dict)}
    expected = {
        commit_tool("commit commit"),
        *service_tool_names(enabled_service_ids),
        "kb-labs__mcp_diagnostics",
    }
    if not expected <= names:
        return f"local tokenless tools/list mismatch: expected={sorted(expected)} served={sorted(names)[:50]}"
    return None


def commit_tool_schema(project_id: str, token: str) -> str | None:
    status, body, _ = _request(
        project_service_path(project_id, "mcp"),
        method="POST",
        token=token,
        step="project Commit tool schema tools/list",
        accept="application/json, text/event-stream",
        payload={"jsonrpc": "2.0", "id": 1401, "method": "tools/list", "params": {}},
    )
    if status != 200:
        return f"project A tools/list returned HTTP {status}"
    result = body.get("result") if isinstance(body, dict) else None
    tools = result.get("tools", []) if isinstance(result, dict) else []
    tool = next((item for item in tools if isinstance(item, dict) and item.get("name") == commit_tool("commit plan apply")), None)
    if tool is None:
        return "project A catalog omitted the declared commit plan apply tool"
    schema = tool.get("inputSchema")
    if not isinstance(schema, dict) or schema.get("type") != "object" or not isinstance(schema.get("properties"), dict):
        return "commit plan apply tool did not expose its manifest-derived object input schema"
    properties = schema["properties"]
    if any(not isinstance(properties.get(name), dict) or properties[name].get("type") != "boolean"
           for name in ("force", "json")):
        return "commit plan apply schema did not describe its force and json flags as booleans"
    required = schema.get("required", [])
    if not isinstance(required, list) or any(name in required for name in ("force", "json")):
        return "commit plan apply schema did not preserve the flags' optional status"
    return None


def apply_commit_plan(project_id: str, token: str, project_root: str) -> str | None:
    fixture_path = os.environ.get("KB_JOURNEY_PROJECT_FIXTURES_FILE", "")
    preparation_result = None
    if fixture_path and Path(fixture_path).is_file():
        handoff = json.loads(Path(fixture_path).read_text(encoding="utf-8"))
        preparation_result = handoff.get("commitPlanPreparationResult")
    plan_show = run_command(["kb", "commit", "plan", "show", "--json"],
                            cwd=project_root, env=os.environ, timeout=30)
    status, body = mcp_call(project_id, 1402, commit_tool("commit plan apply"), {}, token)
    if status != 200:
        return f"commit plan apply returned HTTP {status}"
    result = body.get("result") if isinstance(body, dict) else None
    content = result.get("content", []) if isinstance(result, dict) else []
    text = "\n".join(item.get("text", "") for item in content if isinstance(item, dict))
    if not isinstance(result, dict) or result.get("isError") or not text:
        return ("commit plan apply did not return a successful result containing the created commit SHA; "
                f"plan preparation={json.dumps(preparation_result, sort_keys=True)} "
                f"plan show --json exit={plan_show.returncode} stdout={plan_show.stdout[:4000]} stderr={plan_show.stderr[:1000]}")
    commits = re.findall(r"(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])", text, flags=re.IGNORECASE)
    if not commits:
        return "commit plan apply output did not contain a commit SHA"
    structured = result.get("structuredContent", {})
    ui_output = structured.get("meta", {}).get("ui", []) if isinstance(structured, dict) else []
    if not isinstance(ui_output, list) or not any(
        commit.lower() in json.dumps(item).lower() for commit in commits for item in ui_output
    ):
        return "commit plan apply structured UI output did not preserve the created commit SHA"
    history = run_command(["git", "-C", project_root, "log", "--format=%h", "--all"],
                          env=os.environ, timeout=30)
    if history.returncode != 0:
        return "could not inspect project A Git history after the commit tool call"
    if not any(commit.lower() in {line.lower() for line in history.stdout.splitlines()} for commit in commits):
        return "commit plan apply output SHA was not found in project A Git history"
    return None


def project_isolation(project_a: str, project_b: str, project_b_root: str, token: str) -> str | None:
    if project_a == project_b:
        return "project A and project B must be distinct registered projects"
    registered_root = Path(project_b_root)
    if (not registered_root.is_dir() or not registered_root.is_absolute()
            or str(registered_root.resolve()) != project_b_root):
        return "project B registry root must be an existing canonical directory"
    status, body, _ = _request(
        project_service_path(project_b, "mcp"),
        method="POST",
        token=token,
        step="project B MCP tools/list isolation",
        accept="application/json, text/event-stream",
        payload={"jsonrpc": "2.0", "id": 1405, "method": "tools/list", "params": {}},
    )
    if status != 200:
        return f"project B tools/list returned HTTP {status}"
    result = body.get("result") if isinstance(body, dict) else None
    tools = result.get("tools", []) if isinstance(result, dict) else []
    if any(isinstance(tool, dict) and tool.get("name") == commit_tool("commit plan apply") for tool in tools):
        return "project B listed project A's project-scoped commit tool"
    return unknown_tool(project_b, token)


def project_plugin_catalog_isolation(project_a: str, project_b: str, token: str) -> str | None:
    """Check that a project-only Commit tool appears in A's catalog, not B's."""
    catalogs: dict[str, set[str]] = {}
    for project_id in (project_a, project_b):
        with invocation_context(step_id="mcp.project-catalog"):
            status, body, _ = _request(
                project_service_path(project_id, "mcp"), method="POST", token=token,
                step="project plugin catalog tools/list",
                accept="application/json, text/event-stream",
                payload={"jsonrpc": "2.0", "id": 1993, "method": "tools/list", "params": {}},
            )
        if status != 200:
            return f"project {project_id} tools/list returned HTTP {status}"
        result = body.get("result") if isinstance(body, dict) else None
        tools = result.get("tools") if isinstance(result, dict) else None
        if not isinstance(tools, list):
            return f"project {project_id} tools/list returned no tool catalog"
        catalogs[project_id] = {tool["name"] for tool in tools
                                if isinstance(tool, dict) and isinstance(tool.get("name"), str)}
    project_only_tool = commit_tool("commit plan apply")
    if project_only_tool not in catalogs[project_a]:
        return "Project A's catalog omitted its project-only Commit tool"
    if project_only_tool in catalogs[project_b]:
        return "Project B's catalog included Project A's Commit tool"
    return None


def project_readonly_tool_isolation(project_a: str, project_b: str, token: str) -> str | None:
    """Read Project A's Commit plan, then verify the same read-only tool is absent from B (S-199.4)."""
    tool_name = commit_tool("commit plan show")
    with invocation_context(step_id="mcp.project-readonly-tool"):
        status_a, body_a, _ = _request(
            project_service_path(project_a, "mcp"), method="POST", token=token,
            step="project A read-only Commit tool call",
            accept="application/json, text/event-stream",
            payload={"jsonrpc": "2.0", "id": 1994, "method": "tools/call",
                     "params": {"name": tool_name, "arguments": {"json": True}}},
        )
    if status_a != 200:
        return f"Project A's read-only Commit plan tool returned HTTP {status_a}"
    result_a = body_a.get("result") if isinstance(body_a, dict) else None
    if not isinstance(result_a, dict) or result_a.get("isError") is True:
        return "Project A's read-only Commit plan tool did not succeed"
    structured_a = result_a.get("structuredContent")
    if not isinstance(structured_a, dict):
        return "Project A's read-only Commit plan tool returned no structured result"
    result_data = structured_a.get("result", structured_a)
    if not isinstance(result_data, dict) or result_data.get("hasPlan") is not True:
        return "Project A's read-only Commit plan tool did not return its project plan"

    with invocation_context(step_id="mcp.project-readonly-tool"):
        status_b, body_b, _ = _request(
            project_service_path(project_b, "mcp"), method="POST", token=token,
            step="project B read-only Commit tool call",
            accept="application/json, text/event-stream",
            payload={"jsonrpc": "2.0", "id": 1994, "method": "tools/call",
                     "params": {"name": tool_name, "arguments": {"json": True}}},
        )
    if status_b != 200:
        return f"Project B's unknown Commit tool returned HTTP {status_b}, expected MCP HTTP 200"
    return _check_error_result(body_b, "KB_RUNTIME_MCP_UNKNOWN_TOOL")


def run_agent_session_steps(journey: Journey, project_id: str, token: str,
                            agent_id: str = "orchestrator") -> None:
    """Exercise the documented project Agents session REST lifecycle (S-141)."""
    session_id = ""
    base = project_service_path(project_id, "rest", "plugins/agents/sessions")

    def create() -> str | None:
        nonlocal session_id
        with invocation_context(step_id="S-141.1"):
            status, body, _ = _ux_request(
                base, method="POST", token=token,
                payload={"agentId": agent_id, "task": "Summarize the project"},
            )
        data = body.get("data", body) if isinstance(body, dict) else {}
        session = data.get("session", data) if isinstance(data, dict) else {}
        if status < 200 or status >= 300:
            return f"agent session creation returned HTTP {status}"
        if not isinstance(session, dict):
            return "agent session creation returned no session object"
        session_id = session.get("id", "")
        if (not isinstance(session_id, str) or not session_id.strip()
                or session.get("agentId") != agent_id
                or session.get("task") != "Summarize the project"
                or not session.get("status")):
            return "agent session response omitted its ID, supplied agent/task, or initial status"
        return None

    journey.step("create project agent session", "agents", create, cases=["S-141.1"])

    def list_sessions() -> str | None:
        with invocation_context(step_id="S-141.2"):
            status, body, _ = _ux_request(base, token=token)
        data = body.get("data", body) if isinstance(body, dict) else {}
        rows = data.get("sessions", []) if isinstance(data, dict) else []
        total = data.get("total", 0) if isinstance(data, dict) else 0
        if status != 200 or not isinstance(rows, list):
            return f"agent session list returned HTTP {status} or no sessions collection"
        if not any(isinstance(row, dict) and row.get("id") == session_id for row in rows):
            return "agent session list omitted the created session ID"
        if not isinstance(total, int) or total < 1:
            return "agent session list total did not include the created session"
        return None

    journey.step("list project agent sessions", "agents", list_sessions, cases=["S-141.2"],
                 requires=("step:create project agent session",))

    def inspect_session() -> str | None:
        for suffix, description in (("", "detail"), ("/turns", "turn history"), ("/plan", "plan")):
            with invocation_context(step_id="S-141.3"):
                status, body, _ = _ux_request(f"{base}/{session_id}{suffix}", token=token)
            data = body.get("data", body) if isinstance(body, dict) else {}
            if status != 200 or not isinstance(data, dict):
                return f"agent session {description} returned HTTP {status} or no object"
            if description == "turn history":
                turns = data.get("turns", data.get("items"))
                if not isinstance(turns, list) or (turns and not any(
                    isinstance(turn, dict) and turn.get("sessionId") == session_id for turn in turns
                )):
                    return "agent session turn history did not identify the session or return an empty collection"
            else:
                identity = data.get("session") if description == "detail" else data
                if not isinstance(identity, dict) or identity.get("sessionId", identity.get("id")) != session_id:
                    return f"agent session {description} did not identify the created session"
        return None

    journey.step("inspect project agent session", "agents", inspect_session, cases=["S-141.3"],
                 requires=("step:create project agent session",))

    def unknown_session() -> str | None:
        missing_id = "session-does-not-exist"
        with invocation_context(step_id="S-141.4"):
            status, body, _ = _ux_request(f"{base}/{missing_id}", token=token)
        rendered = json.dumps(body, ensure_ascii=False) if isinstance(body, (dict, list)) else str(body)
        error = body.get("error") if isinstance(body, dict) else None
        if (status != 404 or not isinstance(error, dict)
                or error.get("code") != "KB_RUNTIME_RESOURCE_NOT_FOUND"
                or error.get("details", {}).get("sessionId") != missing_id):
            return "unknown agent session response did not return not found naming the session ID"
        if re.search(r"Traceback|\bat\s+[^\n]+\([^\n]*:\d+:\d+\)|(?:^|\n)(?:Error|TypeError|ReferenceError):|panic:", rendered):
            return "unknown agent session response exposed a stack trace"
        return None

    journey.step("reject unknown project agent session", "agents", unknown_session, cases=["S-141.4"])

    def unknown_agent() -> str | None:
        with invocation_context(step_id="S-141.5"):
            status, body, _ = _ux_request(
                base, method="POST", token=token,
                payload={"agentId": "agent-does-not-exist", "task": "Summarize the project"},
            )
        error = body.get("error") if isinstance(body, dict) else None
        if (status != 404 or not isinstance(error, dict)
                or error.get("code") != "KB_AGENT_NOT_FOUND"
                or error.get("details", {}).get("agentId") != "agent-does-not-exist"):
            return "unknown agent ID did not return the typed KB_AGENT_NOT_FOUND 404"
        return None

    journey.step("reject undefined project agent ID", "agents", unknown_agent, cases=["S-141.5"])

    def unknown_route() -> str | None:
        path = project_service_path(project_id, "rest", "plugins/agents/unknown-route")
        with invocation_context(step_id="S-141.6"):
            status, body, _ = _ux_request(path, token=token)
        error = body.get("error") if isinstance(body, dict) else None
        if (status != 404 or not isinstance(error, dict)
                or error.get("code") != "KB_RUNTIME_RESOURCE_NOT_FOUND"
                or "@kb-labs/agents" not in str(error.get("message", ""))
                or "unknown-route" not in str(error.get("message", ""))
                or "kb marketplace plugins doctor --scope project" not in str(error.get("hint", ""))):
            return "unknown project Agents REST route did not return a catalogued route-specific 404"
        return None

    journey.step("report an unknown project Agents REST route", "agents", unknown_route, cases=["S-141.6"])
