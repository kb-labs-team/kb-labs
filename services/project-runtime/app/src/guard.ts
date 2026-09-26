/**
 * @module @kb-labs/project-runtime-app/guard
 *
 * The runtime's single entry point for the host. It
 *
 * - accepts a request only when it carries the shared secret (the runtime is
 *   never a public listener; only the host knows the secret),
 * - answers `GET /__runtime/health` itself, and
 * - forwards `/<moduleId>/<path>` to the module bound on its own loopback
 *   port, with `/<moduleId>` stripped.
 *
 * Modules keep their own ephemeral loopback ports. Those are not secret-gated
 * (the modules are the existing rest/workflow servers); the guard is the only
 * address the host is told about.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import type { IContextLogger } from "@kb-labs/core-platform";
import {
  RUNTIME_HEALTH_PATH,
  RUNTIME_PROJECT_HEADER,
  RUNTIME_TOKEN_HEADER,
  type RuntimeHealth,
} from "./protocol.js";

export interface GuardModuleAddress {
  host: string;
  port: number;
}

export interface RuntimeGuardOptions {
  token: string;
  projectId: string;
  projectRoot: string;
  /** Module id -> loopback address of that module. */
  modules: Readonly<Record<string, GuardModuleAddress>>;
  logger: IContextLogger;
}

export interface RuntimeGuard {
  listen(address: { host: string; port: number }): Promise<void>;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time comparison; hashing first makes the lengths equal. */
export function tokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== "string") {
    return false;
  }
  return timingSafeEqual(digest(expected), digest(received));
}

function forwardHeaders(
  incoming: IncomingHttpHeaders,
  address: GuardModuleAddress,
  projectId: string,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      lower === RUNTIME_TOKEN_HEADER ||
      lower === RUNTIME_PROJECT_HEADER ||
      lower === "host"
    ) {
      continue;
    }
    headers[lower] = value;
  }
  headers.host = `${address.host}:${address.port}`;
  headers[RUNTIME_PROJECT_HEADER] = projectId;
  return headers;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isReachable(address: GuardModuleAddress): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: address.host, port: address.port });
    const done = (up: boolean): void => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function createRuntimeGuard(options: RuntimeGuardOptions): RuntimeGuard {
  const { token, projectId, projectRoot, modules, logger } = options;
  const startedAt = Date.now();

  const health = async (res: ServerResponse): Promise<void> => {
    const entries = await Promise.all(
      Object.entries(modules).map(
        async ([id, address]) =>
          [id, (await isReachable(address)) ? "up" : "down"] as const,
      ),
    );
    const allUp = entries.every(([, state]) => state === "up");
    const body: RuntimeHealth = {
      status: allUp ? "ok" : "degraded",
      projectId,
      projectRoot,
      pid: process.pid,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      modules: Object.fromEntries(entries),
    };
    sendJson(res, allUp ? 200 : 503, body);
  };

  const proxy = (
    req: IncomingMessage,
    res: ServerResponse,
    address: GuardModuleAddress,
    path: string,
  ): void => {
    const upstream = httpRequest(
      {
        host: address.host,
        port: address.port,
        method: req.method,
        path,
        headers: forwardHeaders(req.headers, address, projectId),
      },
      (upstreamRes) => {
        const headers: IncomingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP.has(name.toLowerCase())) {
            headers[name] = value;
          }
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.pipe(res);
        upstreamRes.once("error", () => res.destroy());
      },
    );
    upstream.once("error", (error) => {
      logger.warn("Runtime guard could not reach a module", {
        error: error.message,
        path,
      });
      sendJson(res, 502, { error: "module_unreachable" });
    });
    res.once("close", () => upstream.destroy());
    req.pipe(upstream);
  };

  const server: Server = createServer((req, res) => {
    if (!tokenMatches(token, req.headers[RUNTIME_TOKEN_HEADER])) {
      // Same answer for a missing and a wrong secret; nothing else is revealed.
      sendJson(res, 403, { error: "forbidden" });
      req.resume();
      return;
    }
    const url = req.url ?? "/";
    const pathname = url.split("?", 1)[0]!;
    if (pathname === RUNTIME_HEALTH_PATH) {
      void health(res);
      return;
    }
    const match = /^\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
    const address = match ? modules[match[1]!] : undefined;
    if (!match || !address) {
      sendJson(res, 404, { error: "unknown_module" });
      req.resume();
      return;
    }
    const query = url.slice(pathname.length);
    proxy(req, res, address, `${match[2] ?? "/"}${query}`);
  });

  // Streams other than plain HTTP (WebSocket upgrades) are not proxied yet.
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
  });

  return {
    listen: (address) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(address.port, address.host, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
