import { afterEach, describe, expect, it, vi } from "vitest";
import { VibeProxyLLM } from "../llm.js";

describe("VibeProxyLLM", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts an in-flight request when the caller signal is aborted", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const llm = new VibeProxyLLM({ timeout: 60_000 });
    const controller = new AbortController();
    const request = llm.complete("test", { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledOnce();
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("adds an actionable message and safe transport details to connection failures", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause })));

    const llm = new VibeProxyLLM({
      baseURL: "http://user:secret@localhost:8317/proxy",
      defaultModel: "test-model",
    });
    const request = llm.complete("test");
    await expect(request).rejects.toMatchObject({
      name: "VibeProxyRequestError",
      code: "LLM_UPSTREAM_UNAVAILABLE",
      transportCode: "ECONNREFUSED",
      provider: "vibeproxy",
      model: "test-model",
      endpointOrigin: "http://localhost:8317",
      message: expect.stringContaining("http://localhost:8317"),
    });
    const message = await request.catch((error: unknown) => error instanceof Error ? error.message : String(error));
    expect(message).not.toContain("secret");
  });

  it("surfaces rate limits with HTTP status and Retry-After instead of hiding them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "rate limited" } }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "3" } },
    )));

    const llm = new VibeProxyLLM();
    await expect(llm.complete("test")).rejects.toMatchObject({
      name: "VibeProxyRequestError",
      code: "LLM_UPSTREAM_RATE_LIMITED",
      httpStatus: 429,
      retryAfter: "3",
      message: expect.stringContaining("Wait before retrying."),
    });
  });

  it("distinguishes an adapter timeout from a caller cancellation", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const llm = new VibeProxyLLM({ timeout: 5 });
    await expect(llm.complete("test")).rejects.toMatchObject({
      code: "LLM_UPSTREAM_TIMEOUT",
      message: expect.stringContaining("timed out after 5ms"),
    });
  });

  it("translates validated image parts into the Messages API image format", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text: "A cat" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const llm = new VibeProxyLLM({ defaultModel: "test-model" });
    await llm.chatWithTools([{
      role: "user",
      content: [
        { type: "text", text: "Describe this" },
        { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
      ],
    }], { tools: [] });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(requestBody.messages[0]?.content).toEqual([
      { type: "text", text: "Describe this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ]);
  });

  it("rejects multimodal parts in unsupported message roles before sending", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const llm = new VibeProxyLLM();

    await expect(llm.chatWithTools([{
      role: "assistant",
      content: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }],
    }], { tools: [] })).rejects.toMatchObject({ code: "LLM_CONTENT_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
