/**
 * @module AI Gateway — OpenAI-compatible LLM endpoint.
 *
 * Exposes `POST /api/v1/llm/chat/completions` using OpenAI ChatCompletion format.
 * Model field is a tier abstraction (small/medium/large) — never a literal model name.
 * All calls go through the platform LLM chain: QueuedLLM → AnalyticsLLM → LLMRouter → adapter.
 */
import type { FastifyInstance } from 'fastify';
import { platform } from '@kb-labs/core-runtime';
import { getLLMContentText } from '@kb-labs/core-platform';
import type {
  ILLM,
  ILogger,
  LLMMessage,
  LLMToolCallOptions,
  LLMTool,
  ILLMRouter,
  LLMTier,
} from '@kb-labs/core-platform';
import {
  ChatCompletionRequestSchema,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
} from '@kb-labs/gateway-contracts';

// ── Tier resolution ───────────────────────────────────────────────────────

function isLLMRouter(llm: ILLM): llm is ILLM & ILLMRouter {
  return typeof (llm as any).resolveAdapter === 'function';
}

/**
 * Resolve tier to a concrete ILLM adapter via LLMRouter.
 * If no router (single-adapter setup), returns platform.llm directly.
 */
async function resolveLLMForTier(tier: LLMTier): Promise<ILLM | undefined> {
  const llm = platform.llm;
  if (!llm) {return undefined;}

  if (isLLMRouter(llm)) {
    const binding = await llm.resolveAdapter({ tier });
    return binding.adapter;
  }

  // Single adapter — ignore tier, return as-is
  return llm;
}

// ── Route registration ────────────────────────────────────────────────────

/**
 * Register AI Gateway routes on the given Fastify scope.
 * The scope is expected to have the auth middleware already applied.
 */
export function registerLLMGatewayRoutes(app: FastifyInstance, logger: ILogger): void {
  // hide: true — can stream SSE (text/event-stream), incompatible with OpenAPI response schema
  app.post('/api/v1/llm/chat/completions', { schema: { tags: ['LLM'], summary: 'OpenAI-compatible chat completions', hide: true } }, async (request, reply) => {
    const auth = request.authContext;
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const parsed = ChatCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: 'Bad Request',
          type: 'invalid_request_error',
          code: null,
          param: null,
        },
        issues: parsed.error.issues,
      });
    }

    const req = parsed.data;
    const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Resolve tier to LLM adapter
    const llm = await resolveLLMForTier(req.model);
    if (!llm) {
      return reply.code(503).send({
        error: {
          message: `LLM not available for tier "${req.model}"`,
          type: 'server_error',
          code: null,
          param: null,
        },
      });
    }

    logger.info('AI Gateway request', {
      requestId,
      tier: req.model,
      stream: req.stream,
      messageCount: req.messages.length,
      hasTools: !!req.tools?.length,
      tenantId: auth.namespaceId,
    });

    try {
      if (req.stream) {
        return await handleStreamingRequest(reply, llm, req, requestId, logger);
      }
      return await handleCompletionRequest(reply, llm, req, requestId);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error('AI Gateway error', error, { requestId, tier: req.model });
      return reply.code(500).send({
        error: {
          message: 'Internal server error',
          type: 'server_error',
          code: null,
          param: null,
        },
      });
    }
  });
}

// ── Non-streaming handler ─────────────────────────────────────────────────

async function handleCompletionRequest(
  reply: any,
  llm: ILLM,
  req: ChatCompletionRequest,
  requestId: string,
) {
  const messages = toILLMMessages(req);
  const startTime = Date.now();
  const hasTools = req.tools && req.tools.length > 0;

  if (hasTools && llm.chatWithTools) {
    const tools = toILLMTools(req.tools!);
    const options: LLMToolCallOptions = {
      temperature: req.temperature,
      maxTokens: req.max_tokens,
      stop: normalizeStop(req.stop),
      tools,
      toolChoice: req.tool_choice as LLMToolCallOptions['toolChoice'],
    };

    const result = await llm.chatWithTools(messages, options);

    const toolCalls = result.toolCalls?.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
      },
    }));

    const finishReason =
      result.stopReason === 'tool_use'
        ? ('tool_calls' as const)
        : result.stopReason === 'max_tokens'
          ? ('length' as const)
          : ('stop' as const);

    const response: ChatCompletionResponse = {
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(startTime / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.content || null,
            ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        total_tokens: result.usage.promptTokens + result.usage.completionTokens,
      },
    };

    return reply.code(200).send(response);
  }

  // No tools — use simple complete()
  const systemPromptContent = messages.find((m) => m.role === 'system')?.content;
  const systemPrompt = systemPromptContent == null ? undefined : getLLMContentText(systemPromptContent);
  const userMessages = messages.filter((m) => m.role !== 'system');
  const prompt = userMessages.map((m) => m.content).join('\n\n');

  const result = await llm.complete(prompt, {
    systemPrompt,
    temperature: req.temperature,
    maxTokens: req.max_tokens,
    stop: normalizeStop(req.stop),
  });

  const response: ChatCompletionResponse = {
    id: requestId,
    object: 'chat.completion',
    created: Math.floor(startTime / 1000),
    model: req.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      total_tokens: result.usage.promptTokens + result.usage.completionTokens,
    },
  };

  return reply.code(200).send(response);
}

// ── Streaming handler ─────────────────────────────────────────────────────

async function handleStreamingRequest(
  reply: any,
  llm: ILLM,
  req: ChatCompletionRequest,
  requestId: string,
  logger: ILogger,
) {
  const created = Math.floor(Date.now() / 1000);

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Request-Id': requestId,
  });
  reply.raw.flushHeaders();

  const writeChunk = (chunk: ChatCompletionChunk): void => {
    if (!reply.raw.writableEnded) {
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
  };

  const writeDone = (): void => {
    if (!reply.raw.writableEnded) {
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }
  };

  try {
    // Initial role chunk
    writeChunk({
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model: req.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });

    // Stream text from LLM
    const systemPrompt = req.messages.find((m) => m.role === 'system')?.content;
    const userMessages = req.messages.filter((m) => m.role !== 'system');
    const prompt = userMessages.map((m) => m.content).join('\n\n');

    for await (const text of llm.stream(prompt, {
      systemPrompt,
      temperature: req.temperature,
      maxTokens: req.max_tokens,
      stop: normalizeStop(req.stop),
    })) {
      writeChunk({
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: req.model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
    }

    // Finish chunk
    writeChunk({
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model: req.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });

    writeDone();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('AI Gateway stream error', error, { requestId });
    if (!reply.raw.writableEnded) {
      reply.raw.write(
        `data: ${JSON.stringify({ error: { message: error.message, type: 'server_error' } })}\n\n`,
      );
      reply.raw.end();
    }
  }

  return reply;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function toILLMMessages(req: ChatCompletionRequest): LLMMessage[] {
  return req.messages.map((m) => {
    const msg: LLMMessage = { role: m.role, content: m.content };
    if (m.tool_call_id) {msg.toolCallId = m.tool_call_id;}
    if (m.tool_calls) {
      msg.toolCalls = m.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: safeJsonParse(tc.function.arguments),
      }));
    }
    return msg;
  });
}

function toILLMTools(tools: NonNullable<ChatCompletionRequest['tools']>): LLMTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    inputSchema: t.function.parameters ?? {},
  }));
}

function normalizeStop(stop: string | string[] | undefined): string[] | undefined {
  if (!stop) {return undefined;}
  return Array.isArray(stop) ? stop : [stop];
}

function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
