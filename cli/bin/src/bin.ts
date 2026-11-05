/**
 * bin.ts — CLI entry point for the `kb` command.
 *
 * This is the first module executed when the CLI binary is invoked. It is
 * responsible for environment bootstrapping that must happen before any other
 * modules are imported:
 *
 *  1. Log level    — defaults KB_LOG_LEVEL to "silent" so that no log output
 *                    leaks unless the user passes --debug or sets LOG_LEVEL /
 *                    KB_LOG_LEVEL explicitly.
 *  2. Output mode  — sets KB_OUTPUT_MODE to "json" when --json is present so
 *                    that lazily-initialised sinks (e.g. ConsoleSink) are never
 *                    created when machine-readable JSON output is requested.
 *
 * After bootstrapping, it imports and calls `run()` from the CLI index with
 * the raw process arguments (argv[2..]), then ensures the platform is
 * gracefully shut down via `platform.shutdown()` before the process exits.
 * If `run()` returns a numeric exit code, that code is forwarded to
 * `process.exitCode` so Node can finish flushing stdout and stderr before the
 * shell receives the correct status.
 */

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeCliResult, writeCliResultTo } from './runtime/result-serializer.js';

const INTERNAL_RESULT_CHANNEL = '--__kb_internal_result_channel=';

function descriptorIdentity(fd: number): string {
  const stat = fstatSync(fd);
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.rdev}`;
}

async function reportCliResultFailure(cause: string): Promise<void> {
  const [{ createErrorEnvelope }, { createJsonPresenter, createTextPresenter }, { handleExecutionError }] = await Promise.all([
    import('@kb-labs/core-platform'),
    import('@kb-labs/cli-runtime'),
    import('./runtime/execution-error.js'),
  ]);
  const binary = path.basename(process.argv[1] ?? 'kb');
  const envelope = createErrorEnvelope('KB_CLI_RESULT_UNAVAILABLE', {
    cause,
    details: { binary, cause },
    templateValues: { binary, cause },
  });
  const presenter = process.argv.includes('--json')
    ? createJsonPresenter((value) => writeCliResultTo(1, value))
    : createTextPresenter((value) => writeCliResultTo(1, value));
  handleExecutionError(new Error(cause), presenter, { envelope });
}

function isRemappedChild(): boolean {
  const marker = process.argv[2];
  if (!marker?.startsWith(INTERNAL_RESULT_CHANNEL)) return false;

  try {
    const challenge = JSON.parse(Buffer.from(marker.slice(INTERNAL_RESULT_CHANNEL.length), 'base64url').toString('utf8')) as {
      token: string;
      resultDescriptor: string;
      challengeDescriptor: string;
    };
    const tokenBuffer = Buffer.alloc(128);
    const tokenLength = readSync(4, tokenBuffer, 0, tokenBuffer.length, 0);
    const token = tokenBuffer.subarray(0, tokenLength).toString('utf8');
    return challenge.token === token &&
      challenge.resultDescriptor === descriptorIdentity(3) &&
      challenge.challengeDescriptor === descriptorIdentity(4) &&
      descriptorIdentity(1) === descriptorIdentity(2);
  } catch {
    return false;
  }
}

const remappedChild = isRemappedChild();
if (process.argv[2]?.startsWith(INTERNAL_RESULT_CHANNEL) && !remappedChild) {
  await reportCliResultFailure('the internal result-channel identity check failed');
  process.exit(1);
}

if (remappedChild) {
  process.argv.splice(2, 1);
  closeSync(4);
} else {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    await reportCliResultFailure('descriptor-based result handoff is unsupported on this operating system');
    process.exit(1);
  }

  const token = randomBytes(32).toString('hex');
  const challengePath = path.join(tmpdir(), `kb-result-channel-${token}`);
  const resultPath = path.join(tmpdir(), `kb-result-output-${token}`);
  let challengeFd: number | undefined;
  let resultFd: number | undefined;
  let challengeCreated = false;
  let resultCreated = false;
  let exitCode = 1;
  try {
    resultFd = openSync(resultPath, 'wx+', 0o600);
    resultCreated = true;
    unlinkSync(resultPath);
    resultCreated = false;
    const writeFd = openSync(challengePath, 'wx', 0o600);
    challengeCreated = true;
    try {
      writeSync(writeFd, token);
    } finally {
      closeSync(writeFd);
    }
    challengeFd = openSync(challengePath, 'r');
    unlinkSync(challengePath);
    challengeCreated = false;
    const challenge = Buffer.from(JSON.stringify({
      token,
      resultDescriptor: descriptorIdentity(resultFd),
      challengeDescriptor: descriptorIdentity(challengeFd),
    })).toString('base64url');
    const env = { ...process.env };
    const child = spawnSync(process.execPath, [process.argv[1]!, `${INTERNAL_RESULT_CHANNEL}${challenge}`, ...process.argv.slice(2)], {
      env,
      stdio: [0, 2, 2, resultFd, challengeFd],
    });
    const resultBytes = fstatSync(resultFd).size;
    if (child.error || child.signal || child.status === null || (resultBytes === 0 && child.status !== 0)) {
      const cause = child.signal
        ? `terminated by signal ${child.signal}`
        : child.error
          ? `could not start: ${child.error.message}`
          : child.status === null
            ? 'ended without a reported exit status'
            : `exited with status ${child.status} without returning a result`;
      await reportCliResultFailure(cause);
      exitCode = 1;
    } else if (resultBytes > 0) {
      const buffer = Buffer.alloc(64 * 1024);
      let resultOffset = 0;
      let bytesRead = 0;
      while ((bytesRead = readSync(resultFd, buffer, 0, buffer.length, resultOffset)) > 0) {
        let offset = 0;
        while (offset < bytesRead) {
          offset += writeSync(1, buffer, offset, bytesRead - offset);
        }
        resultOffset += bytesRead;
      }
      exitCode = child.status;
    } else {
      exitCode = 0;
    }
  } catch (error) {
    const cause = error instanceof Error
      ? `could not prepare the result channel: ${error.message}`
      : 'could not prepare the result channel because of an unknown error';
    await reportCliResultFailure(cause);
  } finally {
    if (challengeFd !== undefined) closeSync(challengeFd);
    if (resultFd !== undefined) closeSync(resultFd);
    if (challengeCreated) unlinkSync(challengePath);
    if (resultCreated) unlinkSync(resultPath);
  }
  process.exit(exitCode);
}

const rawCliArgs = process.argv.slice(2);

function resolveBootstrapLogLevel(args: string[]): string | undefined {
  if (args.includes('--debug')) { return 'debug'; }
  const inline = args.find((arg) => arg.startsWith('--log-level='));
  if (inline) { return inline.slice('--log-level='.length); }
  const index = args.indexOf('--log-level');
  return index >= 0 ? args[index + 1] : undefined;
}

// CRITICAL: Set default log level BEFORE any imports to prevent log spam.
// ESM static imports execute before the module body and used to initialise
// PlatformContainer with the fallback logger at the default `info` level.
if (!process.env.LOG_LEVEL && !process.env.KB_LOG_LEVEL) {
  process.env.KB_LOG_LEVEL = resolveBootstrapLogLevel(rawCliArgs) ?? 'silent';
}

// CLI diagnostics belong on stderr. Command results stay on stdout.
process.env.KB_LOG_STREAM = 'stderr';

// Check for --json flag BEFORE imports to ensure auto-init uses correct mode
// This prevents ConsoleSink from being created when user wants JSON output
if (process.argv.includes('--json')) {
  process.env.KB_OUTPUT_MODE = 'json';
}


// Captured at module load so that `resolvePlatformRoot` can walk up from the
// physical location of this bin.js file — the most reliable way to locate
// `node_modules/@kb-labs/*` in installed mode (independent of process.cwd()).
const BIN_MODULE_URL = import.meta.url;

(async () => {
  let cliModules: [
    typeof import('./index.js'),
    typeof import('@kb-labs/core-runtime'),
    typeof import('@kb-labs/cli-runtime'),
    typeof import('./runtime/execution-error.js'),
  ];
  try {
    // Import the platform only after the logging environment is bootstrapped.
    cliModules = await Promise.all([
      import('./index.js'),
      import('@kb-labs/core-runtime'),
      import('@kb-labs/cli-runtime'),
      import('./runtime/execution-error.js'),
    ]);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    await reportCliResultFailure(`could not load the CLI runtime: ${cause}`);
    process.exit(1);
  }
  const [{ run }, { platform }, { createJsonPresenter, createTextPresenter }, { handleExecutionError }] = cliModules;

  const reportUnexpectedError = async (error: Error) => {
    const presenter = process.env.KB_OUTPUT_MODE === 'json'
      ? createJsonPresenter(writeCliResult)
      : createTextPresenter(writeCliResult);
    handleExecutionError(error, presenter);
    try {
      await platform.shutdown();
    } catch (shutdownError) {
      process.stderr.write(
        `[kb] platform shutdown failed: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}\n`
      );
    }
    process.exit(1);
  };

  // Global handler — any uncaught exception renders as a formatted error box
  // instead of a raw Node.js stack dump.
  process.on('uncaughtException', (err) => {
    void reportUnexpectedError(err);
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    void reportUnexpectedError(err);
  });

  let code: number | void;
  try {
    code = await run(process.argv.slice(2), {
      moduleUrl: BIN_MODULE_URL,
      resultWriter: writeCliResult,
    });
  } finally {
    try {
      await platform.shutdown();
    } catch (error) {
      process.stderr.write(
        `[kb] platform shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  if (typeof code === "number") {
    process.exit(code);
  }
})();
