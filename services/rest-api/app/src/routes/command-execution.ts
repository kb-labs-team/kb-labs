import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { IEntityRegistry, ManifestV3, PluginContextDescriptor } from '@kb-labs/plugin-contracts';
import { getHandlerPermissions } from '@kb-labs/plugin-contracts';
import { createErrorEnvelope } from '@kb-labs/core-platform';
import type { ExecutionRequest } from '@kb-labs/plugin-execution-factory';
import { platform } from '@kb-labs/core-runtime';

const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 8 * 1024;
const MAX_FLAGS = 64;
const MAX_FLAG_VALUE_LENGTH = 8 * 1024;
const MAX_TIMEOUT_MS = 5 * 60_000;
const GLOBAL_FLAGS = new Set([
  'json', 'quiet', 'debug', 'no-color', 'noColor', 'verbose', 'logLevel', 'profile',
  'profilesDir', 'help', 'version', 'dry-run', 'dryRun', 'saveSnapshot', 'mock', 'recordMocks',
]);

interface ProjectCommandRequest {
  pluginId: string;
  commandPath: string;
  input: { argv: string[]; flags: Record<string, unknown> };
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRequest(value: unknown): ProjectCommandRequest | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !['pluginId', 'commandPath', 'input', 'timeoutMs'].includes(key))) {
    return undefined;
  }
  if (typeof value.pluginId !== 'string' || !/^@?[a-z0-9][a-z0-9._/-]{0,127}$/i.test(value.pluginId)) { return undefined; }
  if (typeof value.commandPath !== 'string' || value.commandPath.length > 256 || value.commandPath.trim() !== value.commandPath || !value.commandPath) { return undefined; }
  if (!isRecord(value.input) || Object.keys(value.input).some((key) => !['argv', 'flags'].includes(key))) { return undefined; }
  if (!Array.isArray(value.input.argv) || value.input.argv.length > MAX_ARGUMENTS || value.input.argv.some((arg) => typeof arg !== 'string' || arg.length > MAX_ARGUMENT_LENGTH)) { return undefined; }
  if (!isRecord(value.input.flags) || Object.keys(value.input.flags).length > MAX_FLAGS) { return undefined; }
  if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== 'number' || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > MAX_TIMEOUT_MS)) { return undefined; }
  for (const item of Object.values(value.input.flags)) {
    if (typeof item === 'string' && item.length > MAX_FLAG_VALUE_LENGTH) { return undefined; }
    if (typeof item === 'number' && !Number.isFinite(item)) { return undefined; }
    if (!['string', 'number', 'boolean'].includes(typeof item) && !(Array.isArray(item) && item.length <= MAX_ARGUMENTS && item.every((entry) => typeof entry === 'string' && entry.length <= MAX_ARGUMENT_LENGTH))) { return undefined; }
  }
  return value as unknown as ProjectCommandRequest;
}

