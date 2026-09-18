/**
 * @module gateway-app/access
 *
 * One place that decides "is login required, and where may we bind?" from
 * `gateway.access.mode`, `gateway.auth.enabled` and `gateway.host`.
 *
 * Precedence, most specific first:
 * - `auth.enabled` and `host`, when set, are explicit operator choices and win;
 * - otherwise `access.mode: "local"` means no login and a loopback bind;
 * - otherwise (nothing set, or `secured`) login is required and the bind is
 *   the deployed-platform default `0.0.0.0` — exactly the behaviour before
 *   `access.mode` existed, so existing configs are unaffected.
 *
 * The B-023 guardrail (auth off ⇒ loopback only) is enforced by the caller on
 * the values returned here, so an explicit non-loopback `host` combined with
 * `access.mode: "local"` still refuses to start.
 */

import type { GatewayConfig } from '@kb-labs/gateway-contracts';

export interface ResolvedAccess {
  authEnabled: boolean;
  bindHost: string;
}

const DEPLOYED_BIND_HOST = '0.0.0.0';
const LOCAL_BIND_HOST = '127.0.0.1';

export const resolveAccess = (
  config: Pick<GatewayConfig, 'host'> & {
    access?: GatewayConfig['access'];
    auth?: { enabled?: boolean };
  },
): ResolvedAccess => {
  const local = config.access?.mode === 'local';
  return {
    authEnabled: config.auth?.enabled ?? !local,
    bindHost: config.host ?? (local ? LOCAL_BIND_HOST : DEPLOYED_BIND_HOST),
  };
};
