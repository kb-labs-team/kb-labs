/**
 * @module @kb-labs/host-app/settings
 *
 * The host's own configuration: the `host` section of the effective KB config.
 * The installer writes it; nothing here reads the environment.
 *
 * ```jsonc
 * { "host": { "modules": ["gateway", "marketplace", "state"], "auth": "off" } }
 * ```
 */

import { z } from "zod";

/** Machine-level modules the host can run. Studio static rides on `gateway`. */
export const HOST_MODULE_IDS = ["gateway", "marketplace", "state"] as const;
export type HostModuleId = (typeof HOST_MODULE_IDS)[number];

/**
 * `off`: solo machine, no login. The gateway binds loopback only and the host
 * refuses to start otherwise (`KB_HOST_EXPOSURE_REFUSED`).
 * `on`: login required; the gateway uses its secured mode and may bind
 * a non-loopback address.
 */
export type HostAuthMode = "off" | "on";

export const HostSettingsSchema = z.object({
  modules: z
    .array(z.enum(HOST_MODULE_IDS))
    .min(1)
    .default([...HOST_MODULE_IDS]),
  // The safe default: no login, and therefore loopback only.
  auth: z.enum(["off", "on"]).default("off"),
});

export interface HostSettings {
  modules: readonly HostModuleId[];
  auth: HostAuthMode;
}

/** Validates the raw `host` config section; an absent section yields the defaults. */
export function parseHostSettings(raw: unknown): HostSettings {
  const parsed = HostSettingsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `host.${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid host configuration: ${issues}`);
  }
  return { modules: [...new Set(parsed.data.modules)], auth: parsed.data.auth };
}