function containedPath(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function writeEvent(reply: import('fastify').FastifyReply, event: unknown): void {
  if (!reply.raw.writableEnded && !reply.raw.destroyed) {
    reply.raw.write(`${JSON.stringify(event)}\n`);
  }
}

/** Project-runtime-only CLI execution endpoint. Catalog and process authority stay in this runtime. */
export async function registerProjectCommandExecutionRoute(
  app: FastifyInstance,
  options: { registry: IEntityRegistry; projectId?: string; projectRoot: string; platformRoot: string },
): Promise<void> {
  app.post('/api/v1/commands/execute', { config: { ux: 'raw' }, bodyLimit: 64 * 1024, schema: { hide: true } }, async (request, reply) => {
    const body = validateRequest(request.body);
    if (!body) {
      return reply.code(400).send({ ok: false, error: createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', { details: { field: 'body' } }) });
    }
    if (!options.projectId || request.headers['x-kb-project-id'] !== options.projectId) {
      return reply.code(403).send({ ok: false, error: createErrorEnvelope('KB_AUTH_FORBIDDEN', { details: { permission: 'project.runtime.execute' } }) });
    }

    const snapshot = options.registry.snapshot();
    const entry = snapshot.manifests.find((candidate) => candidate.pluginId === body.pluginId);
    const declared = entry?.manifest.cli?.commands?.find((candidate) => candidate.path === body.commandPath);
    if (!entry || !declared || !entry.pluginRoot || snapshot.partial || snapshot.stale) {
      return reply.code(404).send({ ok: false, error: createErrorEnvelope('KB_RUNTIME_UNKNOWN_COMMAND', { templateValues: { binary: 'kb' }, details: { command: body.commandPath } }) });
    }

    const declaredFlags = declared.flags ?? [];
    const allowedFlags = new Set([...GLOBAL_FLAGS, ...declaredFlags.flatMap((flag) => [flag.name, flag.name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())])]);
    if (Object.keys(body.input.flags).some((key) => !allowedFlags.has(key))) {
      return reply.code(400).send({ ok: false, error: createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', { details: { field: 'flags' } }) });
    }
    const commandFlags = { ...body.input.flags };
    for (const flag of declaredFlags) {
      const camel = flag.name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      const present = Object.hasOwn(commandFlags, flag.name) ? flag.name : camel;
      const supplied = commandFlags[present];
      if (supplied === undefined) { continue; }
      if (flag.type === 'boolean' && typeof supplied !== 'boolean') { return reply.code(400).send({ ok: false, error: createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', { details: { field: `flags.${flag.name}` } }) }); }
      if (flag.type === 'string' && typeof supplied !== 'string') { return reply.code(400).send({ ok: false, error: createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', { details: { field: `flags.${flag.name}` } }) }); }
      if (flag.type === 'number') {
        const parsed = typeof supplied === 'number' ? supplied : typeof supplied === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(supplied.trim()) ? Number(supplied) : Number.NaN;
        if (!Number.isFinite(parsed)) { return reply.code(400).send({ ok: false, error: createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', { details: { field: `flags.${flag.name}` } }) }); }
        commandFlags[present] = parsed;
      }
      if (flag.type === 'array' && (!Array.isArray(supplied) || supplied.some((part) => typeof part !== 'string'))) { return reply.code(400).send({ ok: false, error: createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', { details: { field: `flags.${flag.name}` } }) }); }
      if (flag.type === 'string' && flag.choices && typeof supplied === 'string' && !flag.choices.includes(supplied)) { return reply.code(400).send({ ok: false, error: createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', { details: { field: `flags.${flag.name}` } }) }); }
    }

    const requestId = randomUUID();
    const executionId = `project-${randomUUID()}`;
    const startedAt = Date.now();
    const root = await realpath(entry.pluginRoot);
    const handlerParts = declared.handler.split('#');
    const declaredHandler = handlerParts[0] ?? '';
    if (!declaredHandler || path.isAbsolute(declaredHandler)) {
      return reply.code(400).send({ ok: false, error: createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', { details: { command: body.commandPath, plugin: body.pluginId } }) });
    }
    const candidateHandler = declaredHandler.startsWith('dist/')
      ? path.resolve(root, declaredHandler)
      : path.resolve(root, 'dist', declaredHandler.replace(/^\.\//, ''));
    let handlerPath: string;
    try { handlerPath = await realpath(candidateHandler); }
    catch { return reply.code(404).send({ ok: false, error: createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', { details: { command: body.commandPath, plugin: body.pluginId } }) }); }
    if (!containedPath(root, handlerPath)) {
      return reply.code(400).send({ ok: false, error: createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', { details: { command: body.commandPath, plugin: body.pluginId } }) });
    }

    const permissions = getHandlerPermissions(entry.manifest as ManifestV3, 'cli', body.commandPath);
    const descriptor: PluginContextDescriptor = {
      hostType: 'cli',
      pluginId: body.pluginId,
      pluginVersion: entry.manifest.version,
      permissions,
      requestId,
      executionId,
      hostContext: { host: 'cli', binaryName: 'kb', argv: body.input.argv, flags: commandFlags },
    };
    const executionRequest: ExecutionRequest = {
      executionId,
      descriptor,
      pluginRoot: root,
      handlerRef: path.relative(root, handlerPath),
      exportName: handlerParts[1] || 'default',
      input: { argv: body.input.argv, flags: commandFlags },
      env: process.env,
      platformRoot: options.platformRoot,
      timeoutMs: Math.min(body.timeoutMs ?? declared.permissions?.quotas?.timeoutMs ?? MAX_TIMEOUT_MS, declared.permissions?.quotas?.timeoutMs ?? MAX_TIMEOUT_MS),
      workspace: { cwd: options.projectRoot },
      context: { commandPath: body.commandPath },
    };

    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) { controller.abort(new Error('Client disconnected')); }
    });
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-cache', 'X-Execution-Id': executionId });
    reply.raw.flushHeaders();
    writeEvent(reply, { type: 'execution:output', requestId, executionId, stream: 'stderr', data: `Executing ${body.pluginId} ${body.commandPath} in project runtime\n`, timestamp: Date.now() });

    try {
      const result = await platform.executionBackend.execute(executionRequest, {
        signal: controller.signal,
        uiPromptHint: 'This command needs interactive input. Run it in a supported local interactive context.',
        onLog: (entry) => writeEvent(reply, { type: 'execution:output', requestId, executionId, stream: entry.stream, data: entry.message.endsWith('\n') ? entry.message : `${entry.message}\n`, timestamp: Date.now() }),
      });
      if (controller.signal.aborted) {
        writeEvent(reply, { type: 'execution:cancelled', requestId, executionId, reason: 'user', durationMs: Date.now() - startedAt });
        writeEvent(reply, { type: 'execution:done', requestId, executionId, exitCode: 130, durationMs: Date.now() - startedAt });
      } else if (result.ok) {
        writeEvent(reply, { type: 'execution:done', requestId, executionId, exitCode: 0, durationMs: Date.now() - startedAt, metadata: { result: result.data ?? null, executionOwner: 'project-runtime', projectId: options.projectId, executionMode: platform.executionBackend.executionMode } });
      } else {
        writeEvent(reply, { type: 'execution:error', requestId, executionId, error: result.error.envelope });
        writeEvent(reply, { type: 'execution:done', requestId, executionId, exitCode: 1, durationMs: Date.now() - startedAt });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        writeEvent(reply, { type: 'execution:cancelled', requestId, executionId, reason: 'user', durationMs: Date.now() - startedAt });
        writeEvent(reply, { type: 'execution:done', requestId, executionId, exitCode: 130, durationMs: Date.now() - startedAt });
      } else {
        writeEvent(reply, { type: 'execution:error', requestId, executionId, error: createErrorEnvelope('KB_RUNTIME_UNEXPECTED', { correlationId: requestId }) });
        writeEvent(reply, { type: 'execution:done', requestId, executionId, exitCode: 1, durationMs: Date.now() - startedAt });
      }
    } finally {
      if (!reply.raw.writableEnded) { reply.raw.end(); }
    }
  });
}
