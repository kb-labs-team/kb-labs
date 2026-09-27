/**
 * @module @kb-labs/host-app/policy
 *
 * Auth and bind policy for the host's one external listener (the gateway).
 * Pure functions over the validated gateway config, so the same decision can
 * be taken early (a dry run before any module starts) and again when the
 * gateway builds its own config.
 */

import type { GatewayConfig } from "@kb-labs/gateway-contracts";
import { isLoopbackHost } from "@kb-labs/gateway-app";
import { HostExposureRefusedError } from "./errors.js";
import type { HostAuthMode } from "./settings.js";

const LOOPBACK_BIND_HOST = "127.0.0.1";

export type GatewayUpstreams = GatewayConfig["upstreams"];

export interface HostGatewayPolicy {
  auth: HostAuthMode;
  /**
   * Routes for the modules the host runs itself. Routes written in the config
   * under the same name win, so an operator can still repoint one.
   */
  upstreams: GatewayUpstreams;
}

/**
 * Applies `host.auth` and the generated upstreams to the gateway config.
 *
 * - `off`: forces the gateway into local mode (no login). A non-loopback
 *   `gateway.host` is refused with `KB_HOST_EXPOSURE_REFUSED`; an unset host
 *   becomes loopback.
 * - `on`: forces the secured mode; bind host stays whatever the gateway config
 *   says (default: all interfaces).
 *
 * A config that contradicts `host.auth` (`gateway.auth.enabled` set the other
 * way) is an error, not silently overridden.
 */
export function applyHostGatewayPolicy(
  config: GatewayConfig,
  policy: HostGatewayPolicy,
): GatewayConfig {
  const upstreams = { ...policy.upstreams, ...config.upstreams };

  if (policy.auth === "off") {
    if (config.auth?.enabled === true) {
      throw new Error(
        'host.auth is "off" but gateway.auth.enabled is true. Set host.auth to "on" or remove gateway.auth.enabled.',
      );
    }
    const bindHost = config.host ?? LOOPBACK_BIND_HOST;
    if (!isLoopbackHost(bindHost)) {
      throw new HostExposureRefusedError(bindHost);
    }
    return {
      ...config,
      host: bindHost,
      access: { mode: "local" },
      ...(config.auth ? { auth: { ...config.auth, enabled: false } } : {}),
      upstreams,
    };
  }

  if (config.auth?.enabled === false) {
    throw new Error(
      'host.auth is "on" but gateway.auth.enabled is false. Set host.auth to "off" or remove gateway.auth.enabled.',
    );
  }
  return {
    ...config,
    access: { mode: "secured" },
    ...(config.auth ? { auth: { ...config.auth, enabled: true } } : {}),
    upstreams,
  };
}
