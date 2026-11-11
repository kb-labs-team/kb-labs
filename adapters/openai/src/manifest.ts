/**
 * @module @kb-labs/adapters-openai/manifest
 * Adapter manifest for OpenAI LLM.
 */

import type { AdapterManifest } from "@kb-labs/sdk/adapters";
import { DEFAULT_OPENAI_MODEL } from "./openai-defaults.js";

/**
 * Adapter manifest for OpenAI LLM.
 */
export const manifest: AdapterManifest = {
  schema: 'kb.adapter/1',
  manifestVersion: "1.0.0",
  id: "openai-llm",
  name: "OpenAI LLM",
  version: "1.0.0",
  description: "OpenAI language model adapter (GPT-4, GPT-3.5, etc.)",
  author: "KB Labs Team",
  license: "KBPL-1.1",
  type: "core",
  implements: ["ILLM", "IEmbeddings"],
  networkRequired: true,
  defaultFor: { llm: ["llm"], embeddings: ["embeddings"] },
  capabilities: {
    streaming: true,
    custom: {
      functionCalling: true,
    },
  },
  configSchema: {
    apiKey: {
      type: "string",
      required: true,
      secret: true,
      env: "OPENAI_API_KEY",
      description: "OpenAI API key (defaults to OPENAI_API_KEY env var)",
      doctor: [
        {
          slot: "llm",
          id: "openai.apiKey",
          optional: true,
          severity: "warning",
          services: ["gateway"],
          action: "set OPENAI_API_KEY to enable LLM features",
          hint: "Set OPENAI_API_KEY or run kb config set --scope platform platform.adapterOptions.llm.apiKey '${OPENAI_API_KEY}' --allow-missing-env",
        },
        {
          slot: "embeddings",
          id: "openai.embeddings.apiKey",
          optional: true,
          severity: "warning",
          services: ["gateway"],
          action: "set OPENAI_API_KEY to enable embeddings",
          hint: "Set OPENAI_API_KEY or run kb config set --scope platform platform.adapterOptions.embeddings.apiKey '${OPENAI_API_KEY}' --allow-missing-env",
        },
      ],
    },
    model: {
      type: "string",
      default: DEFAULT_OPENAI_MODEL,
      description: "Model to use (gpt-4o, gpt-4-turbo, gpt-3.5-turbo, etc.)",
    },
    temperature: {
      type: "number",
      default: 0.7,
      description: "Sampling temperature (0.0 to 2.0)",
    },
    maxTokens: {
      type: "number",
      description: "Maximum tokens to generate",
    },
  },
};
