/**
 * @module @kb-labs/project-runtime-app/args
 *
 * Command line and environment of the `kb-project-runtime` executable.
 * The shared secret is read from the environment only: argv is visible to
 * every local user through `ps`.
 */

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  canonicalizeProjectPath,
  isProjectId,
} from "@kb-labs/core-project-registry";
import { RUNTIME_ARGS, RUNTIME_TOKEN_ENV } from "./protocol.js";

const MIN_TOKEN_LENGTH = 16;

export interface RuntimeListenAddress {
  host: string;
  port: number;
}

export interface RuntimeArgs {
  /** Canonical absolute project root. */
  projectRoot: string;
  projectId: string;
  listen: RuntimeListenAddress;
  token: string;
  /** Host process to watch; the runtime exits when it is gone. */
  parentPid?: number;
}

/** Raised for a bad command line; the executable prints it and exits with code 2. */
export class RuntimeArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeArgsError";
  }
}

export function isLoopbackAddress(host: string): boolean {
  const value = host.trim().toLowerCase();
  return (
    value === "localhost" ||
    value === "::1" ||
    value === "[::1]" ||
    value.startsWith("127.")
  );
}

function readFlag(argv: readonly string[], flag: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline !== undefined) {
    return inline.slice(flag.length + 1);
  }
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new RuntimeArgsError(`${flag} needs a value`);
  }
  return value;
}

function requireFlag(argv: readonly string[], flag: string): string {
  const value = readFlag(argv, flag);
  if (!value) {
    throw new RuntimeArgsError(`${flag} is required`);
  }
  return value;
}

/** `host:port` (IPv6 hosts in brackets). */
export function parseListen(value: string): RuntimeListenAddress {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value);
  if (!match) {
    throw new RuntimeArgsError(
      `${RUNTIME_ARGS.listen} must look like 127.0.0.1:PORT, got "${value}"`,
    );
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RuntimeArgsError(`${RUNTIME_ARGS.listen}: invalid port ${port}`);
  }
  const host = match[1]!;
  if (!isLoopbackAddress(host)) {
    throw new RuntimeArgsError(
      `${RUNTIME_ARGS.listen}: a project runtime binds loopback only, got "${host}"`,
    );
  }
  return { host: host.replace(/^\[|\]$/g, ""), port };
}

/**
 * Parses the runtime's input. The host supplies an opaque stable project ID;
 * path changes do not change project identity or its state directory.
 */
export async function parseRuntimeArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<RuntimeArgs> {
  const rawRoot = requireFlag(argv, RUNTIME_ARGS.projectRoot);
  if (!isAbsolute(rawRoot)) {
    throw new RuntimeArgsError(
      `${RUNTIME_ARGS.projectRoot} must be an absolute path, got "${rawRoot}"`,
    );
  }
  const info = await stat(rawRoot).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new RuntimeArgsError(
      `${RUNTIME_ARGS.projectRoot} "${rawRoot}" is not a directory`,
    );
  }
  const projectRoot = await canonicalizeProjectPath(rawRoot);

  const projectId = requireFlag(argv, RUNTIME_ARGS.projectId);
  if (!isProjectId(projectId)) {
    throw new RuntimeArgsError(
      `${RUNTIME_ARGS.projectId} must be a valid project id, got "${projectId}"`,
    );
  }

  const listen = parseListen(requireFlag(argv, RUNTIME_ARGS.listen));

  const token = env[RUNTIME_TOKEN_ENV];
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    throw new RuntimeArgsError(
      `${RUNTIME_TOKEN_ENV} must be set to a secret of at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }

  const rawParent = readFlag(argv, RUNTIME_ARGS.parentPid);
  let parentPid: number | undefined;
  if (rawParent !== undefined) {
    parentPid = Number(rawParent);
    if (!Number.isInteger(parentPid) || parentPid < 1) {
      throw new RuntimeArgsError(
        `${RUNTIME_ARGS.parentPid} must be a process id, got "${rawParent}"`,
      );
    }
  }

  return {
    projectRoot,
    projectId,
    listen,
    token,
    ...(parentPid !== undefined ? { parentPid } : {}),
  };
}
