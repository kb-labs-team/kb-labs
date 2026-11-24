import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ICache } from '@kb-labs/core-platform';
import {
  forwardedIdentityHeaders,
  readForwardedIdentity,
  stripForwardedIdentityHeaders,
  type AuthContext,
} from '@kb-labs/gateway-contracts';
import type { JwtConfig } from '@kb-labs/gateway-auth';
import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import { PERMISSIONS } from '@kb-labs/core-contracts';
import { authRejectionEnvelope, gatewayRequestUrl, resolveToken, extractBearerToken } from './tokens.js';
import { createUserAuthMiddleware, type UserAuthMiddlewareDeps } from './user-auth-middleware.js';
import { isGatewayPath } from '../routes/path-classification.js';

export const LOCAL_ADMIN_CONTEXT: AuthContext = {
  type: 'machine', userId: 'local-admin', namespaceId: 'local', tier: 'enterprise',
  permissions: Object.values(PERMISSIONS),
};

const PUBLIC_ROUTES = new Map<string, ReadonlySet<string>>([
  ['/health', new Set(['GET', 'HEAD'])], ['/health/adapters', new Set(['GET', 'HEAD'])],
  ['/health/identity', new Set(['GET', 'HEAD'])],
  // The route has its own loopback-peer, loopback-Host, and no-forwarding-header guard.
  ['/health/auth', new Set(['GET', 'HEAD'])],
  ['/ready', new Set(['GET', 'HEAD'])],
  ['/', new Set(['GET', 'HEAD'])], ['/login', new Set(['GET', 'HEAD'])],
  ['/favicon.ico', new Set(['GET', 'HEAD'])], ['/mf-manifest.json', new Set(['GET', 'HEAD'])],
  ['/studio', new Set(['GET', 'HEAD'])], ['/hosts/register', new Set(['POST'])],
  ['/auth/token', new Set(['POST'])], ['/auth/refresh', new Set(['POST'])],
  ['/auth/login', new Set(['POST'])], ['/auth/login/cli', new Set(['POST'])],
  ['/auth/refresh/cli', new Set(['POST'])], ['/auth/logout/cli', new Set(['POST'])],
  ['/auth/activate', new Set(['POST'])], ['/auth/password/reset', new Set(['POST'])],
  ['/auth/providers', new Set(['GET'])],
]);

type WebhookManifest = { pluginId: string; manifest: ManifestV3 };

export function isPlatformPublicRoute(method: string, routePath: string): boolean {
  if (PUBLIC_ROUTES.get(routePath)?.has(method)) { return true; }
  if (method === 'GET' && isRegistryPublicReadRoute(routePath)) { return true; }
  const oauthSegments = routePath.split('/').filter(Boolean);
  if (method === 'GET' && oauthSegments[0] === 'auth' && oauthSegments[1] === 'oauth') {
    return oauthSegments.length === 4 && ['start', 'callback'].includes(oauthSegments[3] ?? '');
  }
  if (['GET', 'HEAD'].includes(method)) {
    if (/^\/(?:assets|static|studio\/assets)\/[^/]+(?:\/[^/]+)*\.[a-z0-9]{1,8}$/i.test(routePath)) { return true; }
  }
  return routePath.startsWith('/plugins/') && /\/widgets\/[^/]+\.[a-z0-9]{1,8}$/i.test(routePath);
}

function isRegistryPublicReadRoute(routePath: string): boolean {
  const path = routePath.replace(/\/+$/, '') || '/';
  const catalogReads = '(?:packages|packages/[^/]+/[^/]+(?:/stats)?)';
  const packageReads = '(?:api/v1/resolve|api/v1/packages|api/v1/packages/[^/]+/[^/]+(?:/stats|/[^/]+/tarball)?)';
  return new RegExp(`^/api/v1/registry/${catalogReads}$`).test(path) ||
    new RegExp(`^/api/v1/marketplace-registry/${packageReads}$`).test(path);
}

function isStudioFallbackRoute(routePath: string): boolean {
  return !isGatewayPath(routePath) && !routePath.slice(1).includes('.');
}

export function isDeclaredWebhookRoute(method: string, routePath: string, manifests: WebhookManifest[]): boolean {
  if (method !== 'POST') { return false; }
  const parts = routePath.split('/').filter(Boolean);
  if (parts[0] !== 'webhooks' || (parts.length !== 3 && parts.length !== 4)) { return false; }
  let pluginId: string;
  try { pluginId = decodeURIComponent(parts[1] ?? ''); } catch { return false; }
  const event = parts[2];
  const multi = parts.length === 4;
  return manifests.some(({ pluginId: declaredId, manifest }) => declaredId === pluginId &&
    manifest.webhooks?.handlers.some((handler) => handler.event === event && Boolean(handler.multi) === multi && Boolean(handler.auth)));
}

function isCorsPreflight(request: FastifyRequest): boolean {
  return request.method === 'OPTIONS' && Boolean(request.headers.origin) &&
    typeof request.headers['access-control-request-method'] === 'string';
}

