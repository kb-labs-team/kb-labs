/**
 * @module @kb-labs/adapters-kblabs-gateway/llm
 *
 * KB Labs Gateway LLM adapter.
 *
 * Implements ILLM against the KB Labs Gateway OpenAI-compatible endpoint:
 *   POST <gatewayURL>/llm/v1/chat/completions
 *
 * Authentication: machine identity (clientId + clientSecret) obtained via
 * kb-create --demo. The adapter automatically refreshes the short-lived
 * JWT access token (~15 min) before each request using the stored credentials.
 */

import OpenAI from "openai";
import type {
  ILLM,
  LLMOptions,
  LLMResponse,
  LLMMessage,
  LLMToolCallOptions,
  LLMToolCallResponse,
  LLMTool,
  LLMToolCall,
  LLMProtocolCapabilities,
  LLMContentPart,
} from "@kb-labs/sdk/adapters";
import { LLMContentValidationError, validateLLMContent } from "@kb-labs/sdk/adapters";

// ── Config ───────────────────────────────────────────────────────────────────

export interface KBLabsGatewayLLMConfig {
  /** KB Labs Gateway base URL. Defaults to https://api.kblabs.ru */
  gatewayURL?: string;
  /**
   * Machine identity credentials for automatic JWT token refresh.
   * Populated by kb-create --demo. Replace with your own API key
   * by removing these fields and setting apiKey instead.
   */
  kbClientId?: string;
  kbClientSecret?: string;
  /**
   * Static access token. Used directly if kbClientId/kbClientSecret are absent.
   * Falls back to KB_LABS_API_KEY or OPENAI_API_KEY env vars.
   */
  apiKey?: string;
  /** Default model tier. Values: "small" | "medium" | "large". */
  defaultModel?: string;
  /** Default max output tokens. Overrides the API default (4096). */
  defaultMaxTokens?: number;
}

const DEFAULT_GATEWAY_URL = "https://api.kblabs.ru";
const DEFAULT_MAX_TOKENS = 16_384;

// ── Token refresh ─────────────────────────────────────────────────────────────

/** Decode JWT exp claim. Returns 0 on parse failure. */
function jwtExp(token: string): number {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const data = JSON.parse(json) as { exp?: number };
    return typeof data.exp === "number" ? data.exp : 0;
  } catch {
    return 0;
  }
}

/** Returns true if token is absent or expires within the next 60 seconds. */
function tokenExpired(token: string | undefined): boolean {
  if (!token) {return true;}
  return jwtExp(token) < Math.floor(Date.now() / 1000) + 60;
}

/** Exchange clientId/clientSecret for a fresh accessToken. */
async function refreshToken(
  gatewayURL: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const res = await fetch(`${gatewayURL}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!res.ok) {
    throw new Error(`KB Labs Gateway token refresh failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { accessToken: string };
  if (!data.accessToken) {
    throw new Error("KB Labs Gateway token refresh: empty accessToken in response");
  }
  return data.accessToken;
}

// ── Error normalization ─────────────────────────────────────────────────────

export class KBLabsGatewayError extends Error {
  readonly status?: number;
  readonly contentType?: string;
  readonly endpointHost: string;
  readonly correlationId?: string;

  constructor(message: string, details: {
    status?: number;
    contentType?: string;
    endpointHost: string;
    correlationId?: string;
  }) {
    super(message);
    this.name = "KBLabsGatewayError";
    this.status = details.status;
    this.contentType = details.contentType;
    this.endpointHost = details.endpointHost;
    this.correlationId = details.correlationId;
  }
}

function responseHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") {return undefined;}
  const source = headers as { get?: (key: string) => string | null } & Record<string, unknown>;
  if (typeof source.get === "function") {return source.get(name) ?? undefined;}
  const value = Object.entries(source).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return typeof value === "string" ? value : undefined;
}

function endpointHost(url: string): string {
  try { return new URL(url).host; } catch { return "unknown"; }
}

