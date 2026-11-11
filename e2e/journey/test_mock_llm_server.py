import json
import sys
import unittest
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from mock_llm_server import Handler, commit_tool_completion, openai_stream_chunks, valid_openai_request


class CommitFixtureResponseTests(unittest.TestCase):
    def request(self, messages):
        return {
            "model": "journey-test-model",
            "messages": [{"role": "user", "content": messages}],
            "tools": [{"type": "function", "function": {"name": "generate_commit_plan"}}],
        }

    def plan(self, response):
        self.assertIsNotNone(response)
        call = response["choices"][0]["message"]["tool_calls"][0]
        self.assertEqual(call["function"]["name"], "generate_commit_plan")
        return json.loads(call["function"]["arguments"])

    def test_first_response_requests_diff_for_staged_file(self):
        request = self.request("Staged changes:\n- src/example.ts (IsNewFile: false)")
        request["messages"].insert(0, {"role": "system", "content": "Generate a plan."})

        self.assertTrue(valid_openai_request(request))
        plan = self.plan(commit_tool_completion(request))

        self.assertTrue(plan["needsMoreContext"])
        self.assertEqual(plan["requestedFiles"], ["src/example.ts"])
        self.assertEqual(plan["commits"][0]["message"], "verify deterministic commit fixture response")

    def test_followup_response_returns_deterministic_conventional_commit(self):
        request = self.request("Diff content for requested files:\nsrc/example.ts\n+export const value = 1")

        plan = self.plan(commit_tool_completion(request))

        self.assertFalse(plan["needsMoreContext"])
        self.assertEqual(plan["requestedFiles"], [])
        self.assertEqual(plan["commits"][0]["type"], "test")
        self.assertEqual(plan["commits"][0]["scope"], "journey")
        self.assertEqual(plan["commits"][0]["message"], "verify deterministic commit fixture response")
        self.assertEqual(plan["commits"][0]["files"], ["journey-fixture.ts"])


class OpenAIStreamFixtureTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1/chat/completions"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, model="journey-mock-model", stream=True):
        return urllib.request.Request(
            self.url,
            data=json.dumps({"model": model, "messages": [{"role": "user", "content": "stream fixture"}], "stream": stream}).encode(),
            headers={"Authorization": "Bearer journey-fake-openai-key", "Content-Type": "application/json"},
            method="POST",
        )

    def test_stream_response_contains_openai_chunks_and_done(self):
        chunks = list(openai_stream_chunks({
            "model": "journey-mock-model",
            "messages": [{"role": "user", "content": "stream fixture"}],
        }))
        body = "".join(chunks)
        self.assertGreaterEqual(body.count("data: {"), 2)
        self.assertIn('"object": "chat.completion.chunk"', body)
        self.assertIn('"content": "OPENAI_MOCK_RESPONSE"', body)
        self.assertTrue(body.endswith("data: [DONE]\n\n"))

        with urllib.request.urlopen(self.request()) as response:
            self.assertEqual(response.headers.get_content_type(), "text/event-stream")
            self.assertEqual(response.read().decode(), body)

    def test_failure_model_returns_deterministic_openai_401(self):
        try:
            urllib.request.urlopen(self.request(model="journey-provider-401"))
        except urllib.error.HTTPError as error:
            self.assertEqual(error.code, 401)
            body = json.loads(error.read())
            error.close()
        else:
            self.fail("failure model returned a successful response")
        self.assertEqual(body["error"]["type"], "authentication_error")
        self.assertEqual(body["error"]["code"], "invalid_api_key")

    def test_failure_modes_apply_to_openai_and_vibeproxy_protocols(self):
        base = self.url.split("/v1/", 1)[0]
        protocols = [
            ("/v1/chat/completions", {"Authorization": "Bearer journey-fake-openai-key"}),
            ("/v1/messages", {"x-api-key": "journey-fake-vibeproxy-key"}),
        ]
        for path, headers in protocols:
            for model in ("journey-provider-401", "journey-provider-stream-error"):
                request = urllib.request.Request(
                    base + path,
                    data=json.dumps({
                        "model": model,
                        "messages": [{"role": "user", "content": "stream fixture"}],
                        "max_tokens": 100,
                        "stream": True,
                    }).encode(),
                    headers={**headers, "Content-Type": "application/json"},
                    method="POST",
                )
                if model == "journey-provider-401":
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        urllib.request.urlopen(request)
                    self.assertEqual(caught.exception.code, 401)
                    response_body = json.loads(caught.exception.read())
                    caught.exception.close()
                    if path == "/v1/chat/completions":
                        self.assertEqual(response_body["error"]["code"], "invalid_api_key")
                    else:
                        self.assertEqual(response_body["type"], "error")
                        self.assertEqual(response_body["error"]["type"], "authentication_error")
                else:
                    with urllib.request.urlopen(request) as response:
                        body = response.read().decode()
                    self.assertEqual(response.headers.get_content_type(), "text/event-stream")
                    if path == "/v1/chat/completions":
                        self.assertIn('"content": "OPENAI_MOCK_RESPONSE"', body)
                        self.assertIn("data: {malformed provider stream frame\n\n", body)
                        self.assertLess(body.index('"content": "OPENAI_MOCK_RESPONSE"'),
                                        body.index("data: {malformed provider stream frame"))
                    else:
                        frames = [frame for frame in body.split("\n\n") if frame]
                        delta = next(frame for frame in frames if frame.startswith("event: content_block_delta"))
                        terminal_error = next(frame for frame in frames if frame.startswith("event: error"))
                        delta_payload = json.loads(next(line[6:] for line in delta.splitlines() if line.startswith("data: ")))
                        error_payload = json.loads(next(line[6:] for line in terminal_error.splitlines() if line.startswith("data: ")))
                        self.assertEqual(delta_payload["delta"]["text"], "VIBEPROXY_MOCK_RESPONSE")
                        self.assertEqual(error_payload["error"]["type"], "api_error")
                        self.assertLess(frames.index(delta), frames.index(terminal_error))
                    self.assertNotIn("[DONE]", body)

    def test_stream_failure_model_emits_a_chunk_then_a_malformed_provider_frame(self):
        request = urllib.request.Request(
            self.url,
            data=json.dumps({"model": "journey-provider-stream-error", "messages": [
                {"role": "user", "content": "stream fixture"},
            ], "stream": True}).encode(),
            headers={"Authorization": "Bearer journey-fake-openai-key", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            body = response.read().decode()

        self.assertIn('"content": "OPENAI_MOCK_RESPONSE"', body)
        self.assertIn("data: {malformed provider stream frame\n\n", body)
        self.assertNotIn("[DONE]", body)


if __name__ == "__main__":
    unittest.main()
