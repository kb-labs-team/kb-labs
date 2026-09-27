#!/usr/bin/env node
/**
 * `kb-recover`: the executable behind `kb-create doctor --recover`. It is run by
 * the launcher (never by the host or Studio) with the host stopped, in the
 * platform root, with the host's environment. See `recover.ts`.
 */

import { connect } from "node:net";
import {
  initPlatform,
  loadPlatformConfig,
  platform,
} from "@kb-labs/core-runtime";
import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import {
  RecoverUsageError,
  parseRecoverArgs,
  runRecover,
  type GatewayAuthSlice,
} from "./recover.js";

const PROBE_TIMEOUT_MS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8").replace(/\r?\n$/, "");
}

function isPortListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function main(): Promise<number> {
  // The result is this tool's stdout (JSON with --json); adapter chatter would
  // corrupt it, so the platform logs errors only unless the operator asks for more.
  process.env.KB_LOG_LEVEL ??= "error";
  let args;
  try {
    args = parseRecoverArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof RecoverUsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const loaded = await loadPlatformConfig({
    moduleUrl: import.meta.url,
    startDir: process.cwd(),
    loadEnvFile: true,
  });
  await initPlatform(
    loaded.platformConfig,
    loaded.projectRoot,
    undefined,
    loaded.platformRoot !== loaded.projectRoot ? loaded.platformRoot : undefined,
    makeAssemblyHook(),
  );
  try {
    const config = loaded.effectiveConfig ?? loaded.rawConfig;
    const gateway = isRecord(config?.gateway) ? (config.gateway as GatewayAuthSlice) : {};
    return await runRecover(args, {
      gateway,
      documentDatabase: platform.isReal("documentDatabase") ? platform.documentDatabase : undefined,
      env: process.env,
      readStdin,
      isPortListening,
      logger: {
        info: (message, meta) => platform.logger.info(message, meta),
        warn: (message, meta) => platform.logger.warn(message, meta),
      },
      out: {
        write: (text) => process.stdout.write(text),
        error: (text) => process.stderr.write(`${text}\n`),
        json: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
      },
    });
  } finally {
    await platform.shutdown();
  }
}

/**
 * The tool is one-shot. Adapters the platform initialised may keep timers or
 * connections alive, so the process must end explicitly, after the output has
 * been flushed.
 */
function exitAfterFlush(code: number): void {
  process.stderr.write("", () => {
    process.stdout.write("", () => {
      process.exit(code);
    });
  });
}

main().then(exitAfterFlush, (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exitAfterFlush(1);
});
