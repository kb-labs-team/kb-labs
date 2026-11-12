/**
 * @module @kb-labs/adapters-vibeproxy/manifest
 * Adapter manifest for VibeProxy LLM.
 */

import type { AdapterManifest } from "@kb-labs/sdk/adapters";

export const VIBEPROXY_MODEL_CONFIG_KEY = 'model' as const;

/**
 * Adapter manifest for VibeProxy LLM.
 */
export const manifest: AdapterManifest = {
  schema: 'kb.adapter/1',
  manifestVersion: "1.0.0",
  id: "@kb-labs/adapters-vibeproxy",
  name: "VibeProxy LLM",
  version: "2.120.1",
  description:
    "VibeProxy local adapter supporting multiple LLM providers",
  author: "KB Labs Team",
  license: "KBPL-1.1",
  type: "core",
  implements: "ILLM",
  networkRequired: true,
  capabilities: {
    streaming: false, // TODO: implement SSE streaming
    custom: {
      functionCalling: true,
      multiProvider: true,
    },
  },
  configSchema: {
    baseURL: {
      type: "string",
      default: "http://localhost:8317",
      description: "VibeProxy server URL",
    },
    apiKey: {
      type: "string",
      default: "any-string",
      description: "API key (any string works for local VibeProxy)",
    },
    [VIBEPROXY_MODEL_CONFIG_KEY]: {
      type: "string",
      required: true,
      description: "Required model identifier selected for this platform",
    },
    timeout: {
      type: "number",
      default: 120000,
      description: "Request timeout in milliseconds",
    },
  },
};
