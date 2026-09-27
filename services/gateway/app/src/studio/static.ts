/**
 * @module @kb-labs/gateway-app/studio/static
 *
 * Serves the built Studio SPA from the gateway (task 2.3, ADR-0043 B5).
 *
 * Reproduces the contract of `studio/app/server.js`:
 *   - `index.html` gets `window.__KB_STUDIO_CONFIG__ = {...}` injected before
 *     `</head>` (the global and variable names the SPA reads in
 *     `studio/app/src/config/env.ts`);
 *   - unknown extension-less paths fall back to `index.html` (SPA routing);
 *   - hashed assets are immutable, everything else (incl. `index.html`) is
 *     `no-cache`;
 *   - `/api/auth/*` is served by the gateway's `/auth/*` routes. The SPA calls
 *     auth same-origin under `/api` and the refresh cookie `Path` is
 *     `/api/auth/refresh`, so the browser-visible URL stays `/api/auth/*`
 *     and only the routing target is rewritten.
 *
 * The handler runs as an early `onRequest` hook so the SPA shell and its
 * assets are reachable before login; it never answers reserved gateway paths.
 */
import { readFile, stat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createErrorEnvelope,
  type ErrorEnvelope,
} from "@kb-labs/core-platform";
import type { GatewayConfig } from "@kb-labs/gateway-contracts";

/** Gateway-owned first path segments that the SPA fallback must never answer. */
const RESERVED_ROOTS: ReadonlySet<string> = new Set([
  "api",
  "auth",
  "health",
  "ready",
  "metrics",
  "observability",
  "hosts",
  "clients",
  "internal",
  "webhooks",
  "telemetry",
  "docs",
  "docs-all",
  "openapi.json",
  "openapi-merged.json",
  "echo",
]);

/** Gateway-native roots that Studio addresses under `/api/<root>/...`. */
const API_ALIAS_ROOTS: ReadonlySet<string> = new Set([
  "auth",
  "health",
  "ready",
  "hosts",
  "observability",
  "metrics",
]);

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/** rspack emits `[name].[contenthash:8].ext` in production builds. */
const HASHED_ASSET = /[.-][0-9a-f]{8,}\.[A-Za-z0-9]+$/;

export class StudioAssetsMissingError extends Error {
  readonly envelope: ErrorEnvelope;
  constructor(envelope: ErrorEnvelope) {
    super(`${envelope.code}: ${envelope.message} ${envelope.hint}`);
    this.name = "StudioAssetsMissingError";
    this.envelope = envelope;
  }
}

/** Pathname without query, with duplicate slashes collapsed. */
function pathnameOf(url: string): string {
  const q = url.indexOf("?");
  const raw = q === -1 ? url : url.slice(0, q);
  return raw.replace(/\/{2,}/g, "/");
}

function firstSegment(pathname: string): string {
  return pathname.split("/")[1] ?? "";
}

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Fastify `rewriteUrl`: maps `/api/auth/*` (and other gateway-native roots) to
 * the gateway's real routes so the SPA works unchanged. No handlers are
 * duplicated; the rewrite happens before routing, so hooks and cookie
 * handling see the native path. A configured upstream prefix (for example
 * `/api/v1`) is never rewritten.
 */
export function createStudioUrlRewriter(
  config: GatewayConfig,
): (rawUrl: string) => string {
  const upstreamPrefixes = Object.values(config.upstreams).map((u) => u.prefix);
  return (rawUrl) => {
    if (!rawUrl.startsWith("/api/")) {
      return rawUrl;
    }
    if (matchesPrefix(pathnameOf(rawUrl), upstreamPrefixes)) {
      return rawUrl;
    }
    const stripped = rawUrl.slice("/api".length);
    return API_ALIAS_ROOTS.has(firstSegment(pathnameOf(stripped)))
      ? stripped
      : rawUrl;
  };
}

