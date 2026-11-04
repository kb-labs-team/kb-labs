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
  // Import the platform only after the logging environment is bootstrapped.
  const [{ run }, { platform }, { createJsonPresenter, createTextPresenter }, { handleExecutionError }] = await Promise.all([
    import('./index.js'),
    import('@kb-labs/core-runtime'),
    import('@kb-labs/cli-runtime'),
    import('./runtime/execution-error.js'),
  ]);

  const reportUnexpectedError = async (error: Error) => {
    const presenter = process.env.KB_OUTPUT_MODE === 'json'
      ? createJsonPresenter()
      : createTextPresenter();
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
    await new Promise<void>((resolve, reject) => {
      process.stdout.write('', (error) => error ? reject(error) : resolve());
    });
    process.exit(code);
  }
})();
