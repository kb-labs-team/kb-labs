"""Deterministic OpenAI/VibeProxy-compatible responses for installed journeys."""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import re
import select
import socket
import time


def valid_openai_request(request: dict) -> bool:
    messages = request.get("messages")
    return (
        isinstance(messages, list)
        and bool(messages)
        and all(
            isinstance(message, dict)
            and message.get("role") in {"system", "user", "assistant"}
            and isinstance(message.get("content"), (str, list))
            for message in messages
        )
        and isinstance(request.get("model"), str)
        and bool(request["model"])
    )


def openai_stream_chunks(request: dict, *, fail_after_chunk: bool = False):
    """Yield OpenAI chat-completion SSE chunks, including the terminal marker."""
    model = request.get("model", "journey-mock-model")
    completion_id = "journey-mock-stream"
    common = {"id": completion_id, "object": "chat.completion.chunk", "created": 1, "model": model}
    first = {**common, "choices": [{"index": 0, "delta": {"content": "OPENAI_MOCK_RESPONSE"}, "finish_reason": None}]}
    yield f"data: {json.dumps(first)}\n\n"
    if fail_after_chunk:
        yield "data: {malformed provider stream frame\n\n"
        return
    final = {**common, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
    yield f"data: {json.dumps(final)}\n\n"
    yield "data: [DONE]\n\n"


def vibeproxy_stream_chunks(request: dict, *, fail_after_chunk: bool = False):
    """Yield VibeProxy Messages SSE events, optionally ending with a provider error."""
    model = request.get("model", "journey-mock-model")
    message = {
        "id": "journey-mock-stream", "type": "message", "role": "assistant",
        "model": model, "content": [], "stop_reason": None, "stop_sequence": None,
        "usage": {"input_tokens": 1, "output_tokens": 0},
    }
    yield f"event: message_start\ndata: {json.dumps({'type': 'message_start', 'message': message})}\n\n"
    yield "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"
    yield "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"VIBEPROXY_MOCK_RESPONSE\"}}\n\n"
    if fail_after_chunk:
        error = {"type": "error", "error": {
            "type": "api_error", "message": "The mock provider is temporarily unavailable.",
        }}
        yield f"event: error\ndata: {json.dumps(error)}\n\n"
        return
    yield "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n"
    yield "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":1}}\n\n"
    yield "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"


def commit_tool_completion(request: dict) -> dict | None:
    """Build the deterministic Commit tool response used by installed journeys."""
    messages = request.get("messages")
    tools = request.get("tools")
    if not isinstance(messages, list) or not isinstance(tools, list) or not tools:
        return None
    function = tools[0].get("function", {}) if isinstance(tools[0], dict) else {}
    name = function.get("name") if isinstance(function, dict) else None
    if not isinstance(name, str) or not name:
        return None
    messages_text = "\n".join(
        message.get("content", "") if isinstance(message.get("content"), str) else ""
        for message in messages if isinstance(message, dict)
    )
    changed_files = re.findall(r"^-\s+(.+?)\s+\([^\n]*IsNewFile:", messages_text, re.MULTILINE)
    changed_files = list(dict.fromkeys(changed_files)) or ["journey-fixture.ts"]
    diff_phase = "Diff content for requested files:" in messages_text
    plan = {
        "needsMoreContext": not diff_phase,
        "requestedFiles": changed_files[:1] if not diff_phase else [],
        "commits": [{
            "id": "c1", "type": "test", "scope": "journey",
            "message": "verify deterministic commit fixture response",
            "body": "Generated from the installed journey fixture.",
            "files": changed_files,
            "releaseHint": "none", "breaking": False,
            "reasoning": {"newBehavior": False, "fixesBug": False,
                "internalOnly": True, "explanation": "Deterministic journey fixture output.",
                "confidence": 0.95},
        }],
    }
    return {
        "id": "journey-mock-tool-completion", "object": "chat.completion",
        "created": 1, "model": request.get("model", "journey-mock-model"),
        "choices": [{"index": 0, "message": {"role": "assistant", "content": None,
            "tool_calls": [{"id": "journey-tool-call", "type": "function",
                "function": {"name": name, "arguments": json.dumps(plan)}}]},
            "finish_reason": "tool_calls"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


FAILURE_MODES = {
    "journey-provider-401": "authentication",
    "journey-provider-stream-error": "provider-unavailable",
}


def failure_mode(request: dict, messages_text: str) -> str | None:
    for trigger, mode in FAILURE_MODES.items():
        if request.get("model") == trigger or trigger in messages_text:
            return mode
    return None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/healthz":
            self.send_response(200)
            self.end_headers()
            return
        self.send_error(404)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length) or b"{}")
        messages = request.get("messages")
        if not valid_openai_request(request):
            self.send_error(400, "expected an OpenAI-compatible messages request")
            return
        is_vibeproxy = self.path == "/v1/messages"
        if is_vibeproxy and (not isinstance(request.get("max_tokens"), int)
                             or self.headers.get("x-api-key") != "journey-fake-vibeproxy-key"):
            self.send_error(400, "expected a VibeProxy messages request with the fixture key")
            return
        if not is_vibeproxy and self.headers.get("Authorization") != "Bearer journey-fake-openai-key":
            self.send_error(400, "expected the OpenAI-compatible fixture key")
            return
        if not is_vibeproxy and self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        messages_text = "\n".join(
            message.get("content", "") if isinstance(message.get("content"), str) else ""
            for message in messages if isinstance(message, dict)
        )
        mode = failure_mode(request, messages_text)
        if mode == "authentication":
            error = {"message": "The mock provider rejected the journey API key."}
            if is_vibeproxy:
                error.update({"type": "authentication_error", "request_id": "journey-mock-auth"})
                response = {"type": "error", "error": error}
            else:
                error.update({"type": "authentication_error", "param": None, "code": "invalid_api_key"})
                response = {"error": error}
            body = json.dumps(response).encode()
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if mode == "provider-unavailable":
            if request.get("stream") is True:
                stream = vibeproxy_stream_chunks if is_vibeproxy else openai_stream_chunks
                body = "".join(stream(request, fail_after_chunk=True)).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            body = json.dumps({"type": "error", "error": {
                "type": "api_error", "message": "The mock provider is temporarily unavailable.",
            }}).encode()
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if request.get("stream") is True:
            stream = vibeproxy_stream_chunks if is_vibeproxy else openai_stream_chunks
            body = "".join(stream(request)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        result = None if is_vibeproxy else commit_tool_completion(request)
        if result is not None:
            if "s030-cancel" in messages_text:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    readable, _, _ = select.select([self.connection], [], [], 0.25)
                    if readable:
                        try:
                            if not self.connection.recv(1, socket.MSG_PEEK):
                                return
                        except OSError:
                            return
            body = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        content = "VIBEPROXY_MOCK_RESPONSE" if is_vibeproxy else "OPENAI_MOCK_RESPONSE"
        result = {
            "id": "journey-mock-completion",
            "object": "chat.completion",
            "created": 1,
            "model": request.get("model", "journey-mock-model"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        if is_vibeproxy:
            result = {
                "id": "journey-mock-message", "type": "message", "role": "assistant",
                "model": request.get("model", "journey-mock-model"), "stop_reason": "end_turn",
                "content": [{"type": "text", "text": content}],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            }
        body = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8317), Handler).serve_forever()
