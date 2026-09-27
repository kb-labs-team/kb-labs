import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { resolve } from 'node:path';
import type { ExternalHarnessId, SubAgentPreset } from '@kb-labs/agent-contracts';
import { getExternalHarnessAdapter, type HarnessMcpAccess, type PreparedHarnessMcpConfig } from '@kb-labs/agent-harnesses';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_PROMPT_INSTRUCTIONS_CHARS = 4_000;
const MAX_RESULT_CHARS = 12_000;
const TERMINATION_GRACE_MS = 1_000;
const PLATFORM_SECRET_ENV_VARS = [
  'KB_MCP_TOKEN',
  'KB_AGENT_MCP_TOKEN',
  'KB_GATEWAY_TOKEN',
  'GATEWAY_JWT_SECRET',
  'GATEWAY_INTERNAL_SECRET',
] as const;

export interface ExternalHarnessResult {
  summary: string;
  iterations: number;
  tokensUsed: number;
}

export interface ExternalHarnessInput {
  harness: ExternalHarnessId;
  task: string;
  workingDir: string;
  preset: SubAgentPreset;
  maxIterations: number;
  projectInstructions?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  mcpAccess?: HarnessMcpAccess;
  mcpTools?: string[];
  onActivity?: (activity: { type: 'message' | 'tool' | 'progress' | 'thinking' | 'status' | 'error'; action: string; detail?: string }) => void;
}

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Runs a locally authenticated agent CLI as one bounded child task. Vendor
 * output stays inside this module; callers receive only a summary and metrics.
 */
