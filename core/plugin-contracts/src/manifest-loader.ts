/**
 * Manifest loading utilities
 */

import type { ManifestV3 } from "./manifest.js";
import { isManifestV3 } from "./manifest.js";

/**
 * Parse and validate JSON manifest
 */
export function parseManifest(json: string): ManifestV3 {
  try {
    const parsed = JSON.parse(json);

    if (!isManifestV3(parsed)) {
      throw new Error(
        `Invalid manifest: expected schema "kb.plugin/3", got "${parsed.schema || "unknown"}"`,
      );
    }

    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in manifest: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Validate manifest structure
 */
export function validateManifest(manifest: ManifestV3): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Required fields
  if (!manifest.id) {
    errors.push("Missing required field: id");
  }
  if (!manifest.version) {
    errors.push("Missing required field: version");
  }

  // Validate ID format (@scope/name)
  if (manifest.id && !/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(manifest.id)) {
    errors.push(
      `Invalid plugin ID format: ${manifest.id} (expected @scope/name)`,
    );
  }

  // Validate version (semver)
  if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    errors.push(
      `Invalid version format: ${manifest.version} (expected semver)`,
    );
  }

  // Validate handler paths exist
  if (manifest.cli?.commands) {
    for (const cmd of manifest.cli.commands) {
      if (!cmd.handler) {
        errors.push(`CLI command "${cmd.path}" missing handler path`);
      }
    }
  }

  if (manifest.rest?.routes) {
    for (const route of manifest.rest.routes) {
      if (!route.handler) {
        errors.push(
          `REST route "${route.method} ${route.path}" missing handler path`,
        );
      }
    }
  }

  if (manifest.sse?.streams) {
    const restGetPaths = new Set(
      (manifest.rest?.routes ?? [])
        .filter((route) => route.method === "GET")
        .map((route) => route.path),
    );
    for (const stream of manifest.sse.streams) {
      if (!stream.handler) {
        errors.push(`Event stream "${stream.path}" missing handler path`);
      }
      if (restGetPaths.has(stream.path)) {
        errors.push(
          `Event stream "${stream.path}" conflicts with REST GET route`,
        );
      }
    }
  }

  if (manifest.workflows?.handlers) {
    for (const wf of manifest.workflows.handlers) {
      if (!wf.handler) {
        errors.push(`Workflow "${wf.id}" missing handler path`);
      }
    }
  }

  if (manifest.webhooks?.handlers) {
    for (const hook of manifest.webhooks.handlers) {
      if (!hook.handler) {
        errors.push(`Webhook "${hook.event}" missing handler path`);
      }
    }
  }

  // Validate job handlers
  if (manifest.jobs) {
    const handlers = manifest.jobs.handlers ?? [];
    for (const job of handlers) {
      if (!job.handler) {
        errors.push(`Job handler "${job.id}" missing handler path`);
      }
    }
  }

  // Validate cron schedules
  if (manifest.cron) {
    const schedules = manifest.cron.schedules ?? [];
    for (const schedule of schedules) {
      if (!schedule.schedule) {
        errors.push(`Cron schedule "${schedule.id}" missing cron expression`);
      }
      if (!schedule.job?.type) {
        errors.push(`Cron schedule "${schedule.id}" missing job type`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Resolve header policy for a REST route
 * Returns a simplified header policy for validation
 */
export function resolveHeaderPolicy(
  manifest: ManifestV3,
  route?: { path: string; method: string },
): {
  allowList?: string[];
  denyList?: string[];
  inbound: Array<{
    match?: { kind: string; name?: string; prefix?: string; pattern?: string };
    action?: string;
    sensitive?: boolean;
    redactInErrors?: boolean;
  }>;
  outbound: Array<{
    match?: { kind: string; name?: string; prefix?: string; pattern?: string };
    action?: string;
    sensitive?: boolean;
    redactInErrors?: boolean;
  }>;
} {
  // For V3, header policy is defined per-route in rest.routes[].headers
  // This is a stub implementation for backward compatibility with registry-lint

  if (!route || !manifest.rest?.routes) {
    return { allowList: [], denyList: [], inbound: [], outbound: [] };
  }

  // Find the matching route
  const matchedRoute = manifest.rest.routes.find(
    (r) => r.path === route.path && r.method === route.method,
  );

  if (!matchedRoute) {
    return { allowList: [], denyList: [], inbound: [], outbound: [] };
  }

  // In V3, headers policy should be part of route declaration
  // For now, return empty policy (header validation is done at runtime)
  return {
    allowList: [],
    denyList: [],
    inbound: [],
    outbound: [],
  };
}