function sendCorsPreflight(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const requestedMethod = request.headers['access-control-request-method'];
  const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  const method = typeof requestedMethod === 'string' && allowedMethods.has(requestedMethod.toUpperCase())
    ? requestedMethod.toUpperCase()
    : '';
  const requestedHeaders = request.headers['access-control-request-headers'];
  const allowedHeaders = new Set(['authorization', 'content-type', 'mcp-session-id']);
  const headers = typeof requestedHeaders === 'string'
    ? requestedHeaders.split(',').map((header) => header.trim().toLowerCase()).filter((header) => allowedHeaders.has(header))
    : [];
  reply.header('Access-Control-Allow-Origin', '*').header('Vary', 'Origin');
  if (method) { reply.header('Access-Control-Allow-Methods', method); }
  if (headers.length > 0) { reply.header('Access-Control-Allow-Headers', headers.join(', ')); }
  return reply.code(204).send();
}

declare module 'fastify' {
  interface FastifyRequest { authContext?: AuthContext; }
}

/** The single gateway authentication hook. It authenticates users first, then machine tokens. */
export function createAuthMiddleware(
  cache: ICache,
  jwtConfig: JwtConfig,
  options: { authEnabled?: boolean; internalSecret?: string; userAuth?: UserAuthMiddlewareDeps; webhookManifests?: WebhookManifest[]; studioEnabled?: boolean; studioPublicAsset?: (method: string, path: string) => Promise<boolean> } = {},
) {
  const authEnabled = options.authEnabled !== false;
  const userAuth = options.userAuth ? createUserAuthMiddleware(options.userAuth) : undefined;
  return async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const unauthorized = () => {
      request.log.warn({ event: 'gateway.auth.rejected', requestId: String(request.id), reason: 'missing' },
        'Gateway authentication rejected');
      return reply.code(401).send({ ok: false, error: authRejectionEnvelope(undefined, gatewayRequestUrl(request), String(request.id)) });
    };
    if (isCorsPreflight(request)) { sendCorsPreflight(request, reply); return; }
    // No registered route can dispatch this request; preserve the shared 404 instead of masking it as an auth failure.
    if (!request.routeOptions.url) { return; }
    if (!request.url.startsWith('/internal/')) { stripForwardedIdentityHeaders(request.headers); }
    if (!authEnabled) {
      request.authContext = LOCAL_ADMIN_CONTEXT;
      Object.assign(request.headers, forwardedIdentityHeaders(request.authContext, options.internalSecret));
      return;
    }
    const rawPath = new URL(request.url, 'http://localhost').pathname;
    const routePath = rawPath.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
    const registryPublicRead = request.method === 'GET' && isRegistryPublicReadRoute(routePath);
    if (isPlatformPublicRoute(request.method, routePath) && !registryPublicRead) { return; }
    if (options.studioPublicAsset && await options.studioPublicAsset(request.method, routePath)) { return; }
    if (!registryPublicRead && options.studioEnabled && ['GET', 'HEAD'].includes(request.method) && isStudioFallbackRoute(routePath)) { return; }
    const optionalRegistryToken = (request.query as Record<string, string | undefined>)['access_token'];
    if (registryPublicRead && !extractBearerToken(request.headers.authorization) && !optionalRegistryToken && !request.headers.cookie) {
      Object.assign(request.headers, forwardedIdentityHeaders(request.authContext, options.internalSecret));
      return;
    }
    if (routePath.startsWith('/internal/')) {
      if (readForwardedIdentity(request.headers, options.internalSecret).kind !== 'rejected') { return; }
      return unauthorized();
    }
    // These routes are admitted only from webhook manifest declarations. The
    // registered platform handler verifies the declaration's auth before dispatch.
    if (isDeclaredWebhookRoute(request.method, routePath, options.webhookManifests ?? [])) { return; }

    if (userAuth) {
      await userAuth(request, reply);
      if (reply.sent) { return; }
      if (request.userAuthContext?.source === 'cookie' || request.userAuthContext?.source === 'bearer' || request.userAuthContext?.source === 'api-token') {
        Object.assign(request.headers, forwardedIdentityHeaders(request.authContext, options.internalSecret));
        return;
      }
    }

    const queryToken = (request.query as Record<string, string | undefined>)['access_token'];
    const token = extractBearerToken(request.headers.authorization) ?? queryToken ?? null;
    if (!token && request.userAuthContext) { return; }
    if (request.userAuthContext?.source === 'bearer' || request.userAuthContext?.source === 'api-token') { return; }
    if (!token) {
      if (registryPublicRead) {
        Object.assign(request.headers, forwardedIdentityHeaders(request.authContext, options.internalSecret));
        return;
      }
      return unauthorized();
    }
    const verification = await resolveToken(token, cache, jwtConfig);
    if (!verification.ok) {
      request.log.warn({
        event: 'gateway.auth.rejected',
        requestId: String(request.id),
        reason: verification.reason,
      }, 'Gateway authentication rejected');
      return reply.code(401).send({ ok: false, error: authRejectionEnvelope(verification.reason, gatewayRequestUrl(request), String(request.id)) });
    }
    request.authContext = verification.payload;
    Object.assign(request.headers, forwardedIdentityHeaders(request.authContext, options.internalSecret));
  };
}