export async function runExternalHarness(
  input: ExternalHarnessInput,
  spawnProcess: SpawnProcess = nodeSpawn,
): Promise<ExternalHarnessResult> {
  const workingDir = resolve(input.workingDir);
  const prompt = buildHarnessPrompt(input.task, input.projectInstructions ?? null, input.mcpTools ?? []);
  const adapter = getExternalHarnessAdapter(input.harness);
  const launchInput = {
    harness: input.harness,
    workingDir,
    prompt,
    preset: input.preset,
    maxIterations: input.maxIterations,
  };
  const launch = adapter.launch(launchInput);
  const signal = input.signal;

  if (signal?.aborted) {
    throw new Error(`External harness ${input.harness} cancelled before launch`);
  }

  let mcpConfig: PreparedHarnessMcpConfig | undefined;
  try {
    if (input.mcpAccess) {
      if (!adapter.prepareMcpConfig) {
        throw new Error(`External harness ${input.harness} does not support per-execution MCP configuration`);
      }
      mcpConfig = await adapter.prepareMcpConfig(launchInput, input.mcpAccess);
    }
    if (signal?.aborted) {
      throw new Error(`External harness ${input.harness} cancelled before launch`);
    }
  } catch (error) {
    await mcpConfig?.cleanup?.().catch(() => {});
    throw error;
  }

  const args = [...launch.args];
  if (mcpConfig) {
    // Supported launchers place the prompt as the final positional argument.
    args.splice(Math.max(0, args.length - 1), 0, ...mcpConfig.args);
  }
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  // Never let a broad parent bearer accidentally reach the external process.
  for (const name of PLATFORM_SECRET_ENV_VARS) { delete childEnv[name]; }
  Object.assign(childEnv, mcpConfig?.env);
  const sanitize = (value: string) => redactSecrets(
    input.mcpAccess ? value.split(input.mcpAccess.accessToken).join('[REDACTED]') : value,
  );

  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(launch.command, args, {
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      void mcpConfig?.cleanup?.().catch(() => {});
      rejectPromise(new Error(`Could not start ${input.harness}: ${errorMessage(error)}`));
      return;
    }

    let stdoutBuffer = '';
    let stderr = '';
    let stdoutBytes = 0;
    let iterations = 0;
    let tokensUsed = 0;
    let summary = '';
    let reportedError: string | undefined;
    let stopReason: string | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) { clearTimeout(killTimer); }
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = async (error?: Error, result?: ExternalHarnessResult) => {
      if (settled) { return; }
      settled = true;
      cleanup();
      await mcpConfig?.cleanup?.().catch(() => {});
      if (error) { rejectPromise(error); }
      else if (result) { resolvePromise(result); }
      else { rejectPromise(new Error(`${input.harness} exited without a result`)); }
    };
    const stop = (reason: string) => {
      if (settled || stopReason) { return; }
      stopReason = reason;
      killHarness(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        killHarness(child, 'SIGKILL');
        void finish(new Error(stopReason));
      }, TERMINATION_GRACE_MS);
    };
    const onAbort = () => stop(`External harness ${input.harness} cancelled`);
    const consumeLine = (line: string) => {
      if (!line.trim()) { return; }
      const parsed = adapter.parseLine(line);
      if (parsed.activity) {
        const detail = parsed.activity.detail ? sanitize(parsed.activity.detail).slice(0, 2_000) : undefined;
        input.onActivity?.({
          ...parsed.activity,
          action: sanitize(parsed.activity.action).slice(0, 2_000),
          ...(detail ? { detail } : {}),
        });
      }
      if (parsed.summary) { summary = parsed.summary; }
      if (parsed.iterations) { iterations += parsed.iterations; }
      if (parsed.tokensUsed) { tokensUsed += parsed.tokensUsed; }
      if (parsed.error) { reportedError = parsed.error; }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stop(`External harness ${input.harness} exceeded the ${MAX_STDOUT_BYTES}-byte output limit`);
        return;
      }
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) { consumeLine(line); }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });

    child.once('error', (error) => {
      finish(new Error(`Could not start ${input.harness}: ${error.message}`));
    });
    child.once('close', (code, closeSignal) => {
      if (stopReason) {
        finish(new Error(stopReason));
        return;
      }
      if (stdoutBuffer.trim()) { consumeLine(stdoutBuffer); }
      if (reportedError) {
        finish(new Error(`${input.harness} failed: ${sanitize(reportedError).slice(0, 1_000)}`));
        return;
      }
      if (code !== 0) {
        const detail = sanitize(stderr.trim().replace(/\s+/g, ' ')).slice(-1_000);
        finish(new Error(detail || `${input.harness} exited with ${closeSignal ?? `code ${code ?? 'unknown'}`}`));
        return;
      }
      if (!summary.trim()) {
        finish(new Error(`${input.harness} exited successfully without a final response`));
        return;
      }
      finish(undefined, { summary: sanitize(summary.trim()).slice(0, MAX_RESULT_CHARS), iterations, tokensUsed });
    });

    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => stop(`External harness ${input.harness} timed out after ${Math.round((input.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} seconds`), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (signal?.aborted) { onAbort(); }
  });
}

export function buildHarnessPrompt(task: string, projectInstructions: string | null, mcpTools: string[] = []): string {
  const sections = [
    'You are a sub-agent launched by the KB Labs orchestrator.',
    'Work only on the assigned task in the current working directory. Do not publish, deploy, send messages, or access secrets.',
    'Return a concise summary of changes and verification. The orchestrator will decide whether to delegate follow-up work to another harness.',
  ];
  if (projectInstructions) {
    const boundedInstructions = projectInstructions.length > MAX_PROMPT_INSTRUCTIONS_CHARS
      ? `${projectInstructions.slice(0, MAX_PROMPT_INSTRUCTIONS_CHARS)}\n[Project instructions truncated]`
      : projectInstructions;
    sections.push(`# Project instructions\n${boundedInstructions}`);
  }
  if (mcpTools.length > 0) {
    sections.push(
      '# KB Labs platform MCP tools\n' +
      'A per-task KB Labs platform MCP server is configured as `kb_platform`. ' +
      'Use it only for the assigned task. The lease grants these platform tool IDs: ' +
      mcpTools.join(', '),
    );
  }
  sections.push(`# Assigned task\n${task}`);
  return sections.join('\n\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function killHarness(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing the direct process if its process group is gone.
    }
  }
  child.kill(signal);
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
}
