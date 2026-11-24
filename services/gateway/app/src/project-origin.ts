/**
 * Origin trust for requests proxied to private project runtimes.
 *
 * Project runtimes apply their own CORS policy to the request they receive.
 * The Gateway may suppress Origin only when it can prove the browser used the
 * Gateway's trusted public origin, or when the request is a direct same-origin
 * loopback connection. A configured public URL is trusted only when the raw
 * Host header has the same full authority, including its port. A reverse proxy
 * that rewrites Host or drops a nondefault external port therefore retains the
 * existing project-service CORS behavior until it preserves that authority.
 * All other Origin values are preserved for the runtime to handle under its
 * existing policy.
 */

import { isIP } from "node:net";

export interface ProjectOriginRequest {
  origin?: string;
  host?: string;
  peerAddress?: string;
  localPort?: number;
}

export interface ProjectOriginTrustOptions {
  /** Operator-controlled public URL; never sourced from request headers. */
  publicUrl?: string;
  /** Whether the Gateway is running with authentication enabled. */
  authEnabled: boolean;
}

function parseOrigin(value: string | undefined): URL | undefined {
  if (!value || value === "null" || value.trim() !== value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || parsed.hash ||
      parsed.origin !== value
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function configuredPublicOrigin(value: string | undefined): string | undefined {
  if (!value || value.trim() !== value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.search || parsed.hash
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function hasExactHostAuthority(hostHeader: string | undefined, publicOrigin: string): boolean {
  if (!hostHeader || hostHeader.trim() !== hostHeader) {
    return false;
  }
  try {
    const publicUrl = new URL(publicOrigin);
    const requestUrl = new URL(`${publicUrl.protocol}//${hostHeader}`);
    return requestUrl.origin === publicOrigin && requestUrl.pathname === "/" &&
      !requestUrl.search && !requestUrl.hash && !requestUrl.username && !requestUrl.password;
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  if (address === "::1") {
    return true;
  }
  const mappedV4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (isIP(mappedV4) !== 4) {
    return false;
  }
  return Number(mappedV4.split(".")[0]) === 127;
}

function isDirectLoopbackOriginMatch(
  origin: URL,
  request: ProjectOriginRequest,
): boolean {
  if (
    origin.protocol !== "http:" ||
    !request.host ||
    !Number.isInteger(request.localPort) ||
    !isLoopbackAddress(request.peerAddress)
  ) {
    return false;
  }

  let host: URL;
  try {
    if (request.host.trim() !== request.host) {
      return false;
    }
    host = new URL(`http://${request.host}`);
  } catch {
    return false;
  }

  const hostname = host.hostname.toLowerCase();
  if (host.pathname !== "/" || host.search || host.hash || host.username || host.password) {
    return false;
  }
  const hostIsLoopback = hostname === "localhost" || hostname === "[::1]" ||
    (isIP(hostname) === 4 && Number(hostname.split(".")[0]) === 127);
  if (!hostIsLoopback) {
    return false;
  }
  const hostPort = host.port ? Number(host.port) : 80;
  const originPort = origin.port ? Number(origin.port) : 80;
  return hostPort === request.localPort && origin.hostname === hostname && originPort === hostPort;
}

/**
 * True only when Origin is proven to be the Gateway's own browser origin.
 * The result permits the private project-runtime proxy to remove Origin; it
 * does not authorize the request. Unknown and cross-origin values remain
 * intact so the project service's existing policy continues to apply.
 */
export function isTrustedGatewayOrigin(
  request: ProjectOriginRequest,
  options: ProjectOriginTrustOptions,
): boolean {
  const origin = parseOrigin(request.origin);
  if (!origin) {
    return false;
  }

  const publicOrigin = configuredPublicOrigin(options.publicUrl);
  if (
    options.authEnabled &&
    publicOrigin === origin.origin &&
    hasExactHostAuthority(request.host, publicOrigin)
  ) {
    return true;
  }

  return isDirectLoopbackOriginMatch(origin, request);
}
