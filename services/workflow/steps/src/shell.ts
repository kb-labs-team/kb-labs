/**
 * @module @kb-labs/workflow-runtime/builtin-handlers/shell
 * Built-in shell execution handler for workflows
 *
 * Security features:
 * - Blocks dangerous commands (rm -rf /, fork bombs, etc.)
 * - Execution cancellation forwarded from the workflow execution boundary
 * - Environment variable isolation
 * - Working directory restrictions
 */

import { execaCommand } from 'execa';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import { WORKFLOW_ACTIVITY_META_KEY } from '@kb-labs/workflow-contracts';

/**
 * Commands that are always blocked (dangerous)
 */
const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf /*',
  'mkfs',
  'dd if=',
  ':(){:|:&};:', // Fork bomb
  'chmod -R 777 /',
  'chown -R',
  '> /dev/sda',
  'mv /* ',
  'fdisk',
];

/** Cap on how much of a failed command's output gets attached to its log entry. */
const FAILURE_OUTPUT_TAIL_CHARS = 4000;

/** Cap on how much of a surfaced ::kb-output:: marker line gets attached — see `tail()`. */
const MARKER_LINE_MAX_CHARS = 2000;

/**
 * The last `::kb-output::`/`::kb-output:base64::` line in `text`, or null.
 * A `kb` command reports its real structured result on one of these lines
 * (e.g. `{"ok":false,"failed":["dist-exports"],...}`) — often followed by a
 * wrapper's own generic exit banner (pnpm's "[ELIFECYCLE] Command failed
 * with exit code 1."), which then becomes the literal last bytes of output.
 */
function lastOutputMarkerLine(text: string): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && (line.includes(OUTPUT_MARKER_B64) || line.includes(OUTPUT_MARKER))) {
      return line;
    }
  }
  return null;
}

/**
 * Batching for durable line persistence: the ring buffer's `maxSize` is a
 * fixed number of records shared across the entire daemon (not per run/step),
 * so one `ctx.platform.logger` call per output line would let a single
 * verbose step (e.g. a package install with thousands of lines) evict every
 * other run's recent logs from the hot tier. We accumulate lines and flush
 * as one logger call per window, keyed by whichever limit is hit first.
 */
const LOG_BATCH_MAX_LINES = 50;
const LOG_BATCH_MAX_MS = 500;

/**
 * Last N characters of `text`, prefixed with a marker when it was truncated.
 * Tail (not head) because the actionable error is almost always at the end —
 * a stack trace, an assertion failure, the final "Error:" line.
 *
 * Exception: a raw byte-count tail alone silently drops the one thing that
 * actually explains a failed `kb` command. A wrapper's generic exit banner
 * (pnpm's "[ELIFECYCLE] Command failed...") becomes the true last bytes of
 * output, while the command's own `::kb-output::` result — the whole reason
 * `runReleaseChecks` and friends exist — sits earlier in the stream and gets
 * discarded (observed live: a failed `release checks run` step logged only
 * "[ELIFECYCLE] Command failed with exit code 1." with the real
 * `{"ok":false,"failed":[...]}` payload truncated away). When a marker line
 * is present, surface it ahead of the raw tail instead of dropping it.
 */
export function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {return text;}
  const rawTail = `…(truncated, showing last ${maxChars} of ${text.length} chars)\n${text.slice(-maxChars)}`;
  const markerLine = lastOutputMarkerLine(text);
  if (!markerLine || rawTail.includes(markerLine)) {return rawTail;}
  const markerSnippet = markerLine.length > MARKER_LINE_MAX_CHARS
    ? `${markerLine.slice(0, MARKER_LINE_MAX_CHARS)}…(marker line truncated, ${markerLine.length} chars total)`
    : markerLine;
  return `${markerSnippet}\n${rawTail}`;
}

/**
 * Accumulates output lines for one stream (stdout or stderr) and flushes them
 * as a single durable log write once `maxLines` lines have queued up or
 * `maxMs` has elapsed since the first unflushed line — whichever comes first.
 *
 * This is what makes per-line shell output durable without turning every
 * line into its own `ctx.platform.logger` call: the daemon's ring buffer is a
 * fixed number of records shared across the whole daemon, so one write per
 * line would let a single verbose step evict every other run's recent logs.
 */
