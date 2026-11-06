"""Gateway configuration, adapter-call and telemetry claims."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from kb_invocation import kb_command
from journey_values import journey_value

import json
import os
from pathlib import Path
import shlex
import urllib.request

from invocations import (
    CompletedProcess,
    decode_ux_error_result,
    decode_ux_success_result,
    invocation_context,
    open_http,
    read_ux_cli_result,
    read_ux_http_result,
    run_command,
)
from journey_resources import active_platform_root
from project_service_path import project_service_path
from service_steps import Journey
from installed_fixture import layout_value


@dataclass(frozen=True)
class GatewayHttpResponse:
    data: object | None = None
    error: dict[str, Any] | None = None
    meta: dict[str, Any] | None = None
    stream: str | None = None
    stream_error: dict[str, Any] | None = None
    stream_error_problem: str | None = None


def _stream_error(stream: str) -> tuple[dict[str, Any] | None, str | None]:
    for frame in stream.split("\n\n"):
        lines = frame.splitlines()
        if "event: error" not in lines:
            continue
        for line in lines:
            if not line.startswith("data: "):
                continue
            try:
                return decode_ux_error_result(json.loads(line[6:])), None
            except (json.JSONDecodeError, ValueError) as error:
                return None, f"SSE error event is invalid: {error}"
    return None, None


def _http(path: str, *, token: str, method: str = "GET", payload: object = None,
          opener=urllib.request.urlopen) -> tuple[int, GatewayHttpResponse]:
    base = journey_value("KB_JOURNEY_BASE_URL", "http://127.0.0.1:4000").rstrip("/")
    request = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
                 **({"Authorization": f"Bearer {token}"} if token else {})}, method=method,
    )
    status, raw, _ = open_http(opener, request, timeout=60, env=os.environ)
    if path == "/platform/v1/llm/stream" and status == 200:
        stream = raw.decode(errors="replace")
        stream_error, stream_error_problem = _stream_error(stream)
        return status, GatewayHttpResponse(stream=stream, stream_error=stream_error,
                                           stream_error_problem=stream_error_problem)
    try:
        envelope = read_ux_http_result(raw, status)
        if 200 <= status < 300:
            return status, GatewayHttpResponse(data=decode_ux_success_result(envelope),
                                               meta=envelope.get("meta"))
        return status, GatewayHttpResponse(error=decode_ux_error_result(envelope))
    except ValueError as error:
        raise AssertionError(f"HTTP {method} {path} did not return a UX JSON envelope: {error}") from error


def _cli(command: list[str], step_id: str, runner, *, cwd: str) -> CompletedProcess[str]:
    with invocation_context(step_id=step_id):
        return runner(command, cwd=cwd, env=os.environ.copy(),
                      timeout=180, capture_output=True, text=True, check=False)


def _json_contains(result: CompletedProcess[str], expected: str) -> bool:
    if result.returncode != 0:
        return False
    payload = read_ux_cli_result(result)
    if result.returncode == 0:
        payload = decode_ux_success_result(payload)
    values: list[str] = []

    def collect(value: object) -> None:
        if isinstance(value, str):
            values.append(value)
        elif isinstance(value, dict):
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    collect(payload)
    return expected in values


def _json_string_field(result: CompletedProcess[str] | None, field: str) -> str | None:
    if result is None:
        raise ValueError("CLI result is required")
    payload = read_ux_cli_result(result)
    if result.returncode == 0:
        payload = decode_ux_success_result(payload)

    def find(value: object) -> str | None:
        if isinstance(value, dict):
            candidate = value.get(field)
            if isinstance(candidate, str) and candidate:
                return candidate
            for child in value.values():
                found = find(child)
                if found:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = find(child)
                if found:
                    return found
        return None

    return find(payload)


def _json_object(result: CompletedProcess[str] | None) -> dict[str, object]:
    if result is None:
        raise ValueError("CLI result is required")
    payload = read_ux_cli_result(result)
    return decode_ux_success_result(payload) if result.returncode == 0 else decode_ux_error_result(payload)


def _install_error(result: CompletedProcess[str]) -> str:
    try:
        payload = _json_object(result)
        message = payload.get("message")
        if isinstance(message, str) and message:
            return message
    except ValueError as parse_error:
        return (result.stderr or result.stdout).strip() or str(parse_error)
    return (result.stderr or result.stdout).strip() or f"install exited with status {result.returncode}"


def _store_studio_llm_model(model: str | None) -> None:
    fixture_file = journey_value("KB_JOURNEY_STUDIO_FIXTURE_FILE", "")
    if not model or not fixture_file:
        return
    path = Path(fixture_file)
    if not path.is_file():
        return
    fixture = json.loads(path.read_text(encoding="utf-8"))
    fixture["model"] = model
    path.write_text(json.dumps(fixture), encoding="utf-8")


def run_llm_provider_steps(journey: Journey, *, project_id: str, project_root: str,
                           project_b_id: str, project_b_root: str, runner=run_command) -> None:
    platform_root = Path(journey_value("KB_JOURNEY_PLATFORM_ROOT", str(Path.home() / "kb-platform"))).resolve()
    platform_config = platform_root / layout_value('sharedRuntimePaths.kb_kb_config_jsonc.statePath')
    original_config = platform_config.read_bytes() if platform_config.exists() else None
    cleanup_error = None
    try:
        _run_llm_provider_steps(journey, project_id=project_id, project_root=project_root,
                                project_b_id=project_b_id, project_b_root=project_b_root,
                                runner=runner)
    finally:
        try:
            current_config = platform_config.read_bytes() if platform_config.exists() else None
            if current_config != original_config:
                if original_config is None:
                    platform_config.unlink(missing_ok=True)
                else:
                    platform_config.write_bytes(original_config)
                restored = runner(
                    ["kb-create", "restart", "--platform-root", str(platform_root), "--json"],
                    cwd=project_root, env=os.environ.copy(), timeout=300,
                    capture_output=True, text=True, check=False,
                )
                if restored.returncode != 0:
                    detail = " ".join(f"{restored.stdout or ''} {restored.stderr or ''}".split())
                    cleanup_error = f"platform host did not restart after restoring its LLM config: {detail}"
                elif (platform_config.read_bytes() if platform_config.exists() else None) != original_config:
                    cleanup_error = "platform LLM config differs from its pre-journey snapshot after restart"
        except Exception as error:
            cleanup_error = f"platform LLM config could not be restored: {error}"
        journey.step("restore platform LLM journey fixture state", "gateway",
                     lambda: cleanup_error, role="lifecycle")


def _run_llm_provider_steps(journey: Journey, *, project_id: str, project_root: str,
                            project_b_id: str, project_b_root: str, runner=run_command) -> None:
    """Exercise and prove both configured provider protocols with the fixture plugin."""
    mock_base = journey_value("KB_JOURNEY_LLM_MOCK_BASE_URL", "http://mock-llm:8317")
    def cli(command: list[str], step_id: str, command_runner=runner, *, cwd: str | None = None):
        return _cli(command, step_id, command_runner, cwd=cwd or project_root)

    adapter = cli(kb_command([ "config", "set", "--scope", "platform", "platform.adapters.llm",
                    "@kb-labs/adapters-openai", "--json"]), "S-017.1", runner)
    journey.step("configure platform OpenAI adapter", "gateway", lambda: (
        None if adapter.returncode == 0 else "could not select @kb-labs/adapters-openai at platform scope"
    ), cases=["S-017.1", "S-018.1"])

    secret_ref = cli(kb_command([ "config", "set", "--scope", "platform",
                       "platform.adapterOptions.llm.apiKey", "${OPENAI_API_KEY}", "--json"]), "S-017.2", runner)
    project_config = Path(project_root) / ".kb" / "kb.config.jsonc"
    project_config_before = project_config.read_bytes() if project_config.is_file() else None
    openai_base = cli(kb_command([ "config", "set", "--scope", "platform",
                        "platform.adapterOptions.llm.baseURL", f"{mock_base}/v1", "--json"]), "S-017.2", runner)
    base_result_error = None
    try:
        base_result = _json_object(openai_base)
    except ValueError as error:
        base_result = {}
        base_result_error = str(error)
    platform_root = Path(journey_value("KB_JOURNEY_PLATFORM_ROOT", str(Path.home() / "kb-platform"))).resolve()
    expected_platform_config = str(
        platform_root / layout_value('sharedRuntimePaths.kb_kb_config_jsonc.statePath')
    )
    scope_ok = (base_result_error is None and base_result.get("file") == expected_platform_config
                and project_config_before == (project_config.read_bytes() if project_config.is_file() else None)
                and base_result.get("nextCommand") == f"kb-create restart --platform-root {json.dumps(str(platform_root))}")
    openai_model = cli(kb_command([ "config", "set", "--scope", "platform",
                         "platform.adapterOptions.llm.model", "journey-mock-model", "--json"]), "S-017.2", runner)
    inspect = cli(kb_command([ "config", "get", "platform.adapterOptions.llm.apiKey", "--json"]), "S-017.4", runner)
    secret_safe = (secret_ref.returncode == 0 and openai_base.returncode == 0
                   and openai_model.returncode == 0 and inspect.returncode == 0
                   and "${OPENAI_API_KEY}" in inspect.stdout
                   and os.environ.get("OPENAI_API_KEY", "") not in inspect.stdout)
    journey.step("store platform config without exposing the key or changing project config", "gateway",
                 lambda: (None if secret_safe and scope_ok else
                          f"platform config command returned an invalid UX result: {base_result_error}"
                          if base_result_error else
                          "platform config wrote to the wrong file, changed project config, omitted restart guidance, or exposed the OPENAI_API_KEY reference"),
                 cases=["S-017.2", "S-017.4", "S-017.5"])

    next_command = base_result.get("nextCommand")
    restart = (cli(shlex.split(next_command), "S-017.5", runner)
               if isinstance(next_command, str) else None)
    journey.step("restart the host after changing platform LLM settings", "gateway", lambda: (
        None if restart is not None and restart.returncode == 0
        else (f"kb config set returned no restart command: {base_result_error}"
              if base_result_error else "kb config set did not return a restart command")
    ), cases=["S-017.5"])

    project_a = project_root
    project_b = project_b_root
    fixture_command = kb_command([ "journey", "llm", "complete", "--json"])

    openai_a = cli([*fixture_command, "--marker=provider-openai-project-a"], "S-017.3", runner, cwd=project_a) if project_a else None
    openai_content = openai_a is not None and _json_contains(openai_a, "OPENAI_MOCK_RESPONSE")
    openai_model = _json_string_field(openai_a, "model") if openai_content else None
    _store_studio_llm_model(openai_model)
    journey.step("call the configured OpenAI adapter from project A", "gateway", lambda: (
        None if openai_content and openai_model == "journey-mock-model"
        else "project A did not return the deterministic OpenAI mock response in its JSON result"
    ), cases=["S-017.3"])

    openai_projects = [
        cli([*fixture_command, f"--marker=provider-openai-{label}"], "S-018.2", runner, cwd=root)
        for label, root in (("a", project_a), ("b", project_b)) if root
    ]
    project_ids = [project_id, project_b_id]
    journey.step("call OpenAI adapter from both registered projects", "gateway", lambda: (
        None if all(project_ids) and len(openai_projects) == 2
        and all(_json_contains(item, "OPENAI_MOCK_RESPONSE") for item in openai_projects)
        else "both registered project roots must return the deterministic OpenAI mock response"
    ), cases=["S-018.2"])

    vibe_install = cli(kb_command([ "marketplace", "install", "@kb-labs/adapters-vibeproxy",
                         "--scope", "platform", "--json"]), "setup-vibeproxy-install", runner)
    install_error = _install_error(vibe_install) if vibe_install.returncode != 0 else ""
    journey.step("install VibeProxy adapter prerequisite", "gateway", lambda: (
        None if vibe_install.returncode == 0 else f"VibeProxy install failed: {install_error}"
    ), cases=[])
    if vibe_install.returncode != 0:
        journey.step("switch to VibeProxy messages protocol in both projects", "gateway",
                     lambda: f"prerequisite not met: {install_error}", cases=["S-018.3"])
        return

    vibe_adapter = cli(kb_command([ "config", "set", "--scope", "platform", "platform.adapters.llm",
                         "@kb-labs/adapters-vibeproxy", "--json"]), "S-018.3", runner)
    vibe_url = cli(kb_command([ "config", "set", "--scope", "platform", "platform.adapterOptions.llm.baseURL",
                     mock_base, "--json"]), "S-018.3", runner)
    vibe_key = cli(kb_command([ "config", "set", "--scope", "platform", "platform.adapterOptions.llm.apiKey",
                     "${VIBEPROXY_API_KEY}", "--json"]), "S-018.3", runner)
    vibe_model = cli(kb_command([ "config", "set", "--scope", "platform", "platform.adapterOptions.llm.model",
                       "journey-mock-model", "--json"]), "S-018.3", runner)
    vibe_restart = cli(shlex.split(str(_json_object(vibe_adapter).get("nextCommand", "kb-create restart"))),
                        "S-018.3", runner)
    vibe_projects = [
        cli([*fixture_command, f"--marker=provider-vibeproxy-{label}"], "S-018.3", runner, cwd=root)
        for label, root in (("a", project_a), ("b", project_b)) if root
    ]
    journey.step("switch to VibeProxy messages protocol in both projects", "gateway", lambda: (
        None if all(project_ids) and len(vibe_projects) == 2
        and all(_json_contains(item, "VIBEPROXY_MOCK_RESPONSE") for item in vibe_projects)
        and all(_json_string_field(item, "stopReason") == "end_turn" for item in vibe_projects)
        and all(item.returncode == 0 for item in (vibe_adapter, vibe_url, vibe_key, vibe_model, vibe_restart))
        else "both registered projects must return the deterministic VibeProxy Messages API response with stopReason=end_turn"
    ), cases=["S-018.3"])


def run_gateway_steps(journey: Journey, *, token: str, project_id: str, project_root: str,
                      project_b_id: str, project_b_root: str, runner=run_command,
                      opener=urllib.request.urlopen) -> None:
    """Run gateway-owned claims; credentials are always supplied by environment references."""
    run_llm_provider_steps(journey, project_id=project_id, project_root=project_root,
                           project_b_id=project_b_id, project_b_root=project_b_root, runner=runner)

    with invocation_context(step_id="S-189.7"):
        missing_status, missing = _http("/platform/v1/unknown/resource", token=token, opener=opener)
    journey.step("return a JSON 404 for an unmounted Platform API route", "gateway", lambda: (
        None if missing_status == 404 and missing.error is not None
        and missing.error.get("code") == "KB_RUNTIME_RESOURCE_NOT_FOUND"
        else f"unmounted Platform API route returned HTTP {missing_status} without KB_RUNTIME_RESOURCE_NOT_FOUND"
    ), cases=["S-189.7"])

    with invocation_context(step_id="S-189.2"):
        call_status, call_body = _http("/platform/v1/analytics/track", token=token, method="POST",
                                       payload={"args": ["case.gateway.call", {"source": "case-fixture"}]}, opener=opener)
    with invocation_context(step_id="S-189.2"):
        events_status, events_body = _http("/platform/v1/analytics/getEvents", token=token, method="POST",
                                           payload={"args": [{"type": "case.gateway.call", "limit": 50}]}, opener=opener)
    event_data = events_body.data if isinstance(events_body.data, dict) else {}
    recorded_events = event_data.get("events", []) if isinstance(event_data, dict) else []
    event_recorded = isinstance(recorded_events, list) and any(
        isinstance(event, dict) and event.get("type") == "case.gateway.call"
        for event in recorded_events
    )
    journey.step("call analytics through platform API", "gateway", lambda: (
        None if call_status == 200 and call_body.error is None and call_body.data is None
        and isinstance(call_body.meta, dict) and isinstance(call_body.meta.get("durationMs"), (int, float))
        and events_status == 200 and event_recorded
        else f"platform analytics call returned HTTP {call_status} without its valid success result and recorded event (read HTTP {events_status})"
    ), cases=["S-189.2"])

    for path in ("/platform/v1/unknownAdapter/method", "/platform/v1/analytics/unknownMethod"):
        with invocation_context(step_id="S-189.3"):
            status, body = _http(path, token=token, method="POST", payload={"args": []}, opener=opener)
        error = body.error or {}
        if status >= 400 and error.get("code") and error.get("hint"):
            continue
        journey.step("reject unsupported platform adapter call", "gateway",
                     lambda: f"{path} did not return a typed client-safe error with corrective hint (HTTP {status})",
                     cases=["S-189.3"])
        break
    else:
        journey.step("reject unsupported platform adapter calls", "gateway", lambda: None, cases=["S-189.3"])

    with invocation_context(step_id="S-189.4"):
        stream_status, stream = _http("/platform/v1/llm/stream", token=token, method="POST",
                                      payload={"args": ["case stream"]}, opener=opener)
    journey.step("stream platform LLM results", "gateway", lambda: (
        None if stream_status == 200 and isinstance(stream.stream, str) and "[DONE]" in stream.stream
        else f"LLM stream returned HTTP {stream_status} without SSE chunks and [DONE]"
    ), cases=["S-189.4"])

    with invocation_context(step_id="S-189.5"):
        error_status, error_stream = _http("/platform/v1/llm/stream", token=token, method="POST",
                                           payload={"args": ["journey-provider-401"]}, opener=opener)
        first_health_status, first_health = _http("/health", token=token, opener=opener)
        midstream_status, midstream_stream = _http("/platform/v1/llm/stream", token=token, method="POST",
                                                   payload={"args": ["journey-provider-stream-error"]}, opener=opener)
        second_health_status, second_health = _http("/health", token=token, opener=opener)
    error_envelope = error_stream.error or {}
    midstream_envelope = midstream_stream.stream_error or {}
    midstream_error_problem = midstream_stream.stream_error_problem
    provider_unavailable_in_stream = (
        midstream_status == 200 and midstream_envelope.get("code") == "KB_CONFIG_LLM_PROVIDER_UNAVAILABLE"
        and midstream_envelope.get("hint")
        and midstream_envelope.get("message") and midstream_envelope.get("correlationId")
        and midstream_stream.stream
        and "data: " in midstream_stream.stream.split("event: error", 1)[0]
        and "[DONE]" not in midstream_stream.stream
    )
    before_headers_error = (error_status == 502 and isinstance(error_envelope, dict)
                            and error_envelope.get("code") == "KB_CONFIG_LLM_KEY_INVALID"
                            and error_envelope.get("message") and error_envelope.get("hint")
                            and error_envelope.get("correlationId"))
    health_ok = all(
        status == 200 and response.error is None and isinstance(response.data, dict)
        for status, response in ((first_health_status, first_health), (second_health_status, second_health))
    )
    journey.step("keep gateway healthy after an LLM stream failure", "gateway", lambda: (
        None if before_headers_error and provider_unavailable_in_stream and health_ok
        else (f"LLM stream failure was not typed; gateway health returned HTTP {first_health_status} and "
              f"{second_health_status}; {midstream_error_problem}" if midstream_error_problem else
              f"LLM stream failure was not typed or gateway health returned HTTP {first_health_status} / {second_health_status}")
    ), cases=["S-189.5"])

    with invocation_context(step_id="S-189.6"):
        invalid_status, invalid_body = _http("/platform/v1/llm/stream", token=token, method="POST",
                                              payload={"args": []}, opener=opener)
    journey.step("reject an LLM stream request without a prompt", "gateway", lambda: (
        None if invalid_status == 400 and (invalid_body.error or {}).get("code") == "KB_RUNTIME_INPUT_INVALID"
        else f"empty LLM stream args returned HTTP {invalid_status} without KB_RUNTIME_INPUT_INVALID"
    ), cases=["S-189.6"])

    telemetry_source = f"case-fixture-{journey.run_id}"
    telemetry_from = journey_value("KB_JOURNEY_STARTED_AT", "")
    events500 = [{"source": telemetry_source, "type": f"case.telemetry.{index}"} for index in range(500)]
    with invocation_context(step_id="S-190.1"):
        accepted_status, accepted = _http("/telemetry/v1/ingest", token=token, method="POST",
                                          payload={"events": events500}, opener=opener)
    journey.step("ingest telemetry batch at limit", "gateway", lambda: (
        None if accepted_status == 200 and isinstance(accepted.data, dict)
        and accepted.data.get("accepted") == 500 and accepted.data.get("rejected") == 0
        else f"500-event telemetry batch returned HTTP {accepted_status} or incorrect counts"
    ), cases=["S-190.1"])

    events501 = [{"source": telemetry_source, "type": f"case.telemetry.over.{index}"} for index in range(501)]
    with invocation_context(step_id="S-190.2"):
        rejected_status, rejected = _http("/telemetry/v1/ingest", token=token, method="POST",
                                          payload={"events": events501}, opener=opener)
    telemetry_query = project_service_path(project_id, "rest", f"analytics/events?source={telemetry_source}")
    if telemetry_from:
        telemetry_query += f"&from={telemetry_from}"
    with invocation_context(step_id="S-190.2"):
        after_rejection_status, after_rejection = _http(telemetry_query, token=token, opener=opener)
    rejected_error = rejected.error or {}
    details = rejected_error.get("details", {})
    stored = after_rejection.data.get("events", []) if isinstance(after_rejection.data, dict) else []
    mutated = isinstance(stored, list) and any(
        isinstance(event, dict) and str(event.get("type", "")).startswith("case.telemetry.over.")
        for event in stored
    )
    journey.step("reject telemetry batch above limit", "gateway", lambda: (
        None if rejected_status == 400 and rejected_error.get("code") == "KB_RUNTIME_INPUT_INVALID"
        and details.get("field") == "events"
        and after_rejection_status == 200 and not mutated
        else f"501-event telemetry batch returned HTTP {rejected_status} or was written / could not be verified after rejection"
    ), cases=["S-190.2"])


def run_adapter_catalog_step(journey: Journey, *, token: str,
                             opener=urllib.request.urlopen) -> None:
    """Exercise the planned adapter catalog claim independently of gateway extras."""
    with invocation_context(step_id="S-189.1"):
        catalog_status, catalog = _http("/platform/v1/adapters", token=token, opener=opener)
    journey.step("discover platform adapter method catalog", "gateway", lambda: (
        None if catalog_status == 200 and isinstance(catalog.data, dict) and isinstance(catalog.data.get("adapters"), dict)
        else f"documented platform adapter catalog returned HTTP {catalog_status} or no adapter catalog"
    ), cases=["S-189.1"])