/**
 * Locate the built Studio directory: explicit `studio.dir`, else the `dist` of
 * the installed `@kb-labs/studio-app` package (resolved, not declared as a
 * dependency, to keep the dependency direction services -> studio out of the
 * manifest). Returns a non-existent placeholder when the package is absent so
 * the caller reports `KB_HOST_STUDIO_ASSETS_MISSING`.
 */
export function resolveStudioDir(
  studio: { dir?: string },
  resolveId: (id: string) => string = (id) =>
    createRequire(import.meta.url).resolve(id),
): string {
  if (studio.dir) {
    return resolve(studio.dir);
  }
  try {
    return join(
      dirname(resolveId("@kb-labs/studio-app/package.json")),
      "dist",
    );
  } catch {
    return join("@kb-labs", "studio-app", "dist");
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export interface StudioStatic {
  /** Real path of the served directory. */
  dir: string;
  onRequest: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<FastifyReply | undefined>;
}

/**
 * Validates the Studio directory (throws `StudioAssetsMissingError` carrying
 * the unified envelope when `index.html` is absent) and builds the hook.
 */
export async function createStudioStatic(
  config: GatewayConfig,
  resolveId?: (id: string) => string,
): Promise<StudioStatic> {
  const studio = config.studio ?? { enabled: true };
  const dir = resolveStudioDir(studio, resolveId);
  if (!(await isFile(join(dir, "index.html")))) {
    throw new StudioAssetsMissingError(
      createErrorEnvelope("KB_HOST_STUDIO_ASSETS_MISSING", {
        details: { dir },
      }),
    );
  }
  const root = await realpath(dir);
  const upstreamPrefixes = Object.values(config.upstreams).map((u) => u.prefix);

  const runtimeConfig: Record<string, string> = {
    KB_API_BASE_URL: studio.apiBaseUrl ?? "/api/v1",
  };
  if (studio.eventsBaseUrl) {
    runtimeConfig.KB_EVENTS_BASE_URL = studio.eventsBaseUrl;
  }
  // `<` is escaped so a configured value can never close the script element.
  const configScript = `<script>window.__KB_STUDIO_CONFIG__ = ${JSON.stringify(
    runtimeConfig,
  ).replace(/</g, "\\u003c")};</script>`;

  const sendIndex = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const html = (await readFile(join(root, "index.html"), "utf-8")).replace(
      "</head>",
      () => `${configScript}</head>`,
    );
    return reply
      .code(200)
      .header("Content-Type", MIME[".html"])
      .header("Cache-Control", "no-cache")
      .send(request.method === "HEAD" ? undefined : html);
  };

  return {
    dir: root,
    async onRequest(request, reply) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return undefined;
      }
      const pathname = pathnameOf(request.url);
      if (
        RESERVED_ROOTS.has(firstSegment(pathname)) ||
        matchesPrefix(pathname, upstreamPrefixes)
      ) {
        return undefined;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        return undefined;
      }
      if (decoded === "/" || decoded === "/index.html") {
        return sendIndex(request, reply);
      }
      if (decoded.includes("\0")) {
        return undefined;
      }
      const target = resolve(root, `.${decoded}`);
      if (!target.startsWith(root + sep)) {
        return undefined;
      }
      if (await isFile(target)) {
        // A symlink inside the directory must not escape it.
        const real = await realpath(target);
        if (!real.startsWith(root + sep)) {
          return undefined;
        }
        const data = await readFile(real);
        return reply
          .code(200)
          .header(
            "Content-Type",
            MIME[extname(target)] ?? "application/octet-stream",
          )
          .header(
            "Cache-Control",
            HASHED_ASSET.test(target)
              ? "public, max-age=31536000, immutable"
              : "no-cache",
          )
          .send(request.method === "HEAD" ? undefined : data);
      }
      if (extname(target) === "") {
        // SPA route: unknown extension-less path.
        return sendIndex(request, reply);
      }
      // Missing file with an extension: fall through to a normal 404.
      return undefined;
    },
  };
}