export class LineBatcher {
  private buffer: Array<{ line: string; lineNo: number }> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly stream: 'stdout' | 'stderr',
    private readonly onFlush: (batch: { stream: 'stdout' | 'stderr'; fromLine: number; toLine: number; text: string }) => void,
    private readonly maxLines = LOG_BATCH_MAX_LINES,
    private readonly maxMs = LOG_BATCH_MAX_MS,
  ) {}

  public add(line: string, lineNo: number): void {
    this.buffer.push({ line, lineNo });
    if (this.buffer.length >= this.maxLines) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.maxMs);
    }
  }

  /** Flush whatever is buffered right now, regardless of size/time thresholds. */
  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) {return;}
    const batch = this.buffer;
    this.buffer = [];
    this.onFlush({
      stream: this.stream,
      fromLine: batch[0]!.lineNo,
      toLine: batch[batch.length - 1]!.lineNo,
      text: batch.map((entry) => entry.line).join('\n'),
    });
  }
}

/**
 * Split string into chunks of specified size
 */
function chunkString(str: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += chunkSize) {
    chunks.push(str.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Shell handler input
 */
export interface ShellInput {
  /** Command to execute */
  command: string;

  /** Additional environment variables */
  env?: Record<string, string>;

  /** Throw on non-zero exit code (default: false) */
  throwOnError?: boolean;
}

/**
 * Shell handler output
 */
export interface ShellOutput {
  /** Standard output */
  stdout: string;

  /** Standard error */
  stderr: string;

  /** Exit code */
  exitCode: number;

  /** Whether command succeeded (exitCode === 0) */
  ok: boolean;
}

/**
 * Plain-JSON output marker.
 *   echo '::kb-output::{"passed":true}'
 *
 * Only safe for values without embedded newlines, quotes, or control chars.
 * For multi-line text, binary data, or any value produced by a sub-command,
 * prefer the base64 variant below.
 */
const OUTPUT_MARKER = '::kb-output::';

/**
 * Base64-encoded JSON output marker — JSON-safe for any payload.
 *
 * Usage (shell):
 *   PAYLOAD=$(jq -cn --arg plan "$(cat /tmp/plan.md)" '{plan: $plan}' | base64 -w0)
 *   echo "::kb-output:base64::${PAYLOAD}"
 *
 * This handles multi-line text, special chars, and any binary-safe content.
 * The base64 string is decoded and JSON-parsed by the runtime.
 */
const OUTPUT_MARKER_B64 = '::kb-output:base64::';

/**
 * Parse a single ::kb-output:: or ::kb-output:base64:: marker line into key-value pairs.
 *
 * Returns the parsed object, or null if the line is not a recognized marker.
 * Throws a descriptive error if the marker payload is malformed so callers can warn.
 */
export function parseOutputMarkerLine(line: string): Record<string, unknown> | null {
  // Base64-encoded variant — JSON-safe for any payload
  const b64Idx = line.indexOf(OUTPUT_MARKER_B64);
  if (b64Idx !== -1) {
    const raw = line.slice(b64Idx + OUTPUT_MARKER_B64.length).trim();
    let decoded: string;
    try {
      decoded = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      throw new Error(`::kb-output:base64:: payload is not valid base64`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`::kb-output:base64:: malformed JSON payload after decode: ${detail}`);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error(`::kb-output:base64:: JSON must be an object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
  }

  // Plain-JSON variant — only safe for simple scalar values
  const idx = line.indexOf(OUTPUT_MARKER);
  if (idx !== -1) {
    const raw = line.slice(idx + OUTPUT_MARKER.length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`::kb-output:: malformed JSON payload: ${detail}`);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error(`::kb-output:: JSON must be an object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
  }

  return null;
}

/**
 * Extract structured outputs from shell stdout.
 *
 * Priority:
 * 1. ::kb-output:base64:: marker lines — JSON-safe, recommended for complex values
 * 2. ::kb-output:: marker lines — plain JSON, ok for simple scalars
 * 3. Entire stdout as JSON — fallback for backward compat (simple commands)
 *
 * Malformed markers emit a warning instead of silently dropping the output.
 * Logs and other stdout content are ignored for output purposes.
 */
export function mergeJsonOutputs(output: ShellOutput, warn?: (msg: string) => void): Record<string, unknown> {
  const base: Record<string, unknown> = { ...output };
  const trimmed = output.stdout.trim();
  if (!trimmed) {return base;}

  // Priority 1 + 2: Look for ::kb-output:: or ::kb-output:base64:: marker lines
  const lines = output.stdout.split('\n');
  let foundMarker = false;
  for (const line of lines) {
    if (!line.includes('::kb-output')) {continue;}
    foundMarker = true;
    try {
      const parsed = parseOutputMarkerLine(line);
      if (parsed) {
        Object.assign(base, parsed);
      }
    } catch (err) {
      // Malformed marker — warn instead of silently dropping
      const msg = err instanceof Error ? err.message : String(err);
      warn?.(`Malformed ::kb-output:: marker (outputs not populated): ${msg}`);
    }
  }

  if (foundMarker) {return base;}

  // Priority 3: Fallback — entire stdout as JSON (backward compat)
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(base, parsed as Record<string, unknown>);
    }
  } catch {
    // Not JSON — return as-is
  }

  return base;
}

/**
 * Built-in shell execution handler.
 *
 * Executes shell commands with safety checks and execution-boundary cancellation.
 *
 * @param ctx - Handler execution context
 * @param input - Shell command input
 * @returns Shell execution result
 * @throws Error if dangerous command detected or execution is cancelled
 */
async function shellHandler(
  ctx: PluginContextV3,
  input: ShellInput,
): Promise<{ workflowStepResult: Record<string, unknown> }> {
  const { command, env = {}, throwOnError = false } = input;

  // Security: Check for dangerous commands
  const normalizedCommand = command.toLowerCase().trim();
  for (const blocked of BLOCKED_COMMANDS) {
    if (normalizedCommand.includes(blocked.toLowerCase())) {
      throw new Error(
        `Dangerous command blocked: "${blocked}". Command attempted: ${command.slice(0, 100)}`,
      );
    }
  }

  // Get working directory from context (workflow workspace)
  const cwd = ctx.cwd;

  // Merge environment variables
  const mergedEnv = {
    ...env,
  };

  ctx.platform.logger.info('Executing shell command', {
    command: command.slice(0, 200),
    cwd,
  });

  try {
    // detached: true puts the subprocess in its own process group. On cancellation we kill
    // the entire group (process.kill(-pid, 'SIGKILL')), which takes down both the shell
    // and any children it spawned. Without this, SIGTERM reaches only the shell; child
    // processes (e.g. `sleep N`) inherit the pipe write-end and block await indefinitely.
    const proc = execaCommand(command, {
      cwd,
      env: mergedEnv,
      extendEnv: false,
      shell: true,
      stdio: 'pipe',
      reject: false, // We handle exit codes ourselves
      detached: true,
    });

    // Stream stdout/stderr line-by-line in real-time.
    // We consume the streams ourselves via 'data' events for live log streaming.
    // Because attaching a 'data' listener drains the stream, execa's result.stdout
    // will be empty — we must reconstruct the full output from collected chunks.
    let lineNo = 0;
    let stdoutBuf = '';
    let stderrBuf = '';
    let stdoutFull = '';
    let stderrFull = '';

    // Durable persistence for full per-line output, batched so a verbose step
    // (e.g. a package install emitting thousands of lines) doesn't blow away
    // the daemon's shared ring buffer with one record per line. This is
    // additive to the live 'log.line' event below, not a replacement for it.
    const onBatchFlush = (batch: { stream: 'stdout' | 'stderr'; fromLine: number; toLine: number; text: string }) => {
      const log = batch.stream === 'stderr' ? ctx.platform.logger.warn : ctx.platform.logger.info;
      log.call(ctx.platform.logger, `Shell output (${batch.stream})`, {
        stream: batch.stream,
        fromLine: batch.fromLine,
        toLine: batch.toLine,
        text: batch.text,
      });
    };
    const stdoutBatcher = new LineBatcher('stdout', onBatchFlush);
    const stderrBatcher = new LineBatcher('stderr', onBatchFlush);

    const emitLine = (stream: 'stdout' | 'stderr', line: string) => {
      lineNo++;
      // stderr is an output stream, not an exit-status signal. Several
      // perfectly successful tools (notably command discovery) deliberately
      // write diagnostics there. The step result is evaluated from exitCode;
      // keep stderr visible without turning every diagnostic line into an
      // error event.
      void ctx.api.events.emit('log.line', { stream, line, lineNo, level: stream === 'stderr' ? 'warn' : 'info' });
      (stream === 'stderr' ? stderrBatcher : stdoutBatcher).add(line, lineNo);
    };

    const emitActivity = () => {
      void ctx.api.events.emit('log.line', { stream: 'stdout', line: '', lineNo: 0, meta: { [WORKFLOW_ACTIVITY_META_KEY]: true } });
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      emitActivity();
      const text = chunk.toString();
      stdoutFull += text;
      stdoutBuf += text;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {emitLine('stdout', line);}
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      emitActivity();
      const text = chunk.toString();
      stderrFull += text;
      stderrBuf += text;
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {emitLine('stderr', line);}
    });

    // The execution boundary owns the deadline. This handler only terminates
    // its process group when that boundary signals cancellation.
    const killProcessGroup = () => {
      const pid = proc.pid;
      if (pid !== undefined) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') { throw error; }
        }
      }
    };
    if (ctx.signal?.aborted) { killProcessGroup(); }
    else { ctx.signal?.addEventListener('abort', killProcessGroup, { once: true }); }

    const result = await proc;
    ctx.signal?.removeEventListener('abort', killProcessGroup);

    // Flush remaining buffered content
    if (stdoutBuf) {emitLine('stdout', stdoutBuf);}
    if (stderrBuf) {emitLine('stderr', stderrBuf);}

    // Flush any lines still waiting on the batch window/size threshold —
    // without this, the tail of a step's output (fewer than maxLines lines,
    // flushed less than maxMs ago) would never reach durable storage.
    stdoutBatcher.flush();
    stderrBatcher.flush();

    if (ctx.signal?.aborted) { throw new Error('Shell command execution aborted'); }

    const output: ShellOutput = {
      // Use our accumulated buffers — result.stdout/stderr are empty because
      // we consumed the streams via 'data' listeners above.
      stdout: stdoutFull || result.stdout,
      stderr: stderrFull || result.stderr,
      exitCode: result.exitCode ?? 0,
      ok: (result.exitCode ?? 0) === 0,
    };

    if (output.ok) {
      ctx.platform.logger.info('Shell command completed successfully', {
        exitCode: output.exitCode,
        stdoutLines: output.stdout.split('\n').length,
      });
    } else {
      // Attach the actual output, not just its shape — this is the log entry
      // that shows up in `kb workflow runs logs`, and it used to carry only
      // exitCode + a line count. Debugging a failed step meant re-running the
      // command outside the workflow just to see why it failed.
      ctx.platform.logger.warn('Shell command failed', {
        exitCode: output.exitCode,
        stderrLines: output.stderr.split('\n').length,
        stderrTail: tail(output.stderr, FAILURE_OUTPUT_TAIL_CHARS),
        stdoutTail: tail(output.stdout, FAILURE_OUTPUT_TAIL_CHARS),
      });

      if (throwOnError) {
        const failParts = [`Shell command failed with exit code ${output.exitCode}: ${command.slice(0, 200)}`];
        const failStderrTail = tail(output.stderr, FAILURE_OUTPUT_TAIL_CHARS);
        const failStdoutTail = tail(output.stdout, FAILURE_OUTPUT_TAIL_CHARS);
        if (failStdoutTail) { failParts.push(`--- stdout (tail) ---\n${failStdoutTail}`); }
        if (failStderrTail) { failParts.push(`--- stderr (tail) ---\n${failStderrTail}`); }
        throw new Error(failParts.join('\n'));
      }
    }

    const resultData = mergeJsonOutputs(output, (msg) => ctx.platform.logger.warn(`[shell] ${msg}`));
    if (output.exitCode !== 0 && !resultData.error) {
      resultData.error = { kind: 'exit', retryable: false, exitCode: output.exitCode, message: `Command exited with code ${output.exitCode}`, code: 'COMMAND_FAILED' };
    }
    return { workflowStepResult: resultData };
  } catch (error) {
    // Handle execution error
    if (error && typeof error === 'object' && 'exitCode' in error) {
      const execError = error as { exitCode?: number; stdout?: string; stderr?: string };
      const output: ShellOutput = {
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? '',
        exitCode: execError.exitCode ?? 1,
        ok: false,
      };

      ctx.platform.logger.error('Shell command execution failed', undefined, {
        exitCode: output.exitCode,
        stderr: output.stderr.slice(0, 500),
      });

      if (!throwOnError) {
        return { workflowStepResult: { ...output, error: { kind: 'exit', retryable: false, exitCode: output.exitCode, message: `Command exited with code ${output.exitCode}`, code: 'COMMAND_FAILED' } } };
      }
    }

    throw error;
  }
}

// Export handler in format expected by ExecutionBackend
export default {
  execute: shellHandler,
};
