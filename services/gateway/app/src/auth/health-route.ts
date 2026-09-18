/**
 * @module gateway-app/auth/health-route
 *
 * `GET /health/auth` — local-operator view of auth readiness, consumed by
 * `kb-dev doctor` (and readable with curl on the host).
 *
 * The body says things an attacker would love to know ("no admin exists",
 * "tokens are signed with the public dev secret"), so unlike `/health` and
 * `/health/adapters` this route is NOT public. It answers only a request that
 * demonstrably originates on this machine, and answers everyone else with a
 * plain 404 so it does not even advertise itself. Three independent checks
 * must all pass, so one misconfigured layer is not enough to expose it:
 *
 * 1. the TCP peer is a loopback address (not `request.ip`, which
 *    `trustProxy` derives from client-supplied headers);
 * 2. no proxy/forwarding header is present — a reverse proxy on the same
 *    host makes the peer look like loopback for every visitor;
 * 3. the `Host` header names a loopback host — a proxy forwards the public
 *    name, a local operator addresses `localhost`/`127.0.0.1`.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthReadiness } from '@kb-labs/gateway-auth';

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto'] as const;

/** A complete IPv4 literal in 127.0.0.0/8 — a prefix match would accept `127.0.0.1.evil.example`. */
const LOOPBACK_IPV4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const isLoopbackIp = (ip: string): boolean => {
  const a = ip.toLowerCase();
  return a === '::1' || LOOPBACK_IPV4.test(a) || (a.startsWith('::ffff:') && LOOPBACK_IPV4.test(a.slice(7)));
};

const isLoopbackAddress = (address: string | undefined): boolean => address !== undefined && isLoopbackIp(address);

const hostnameOf = (hostHeader: string): string => {
  const h = hostHeader.trim().toLowerCase();
  // "[::1]:4000" → "::1"; "localhost:4000" → "localhost"; "127.0.0.1" → "127.0.0.1"
  if (h.startsWith('[')) {return h.slice(1, h.indexOf(']'));}
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
};

const isLoopbackHostname = (hostname: string): boolean => hostname === 'localhost' || isLoopbackIp(hostname);

/** True only for a request that originates on this machine and was not proxied. */
export const isLocalOperatorRequest = (request: FastifyRequest): boolean => {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {return false;}
  if (FORWARDING_HEADERS.some((name) => request.headers[name] !== undefined)) {return false;}
  const host = request.headers.host;
  return typeof host === 'string' && isLoopbackHostname(hostnameOf(host));
};

export const registerAuthHealthRoute = (
  app: Pick<FastifyInstance, 'get'>,
  getReadiness: () => Promise<AuthReadiness>,
): void => {
  app.get(
    '/health/auth',
    { schema: { tags: ['System'], summary: 'Auth readiness (local operator only)' } },
    async (request, reply) => {
      if (!isLocalOperatorRequest(request)) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      return getReadiness();
    },
  );
};
