import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import OpenAI from "openai";
import { createAdapter, KBLabsGatewayError, normalizeLLMError } from "./llm.js";

/**
 * Regression coverage for the gateway-502-shows-raw-HTML bug: `kb review run`
 * printed the raw HTML error page straight to the terminal, and `kb commit
 * commit` dumped the same raw HTML (plus a full stack trace) to stderr
 * before falling back to heuristics. Root cause: the `openai` SDK sets
 * `APIError.message` to the raw response body verbatim whenever that body
 * isn't valid JSON (openai/src/core.ts: `errMessage = errJSON ? undefined :
 * errText`) — which is exactly what an HTML 502 page from an intermediate
 * proxy looks like. `normalizeLLMError` intercepts that case before it
 * reaches either plugin's error-printing code.
 */
describe("normalizeLLMError", () => {
  it("replaces a raw-HTML 502 body with a clean, short message", () => {
    const htmlBody = "<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>";
    // Mirrors what openai's fetch handler does for a non-JSON error body:
    // APIError.generate(status, errorResponse=undefined, message=rawText, headers).
    const apiError = OpenAI.APIError.generate(502, undefined, htmlBody, new Headers());

    expect(() => normalizeLLMError(apiError)).toThrowError(/HTTP 502/);
    try {
      normalizeLLMError(apiError);
    } catch (err) {
      expect((err as Error).message).not.toContain("<html>");
      expect((err as Error).message).not.toContain("<!DOCTYPE");
      expect((err as Error).message).not.toContain("nginx");
    }
  });

  it("preserves structured provider context for a well-formed JSON API error", () => {
    const jsonError = { error: { message: "Invalid API key", type: "invalid_request_error" } };
    const apiError = OpenAI.APIError.generate(401, jsonError, "Invalid API key", new Headers({
      "content-type": "application/json",
      "x-request-id": "req-123",
    }));

    try {
      normalizeLLMError(apiError);
    } catch (err) {
      expect(err).toBeInstanceOf(KBLabsGatewayError);
      expect((err as Error).message).toContain("HTTP 401");
      expect((err as Error).message).toContain("Invalid API key");
      expect((err as Error).message).toContain("req-123");
      expect((err as KBLabsGatewayError).contentType).toBe("application/json");
    }
  });

  it("turns timeout errors into actionable diagnostics without a body dump", () => {
    expect(() => normalizeLLMError(Object.assign(new Error("request timed out"), { name: "AbortError" })))
      .toThrow(/timed out/);
  });

  it("rethrows non-APIError errors unchanged", () => {
    const plain = new Error("network unreachable");
    expect(() => normalizeLLMError(plain)).toThrow(plain);
  });
});

/**
 * Integration coverage: the unit tests above construct an `APIError`
 * directly, which proves `normalizeLLMError`'s own logic but not that it's
 * actually wired into the request path the way `kb review run` / `kb commit
 * commit` exercise it. This spins up a real HTTP server that responds like
 * an intermediate proxy returning a 502 HTML page (the actual failure mode
 * reported in QA — gateway/LLM provider down), and drives `complete()` /
 * `chatWithTools()` through the real `openai` client + fetch stack against
 * it, so a future change to either the adapter's request wiring or the
 * `.catch(normalizeLLMError)` call sites would be caught here even if
 * `normalizeLLMError` itself still works in isolation.
 */
describe("KBLabsGatewayLLM against a real HTTP 502", () => {
  let server: Server;
  let baseURL: string;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test HTTP server");
    }
    baseURL = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("complete() surfaces a clean error instead of the raw HTML body", async () => {
    const adapter = createAdapter({ gatewayURL: baseURL, apiKey: "test-key" });

    await expect(adapter.complete("hello")).rejects.toThrow(/HTTP 502/);
    await adapter.complete("hello").catch((err: Error) => {
      expect(err.message).not.toContain("<html>");
      expect(err.message).not.toContain("nginx");
    });
  });

  it("chatWithTools() surfaces a clean error instead of the raw HTML body", async () => {
    const adapter = createAdapter({ gatewayURL: baseURL, apiKey: "test-key" });

    await expect(
      adapter.chatWithTools([{ role: "user", content: "hi" }], { tools: [] }),
    ).rejects.toThrow(/HTTP 502/);
  });
});
