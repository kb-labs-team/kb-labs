/**
 * @module @kb-labs/adapters-openai/embeddings-manifest
 * Adapter manifest for OpenAI embeddings.
 */

import type { AdapterManifest } from "@kb-labs/sdk/adapters";

/**
 * Adapter manifest for OpenAI embeddings.
 */
export const manifest: AdapterManifest = {
  schema: 'kb.adapter/1',
  manifestVersion: "1.0.0",
  id: "openai-embeddings",
  name: "OpenAI Embeddings",
  version: "1.0.0",
  description:
    "OpenAI text embeddings adapter (text-embedding-3-small, text-embedding-3-large, etc.)",
  author: "KB Labs",
  license: "MIT",
  type: "core",
  implements: "IEmbeddings",
  networkRequired: true,
  capabilities: {
    batch: true,
  },
  configSchema: {
    apiKey: {
      type: "string",
      secret: true,
      env: "OPENAI_API_KEY",
      required: true,
      description: "OpenAI API key (defaults to OPENAI_API_KEY env var)",
      doctor: [{
        slot: "embeddings",
        id: "openai.embeddings.apiKey",
        optional: true,
        severity: "warning",
        services: ["gateway"],
        action: "set OPENAI_API_KEY to enable embeddings",
        hint: "Set OPENAI_API_KEY or run kb config set --scope platform platform.adapterOptions.embeddings.apiKey '${OPENAI_API_KEY}' --allow-missing-env",
      }],
    },
    model: {
      type: "string",
      default: "text-embedding-3-small",
      description: "Embedding model to use",
      enum: [
        "text-embedding-3-small",
        "text-embedding-3-large",
        "text-embedding-ada-002",
      ],
    },
    dimensions: {
      type: "number",
      description: "Number of dimensions (for v3 models)",
    },
  },
};
