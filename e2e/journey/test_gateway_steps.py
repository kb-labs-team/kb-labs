import os
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from gateway_steps import GatewayHttpResponse, _http, run_adapter_catalog_step, run_gateway_steps, run_llm_provider_steps
from service_steps import Journey
from test_install_layout import create_test_install_container


class FakeResponse:
    status = 404
    headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self):
        return b'{"ok":false,"error":{"code":"KB_RUNTIME_UNEXPECTED","message":"fixture route unavailable"}}'


class CatalogResponse(FakeResponse):
    status = 200

    def read(self):
        return b'{"ok":true,"data":{"adapters":{"llm":["complete"]}}}'


class JsonResponse:
    headers = {}

    def __init__(self, status, body):
        self.status = status
        self.body = body if isinstance(body, bytes) else body.encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self):
        return self.body


class GatewayStepTests(unittest.TestCase):
    def setUp(self):
        self.platform_temp = tempfile.TemporaryDirectory(prefix="journey-gateway-container-")
        self.platform = Path(self.platform_temp.name) / "platform"
        create_test_install_container(self.platform)
        self.env_patcher = patch.dict(os.environ, {"KB_JOURNEY_PLATFORM_ROOT": str(self.platform)}, clear=False)
        self.env_patcher.start()
        self.addCleanup(self.env_patcher.stop)
        self.addCleanup(self.platform_temp.cleanup)

    def test_http_response_is_normalized_once_with_success_metadata_and_error_payload(self):
        fixture_root = Path(__file__).resolve().parents[2] / "core" / "platform" / "contracts" / "ux-result" / "fixtures" / "valid"
        success_fixture = json.loads((fixture_root / "success.json").read_text(encoding="utf-8"))
        failure_fixture = json.loads((fixture_root / "failure.json").read_text(encoding="utf-8"))
        stream_fixture = "event: error\ndata: " + json.dumps(failure_fixture) + "\n\n"
        responses = iter([
            JsonResponse(200, json.dumps(success_fixture)),
            JsonResponse(500, json.dumps(failure_fixture)),
            JsonResponse(200, stream_fixture),
        ])

        def opener(_request, **_kwargs):
            return next(responses)

        with patch.dict(os.environ, {"KB_JOURNEY_BASE_URL": "http://gateway.test"}, clear=False):
            success_status, success = _http("/success", token="", opener=opener)
            error_status, failure = _http("/missing", token="", opener=opener)
            stream_status, stream_failure = _http("/platform/v1/llm/stream", token="", opener=opener)

        self.assertEqual(success_status, 200)
        self.assertEqual(success.data, success_fixture["data"])
        self.assertEqual(success.meta, success_fixture["meta"])
        self.assertIsNone(success.error)
        self.assertEqual(error_status, 500)
        self.assertIsNone(failure.data)
        self.assertEqual(failure.error, failure_fixture["error"])
        self.assertEqual(stream_status, 200)
        self.assertEqual(stream_failure.stream_error, failure_fixture["error"])

    def test_llm_provider_fixture_restores_platform_config_after_success(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KB_JOURNEY_INVOCATIONS": directory,
            "KB_JOURNEY_PROJECT_ROOT": "/fixture/project-a",
            "KB_JOURNEY_PROJECT_B_ROOT": "/fixture/project-b",
            "KB_JOURNEY_PROJECT_ID": "project-a",
            "KB_JOURNEY_PROJECT_B_ID": "project-b",
            "KB_JOURNEY_LLM_MOCK_BASE_URL": "http://mock-llm:8317",
            "OPENAI_API_KEY": "fake-openai-key",
        }, clear=False):
            config_path = self.platform / "state" / "kb.config.jsonc"
            config_path.parent.mkdir(parents=True, exist_ok=True)
            original = b'{"platform":{"adapters":{"llm":"@kb-labs/adapters-openai"}}}\n'
            config_path.write_bytes(original)
            calls = []

            def mutating_cli(command, **_kwargs):
                calls.append(command)
                if command[:3] == ["kb", "config", "set"]:
                    config = json.loads(config_path.read_text())
                    path = command[5].split(".")
                    value = command[6]
                    target = config
                    for key in path[:-1]:
                        target = target.setdefault(key, {})
                    target[path[-1]] = value
                    config_path.write_text(json.dumps(config) + "\n")
                elif command[:3] == ["kb", "marketplace", "install"]:
                    return subprocess.CompletedProcess(command, 0, '{"ok":true,"data":{}}', "")
                elif command[:2] == ["kb-create", "restart"]:
                    return subprocess.CompletedProcess(command, 0, '{"ok":true,"data":{}}', "")
                elif command[1:3] == ["config", "get"]:
                    return subprocess.CompletedProcess(command, 0, '{"ok":true,"data":{"value":"${OPENAI_API_KEY}"}}', "")
                elif command[1:4] == ["journey", "llm", "complete"]:
                    marker = "VIBEPROXY_MOCK_RESPONSE" if "provider-vibeproxy" in " ".join(command) else "OPENAI_MOCK_RESPONSE"
                    stop_reason = "end_turn" if marker == "VIBEPROXY_MOCK_RESPONSE" else None
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {"result": {
                        "content": marker, "model": "journey-mock-model", "stopReason": stop_reason,
                    }}}), "")
                return subprocess.CompletedProcess(command, 0, '{"ok":true,"data":{}}', "")

            journey = Journey("local", "provider-config-restore")
            run_llm_provider_steps(journey, project_id="project-a", project_root="/fixture/project-a",
                                   project_b_id="project-b", project_b_root="/fixture/project-b",
                                   runner=mutating_cli)

            self.assertEqual(config_path.read_bytes(), original)
            self.assertTrue(any(call[:2] == ["kb-create", "restart"] for call in calls))
            cleanup = next(step for step in journey.steps
                           if step.name == "restore platform LLM journey fixture state")
            self.assertEqual(cleanup.status, "PASS", cleanup.message)

    def test_stream_failure_claim_requires_typed_error_and_healthy_gateway(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KB_JOURNEY_INVOCATIONS": directory,
            "KB_JOURNEY_BASE_URL": "http://gateway.test",
            "KB_JOURNEY_PROJECT_ROOT": directory,
            "KB_JOURNEY_PROJECT_ID": "project-a",
            "KB_JOURNEY_PROJECT_B_ID": "project-b",
            "KB_JOURNEY_PLATFORM_ROOT": str(self.platform),
            "OPENAI_API_KEY": "fake-secret",
        }, clear=False):
            def failed(command, **_kwargs):
                return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": {"code": "KB_RUNTIME_UNEXPECTED", "message": "fixture failed"}}), "")

            stream_arguments = []
            health_checks = []

            def opener(request, **_kwargs):
                path = request.full_url.split("gateway.test", 1)[-1]
                if path == "/platform/v1/llm/stream":
                    stream_arguments.append(json.loads(request.data).get("args"))
                if path == "/health":
                    health_checks.append(path)
                args = json.loads(request.data).get("args") if path == "/platform/v1/llm/stream" else None
                if path == "/platform/v1/llm/stream" and args == ["journey-provider-401"]:
                    return JsonResponse(502, json.dumps({"ok": False, "error": {
                        "code": "KB_CONFIG_LLM_KEY_INVALID", "message": "bad key",
                        "hint": "kb config set --scope platform platform.adapterOptions.llm.apiKey '${OPENAI_API_KEY}'",
                        "correlationId": "req-test",
                    }}))
                if path == "/platform/v1/llm/stream" and args == ["journey-provider-stream-error"]:
                    body = 'data: partial\n\nevent: error\ndata: ' + json.dumps({"ok": False, "error": {
                        "code": "KB_CONFIG_LLM_PROVIDER_UNAVAILABLE", "message": "provider failed",
                        "hint": "Check provider availability.", "correlationId": "req-test",
                    }}) + '\n\n'
                    return JsonResponse(200, body)
                if path == "/platform/v1/llm/stream" and args == []:
                    return JsonResponse(400, json.dumps({"ok": False, "error": {
                        "code": "KB_RUNTIME_INPUT_INVALID", "message": "prompt required",
                        "hint": "Correct input", "correlationId": "req-test",
                    }}))
                if path == "/health":
                    return JsonResponse(200, '{"ok":true,"data":{}}')
                if path == "/platform/v1/unknown/resource":
                    return JsonResponse(404, json.dumps({"ok": False, "error": {
                        "code": "KB_RUNTIME_RESOURCE_NOT_FOUND", "message": "Route not found",
                    }}))
                if path == "/platform/v1/llm/stream":
                    return JsonResponse(200, "data: [DONE]\n\n")
                return JsonResponse(200, '{"ok":true,"data":{}}')

            journey = Journey("local", "stream-error-healthy")
            run_gateway_steps(journey, token="fixture-token", project_id="project-a",
                              project_root="/fixture/project-a", project_b_id="project-b",
                              project_b_root="/fixture/project-b", runner=failed, opener=opener)

        statuses = {item["claimId"]: item["status"] for item in journey.result().case_run["claims"]}
        self.assertEqual(statuses["S-189.5"], "PASS")
        self.assertEqual(statuses["S-189.7"], "PASS")
        self.assertIn(["case stream"], stream_arguments)
        self.assertEqual(health_checks, ["/health", "/health"])

    def test_provider_steps_require_deterministic_content_in_the_json_result(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KB_JOURNEY_INVOCATIONS": directory,
            "KB_JOURNEY_PROJECT_ROOT": "/fixture/project-a",
            "KB_JOURNEY_PROJECT_B_ROOT": "/fixture/project-b",
            "KB_JOURNEY_PROJECT_ID": "project-a",
            "KB_JOURNEY_PROJECT_B_ID": "project-b",
            "KB_JOURNEY_LLM_MOCK_BASE_URL": "http://mock-llm:8317",
            "KB_JOURNEY_PLATFORM_ROOT": str(self.platform),
            "OPENAI_API_KEY": "fake-openai-key",
        }, clear=False):
            calls = []
            def successful(command, **_kwargs):
                calls.append(command)
                if command[:3] == ["kb", "marketplace", "install"]:
                    output = '{"ok":true,"data":{"package":"@kb-labs/adapters-vibeproxy"}}'
                elif command[1:3] == ["config", "get"]:
                    output = '{"ok":true,"data":{"value":"${OPENAI_API_KEY}"}}'
                elif command[1:3] == ["config", "set"] and any("baseURL" in arg for arg in command):
                    platform_root = str(self.platform.resolve())
                    output = json.dumps({
                        "ok": True,
                        "data": {
                            "file": str((self.platform / "state/kb.config.jsonc").resolve()),
                            "nextCommand": f"kb-create restart --platform-root {json.dumps(platform_root)}",
                        },
                    })
                elif command[:2] == ["kb-create", "restart"]:
                    output = '{"ok":true,"data":{}}'
                elif command[1:4] == ["journey", "llm", "complete"]:
                    marker = "VIBEPROXY_MOCK_RESPONSE" if any("vibeproxy" in arg for arg in command) else "OPENAI_MOCK_RESPONSE"
                    stop_reason = "end_turn" if marker == "VIBEPROXY_MOCK_RESPONSE" else None
                    output = json.dumps({"ok": True, "data": {"result": {
                        "content": marker, "model": "journey-mock-model", "stopReason": stop_reason,
                    }}})
                else:
                    output = '{"ok":true,"data":{}}'
                return subprocess.CompletedProcess(command, 0, output, "")

            journey = Journey("local", "provider-green")
            journey.step("registered project setup", "journey.setup", lambda: None)
            run_llm_provider_steps(journey, project_id="project-a", project_root="/fixture/project-a",
                                   project_b_id="project-b", project_b_root="/fixture/project-b",
                                   runner=successful)

        claims = {item["claimId"]: item["status"] for item in journey.result().case_run["claims"]}
        self.assertEqual(claims, {
            "S-017.1": "PASS", "S-017.2": "PASS", "S-017.3": "PASS", "S-017.4": "PASS",
            "S-017.5": "PASS",
            "S-018.1": "PASS", "S-018.2": "PASS", "S-018.3": "PASS",
        })
        install_index = next(i for i, call in enumerate(calls) if call[:3] == ["kb", "marketplace", "install"])
        bind_index = next(i for i, call in enumerate(calls) if "@kb-labs/adapters-vibeproxy" in call
                          and "platform.adapters.llm" in call)
        self.assertLess(install_index, bind_index)

    def test_failed_vibeproxy_install_blocks_s018_3_without_cascade(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KB_JOURNEY_INVOCATIONS": directory,
            "KB_JOURNEY_PROJECT_ROOT": "/fixture/project-a",
            "KB_JOURNEY_PROJECT_B_ROOT": "/fixture/project-b",
            "KB_JOURNEY_PROJECT_ID": "project-a",
            "KB_JOURNEY_PROJECT_B_ID": "project-b",
            "KB_JOURNEY_LLM_MOCK_BASE_URL": "http://mock-llm:8317",
            "OPENAI_API_KEY": "fake-openai-key",
        }, clear=False):
            calls = []

            def install_fails(command, **_kwargs):
                calls.append(command)
                if command[:3] == ["kb", "marketplace", "install"]:
                    return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": {
                        "code": "KB_MARKETPLACE_PACKAGE_NOT_FOUND", "message": "VibeProxy package unavailable",
                    }}), "")
                return subprocess.CompletedProcess(command, 0, '{"ok":true,"data":{}}', "")

            journey = Journey("local", "provider-install-fails")
            run_llm_provider_steps(journey, project_id="project-a", project_root="/fixture/project-a",
                                   project_b_id="project-b", project_b_root="/fixture/project-b",
                                   runner=install_fails)

        claims = {item["claimId"]: item for item in journey.result().case_run["claims"]}
        self.assertEqual(claims["S-018.3"]["status"], "FAIL")
        step = next(item for item in journey.result().steps
                    if item["name"] == "switch to VibeProxy messages protocol in both projects")
        self.assertIn("prerequisite not met: VibeProxy package unavailable", step["message"])
        self.assertFalse(any("@kb-labs/adapters-vibeproxy" in call
                             and call[:3] != ["kb", "marketplace", "install"] for call in calls))

    def test_provider_steps_reject_success_exit_with_wrong_provider_content(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KB_JOURNEY_INVOCATIONS": directory,
            "KB_JOURNEY_PROJECT_ROOT": "/fixture/project-a",
            "KB_JOURNEY_PROJECT_B_ROOT": "/fixture/project-b",
            "KB_JOURNEY_PROJECT_ID": "project-a",
            "KB_JOURNEY_PROJECT_B_ID": "project-b",
            "KB_JOURNEY_LLM_MOCK_BASE_URL": "http://mock-llm:8317",
            "OPENAI_API_KEY": "fake-openai-key",
        }, clear=False):
            def wrong_provider(command, **_kwargs):
                output = ('{"ok":true,"value":"${OPENAI_API_KEY}"}' if command[1:3] == ["config", "get"]
                          else '{"ok":true,"data":{"result":{"content":"cached response from another provider"}}}'
                          if command[1:4] == ["journey", "llm", "complete"] else '{"ok":true,"data":{}}')
                return subprocess.CompletedProcess(command, 0, output, "")

            journey = Journey("local", "provider-red")
            run_llm_provider_steps(journey, project_id="project-a", project_root="/fixture/project-a",
                                   project_b_id="project-b", project_b_root="/fixture/project-b",
                                   runner=wrong_provider)

        claims = {item["claimId"]: item["status"] for item in journey.result().case_run["claims"]}
        self.assertEqual(claims["S-017.3"], "FAIL")
        self.assertEqual(claims["S-018.2"], "FAIL")
        self.assertEqual(claims["S-018.3"], "FAIL")

    def test_vibeproxy_claim_requires_messages_api_stop_reason_in_json_result(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KB_JOURNEY_INVOCATIONS": directory,
            "KB_JOURNEY_PROJECT_ROOT": "/fixture/project-a",
            "KB_JOURNEY_PROJECT_B_ROOT": "/fixture/project-b",
            "KB_JOURNEY_PROJECT_ID": "project-a",
            "KB_JOURNEY_PROJECT_B_ID": "project-b",
            "KB_JOURNEY_LLM_MOCK_BASE_URL": "http://mock-llm:8317",
            "OPENAI_API_KEY": "fake-openai-key",
        }, clear=False):
            def missing_message_shape(command, **_kwargs):
                if command[1:3] == ["config", "get"]:
                    output = '{"ok":true,"data":{"value":"${OPENAI_API_KEY}"}}'
                elif command[1:4] == ["journey", "llm", "complete"]:
                    marker = "VIBEPROXY_MOCK_RESPONSE" if any("vibeproxy" in arg for arg in command) else "OPENAI_MOCK_RESPONSE"
                    output = json.dumps({"ok": True, "data": {"result": {
                        "content": marker, "model": "journey-mock-model", "stopReason": None,
                    }}})
                else:
                    output = '{"ok":true,"data":{}}'
                return subprocess.CompletedProcess(command, 0, output, "")

            journey = Journey("local", "provider-wrong-shape")
            run_llm_provider_steps(journey, project_id="project-a", project_root="/fixture/project-a",
                                   project_b_id="project-b", project_b_root="/fixture/project-b",
                                   runner=missing_message_shape)

        claims = {item["claimId"]: item["status"] for item in journey.result().case_run["claims"]}
        self.assertEqual(claims["S-018.3"], "FAIL")

    def test_fake_cli_and_http_failures_make_every_gateway_claim_red(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KB_JOURNEY_INVOCATIONS": directory,
            "KB_JOURNEY_BASE_URL": "http://gateway.test",
            "KB_JOURNEY_PROJECT_ROOT": directory,
            "KB_JOURNEY_PROJECT_ID": "project-a",
            "KB_JOURNEY_PROJECT_B_ID": "project-b",
            "OPENAI_API_KEY": "fake-secret",
        }, clear=False):
            def failed(command, **_kwargs):
                return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": {"code": "KB_RUNTIME_UNEXPECTED", "message": "fixture failed"}}), "")

            journey = Journey("local", "fake-gateway")
            journey.step("registered project setup", "journey.setup", lambda: None)
            run_gateway_steps(journey, token="fixture-token", project_id="project-a",
                              project_root="/fixture/project-a", project_b_id="project-b",
                              project_b_root="/fixture/project-b", runner=failed,
                              opener=lambda *_args, **_kwargs: FakeResponse())

        statuses = {item["claimId"]: item["status"] for item in journey.result().case_run["claims"]}
        self.assertEqual(statuses, {
            "S-017.1": "FAIL", "S-017.2": "FAIL", "S-017.3": "FAIL", "S-017.4": "FAIL",
            "S-018.1": "FAIL", "S-018.2": "FAIL", "S-018.3": "FAIL",
            "S-189.2": "FAIL", "S-189.3": "FAIL", "S-189.4": "FAIL", "S-189.5": "FAIL", "S-189.6": "FAIL", "S-189.7": "FAIL",
            "S-017.5": "FAIL",
            "S-190.1": "FAIL", "S-190.2": "FAIL",
        })

    def test_planned_adapter_catalog_is_an_independent_selected_claim(self):
        calls = []
        def opener(request, **_kwargs):
            calls.append(request.full_url)
            return CatalogResponse()

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KB_JOURNEY_INVOCATIONS": directory,
            "KB_JOURNEY_SELECTED_STEPS": "S-189.1",
        }, clear=False):
            journey = Journey("local", "planned-adapter-catalog")
            run_adapter_catalog_step(journey, token="fixture-token", opener=opener)

        self.assertEqual(calls, ["http://127.0.0.1:4000/platform/v1/adapters"])
        self.assertEqual({item["claimId"]: item["status"] for item in journey.result().case_run["claims"]},
                         {"S-189.1": "PASS"})

    def test_gateway_extras_do_not_claim_the_planned_catalog_route(self):
        paths = []
        def fake_http(path, **_kwargs):
            paths.append(path)
            if path == "/platform/v1/unknown/resource":
                return 404, GatewayHttpResponse(error={"code": "KB_RUNTIME_RESOURCE_NOT_FOUND"})
            if path == "/platform/v1/llm/stream":
                return 200, GatewayHttpResponse(stream="data: chunk\n\n[DONE]")
            if path == "/platform/v1/analytics/track":
                return 200, GatewayHttpResponse(data=None, meta={"durationMs": 1})
            if path == "/platform/v1/analytics/getEvents":
                return 200, GatewayHttpResponse(data={"events": [{"type": "case.gateway.call"}]})
            if path == "/telemetry/v1/ingest":
                return 200, GatewayHttpResponse(data={"accepted": 500, "rejected": 0})
            return 200, GatewayHttpResponse(data={"events": []})
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KB_JOURNEY_INVOCATIONS": directory,
            "KB_JOURNEY_PROJECT_ID": "prj_fixture",
        }, clear=False), patch("gateway_steps.run_llm_provider_steps"), \
                patch("gateway_steps._http", side_effect=fake_http):
            journey = Journey("local", "planned-adapter-catalog-not-in-extras")
            run_gateway_steps(journey, token="fixture-token", project_id="project-a",
                              project_root="/fixture/project-a", project_b_id="project-b",
                              project_b_root="/fixture/project-b")

        claims = {item["claimId"] for item in journey.result().case_run["claims"]}
        self.assertNotIn("S-189.1", claims)
        self.assertNotIn("/platform/v1/adapters", paths)

    def test_gateway_analytics_track_claim_requires_the_shared_void_success_fields(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KB_JOURNEY_INVOCATIONS": directory,
            "KB_JOURNEY_PROJECT_ID": "prj_fixture",
        }, clear=False), patch("gateway_steps._http", return_value=(200, GatewayHttpResponse(data=None, meta={"durationMs": 1}))), \
                patch("gateway_steps.run_llm_provider_steps"):
            journey = Journey("local", "analytics-track-missing-data")
            run_gateway_steps(journey, token="fixture-token", project_id="project-a",
                              project_root="/fixture/project-a", project_b_id="project-b",
                              project_b_root="/fixture/project-b")

        claims = {item["claimId"]: item["status"] for item in journey.result().case_run["claims"]}
        self.assertEqual(claims["S-189.2"], "FAIL")

    def test_gateway_analytics_track_claim_requires_the_recorded_event_too(self):
        def fake_http(path, **_kwargs):
            if path == "/platform/v1/analytics/track":
                return 200, GatewayHttpResponse(data=None, meta={"durationMs": 1})
            if path == "/platform/v1/analytics/getEvents":
                return 200, GatewayHttpResponse(data={"events": [{"type": "case.gateway.call"}]})
            return 200, GatewayHttpResponse(data={})

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KB_JOURNEY_INVOCATIONS": directory,
            "KB_JOURNEY_PROJECT_ID": "prj_fixture",
        }, clear=False), patch("gateway_steps._http", side_effect=fake_http), \
                patch("gateway_steps.run_llm_provider_steps"):
            journey = Journey("local", "analytics-track-recorded")
            run_gateway_steps(journey, token="fixture-token", project_id="project-a",
                              project_root="/fixture/project-a", project_b_id="project-b",
                              project_b_root="/fixture/project-b")

        claims = {item["claimId"]: item["status"] for item in journey.result().case_run["claims"]}
        self.assertEqual(claims["S-189.2"], "PASS")


if __name__ == "__main__":
    unittest.main()
