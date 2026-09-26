/**
 * @module @kb-labs/adapters-analytics-file/manifest
 * Adapter manifest for file-based analytics.
 */

import type { AdapterManifest } from "@kb-labs/sdk/adapters";

/**
 * Adapter manifest for file-based analytics.
 */
export const manifest: AdapterManifest = {
  manifestVersion: "1.0.0",
  id: "analytics-file",
  name: "File Analytics",
  version: "1.0.0",
  description: "Local filesystem analytics adapter for development and testing",
  author: "KB Labs Team",
  license: "KBPL-1.1",
  type: "core",
  implements: "IAnalytics",
  optional: {
    adapters: ["cache"], // Optional cache dependency for stats caching
  },
  contexts: ["workspace", "analytics"], // Request runtime contexts
  capabilities: {
    search: true,
    custom: {
      offline: true,

      stats: true,
    },
  },
  configSchema: {
    baseDir: {
      type: "string",
      description: "Base directory for analytics logs (default: <KB_HOME>/state/<projectId>/analytics/buffer)",
    },
    filenamePattern: {
      type: "string",
      default: "events-YYYYMMDD",
      description: "Filename pattern (without extension)",
    },
  },
};