/** Normalize provider errors without leaking response bodies, prompts, or secrets. */
export function normalizeLLMError(err: unknown, requestURL = DEFAULT_GATEWAY_URL): never {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const contentType = responseHeader(err.headers, "content-type") ?? "unknown";
    const correlationId = responseHeader(err.headers, "x-correlation-id") ?? responseHeader(err.headers, "x-request-id");
    const host = endpointHost(requestURL);
    const providerMessage = err.error && typeof err.error === "object" && "message" in err.error
      ? String((err.error as { message?: unknown }).message)
      : undefined;
    const bodyNote = providerMessage ? `: ${providerMessage.slice(0, 240)}` :
      " — upstream returned a non-JSON response";
    const requestNote = correlationId ? `, request ${correlationId}` : "";
    throw new KBLabsGatewayError(
      `KB Labs Gateway request failed${status ? ` (HTTP ${status})` : ""} at ${host}${requestNote} [${contentType}]${bodyNote}`,
      { status, contentType, endpointHost: host, correlationId },
    );
  }
  if (err instanceof Error && (err.name === "AbortError" || /timeout|timed out/i.test(err.message))) {
    throw new KBLabsGatewayError(
      `KB Labs Gateway request timed out at ${endpointHost(requestURL)} — check gateway/provider availability`,
      { endpointHost: endpointHost(requestURL) },
    );
  }
  throw err;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class KBLabsGatewayLLM implements ILLM {
  private readonly gatewayURL: string;
  private readonly kbClientId?: string;
  private readonly kbClientSecret?: string;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;

  private accessToken?: string;
  private client: OpenAI;

  constructor(config: KBLabsGatewayLLMConfig = {}) {
    this.gatewayURL = config.gatewayURL ?? DEFAULT_GATEWAY_URL;
    this.kbClientId = config.kbClientId;
    this.kbClientSecret = config.kbClientSecret;
    this.defaultModel = config.defaultModel ?? "small";
    this.defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;

    const initialKey =
      config.apiKey ?? process.env.KB_LABS_API_KEY ?? process.env.OPENAI_API_KEY ?? "pending";

    this.client = new OpenAI({
      apiKey: initialKey,
      baseURL: `${this.gatewayURL}/llm/v1`,
    });
  }

  getProtocolCapabilities(): LLMProtocolCapabilities {
    return {
      cache: { supported: false },
      stream: { supported: false },
    };
  }

  private async ensureToken(): Promise<void> {
    if (!this.kbClientId || !this.kbClientSecret) {return;}
    if (!tokenExpired(this.accessToken)) {return;}

    this.accessToken = await refreshToken(
      this.gatewayURL,
      this.kbClientId,
      this.kbClientSecret,
    );
    this.client = new OpenAI({
      apiKey: this.accessToken,
      baseURL: `${this.gatewayURL}/llm/v1`,
    });
  }

  async complete(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    await this.ensureToken();
    const model = options?.model ?? this.defaultModel;

    const response = await this.client.chat.completions
      .create({
        model,
        max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
        messages: [{ role: "user", content: prompt }],
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      })
      .catch((err: unknown) => normalizeLLMError(err, this.gatewayURL));

    const content = response.choices[0]?.message?.content ?? "";
    return {
      content,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
    };
  }

  async *stream(prompt: string, options?: LLMOptions): AsyncIterable<string> {
    const response = await this.complete(prompt, options);
    yield response.content;
  }

  async chatWithTools(
    messages: LLMMessage[],
    options: LLMToolCallOptions,
  ): Promise<LLMToolCallResponse> {
    await this.ensureToken();
    const model = options?.model ?? this.defaultModel;

    const openaiMessages = messages.map((m) => this.toOpenAIMessage({
      ...m,
      content: validateLLMContent(m.role, m.content).content,
    }));

    const tools: OpenAI.Chat.ChatCompletionTool[] = options.tools.map((t: LLMTool) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));

    // Map toolChoice to OpenAI format.
    let tool_choice: OpenAI.Chat.ChatCompletionToolChoiceOption | undefined;
    if (options.toolChoice && options.toolChoice !== "none" && options.toolChoice !== "auto") {
      if (typeof options.toolChoice === "object" && "function" in options.toolChoice) {
        tool_choice = { type: "function", function: { name: (options.toolChoice as { function: { name: string } }).function.name } };
      } else if (options.toolChoice === "required") {
        tool_choice = "required";
      }
    }

    const response = await this.client.chat.completions
      .create({
        model,
        max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
        messages: openaiMessages,
        tools: options.toolChoice !== "none" ? tools : undefined,
        tool_choice,
      })
      .catch((err: unknown) => normalizeLLMError(err, this.gatewayURL));

    const message = response.choices[0]?.message;
    if (!message) {
      return { content: "", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, model: "" };
    }

    const toolCalls: LLMToolCall[] = (message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
    }));

    return {
      content: message.content ?? "",
      toolCalls,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
    };
  }

  private toOpenAIMessage(m: LLMMessage): OpenAI.Chat.ChatCompletionMessageParam {
    if (m.role === "tool") {
      if (typeof m.content !== "string") {
        throw new LLMContentValidationError("tool messages must contain plain text");
      }
      return {
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: m.content,
      };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: typeof m.content === "string" ? m.content || null : null,
        tool_calls: m.toolCalls.map((tc: LLMToolCall) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        })),
      };
    }
    if (m.role === "user") {
      return {
        role: "user",
        content: typeof m.content === "string"
          ? m.content
          : m.content.map((part) => this.toOpenAIContentPart(part)),
      };
    }
    return { role: m.role, content: typeof m.content === "string" ? m.content : "" };
  }

  private toOpenAIContentPart(part: LLMContentPart): OpenAI.ChatCompletionContentPart {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return {
      type: "image_url",
      image_url: { url: `data:${part.mediaType};base64,${part.data}` },
    };
  }
}

export function createAdapter(config?: KBLabsGatewayLLMConfig): KBLabsGatewayLLM {
  return new KBLabsGatewayLLM(config);
}

export default createAdapter;
