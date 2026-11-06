/**
 * @module @kb-labs/adapters-openai/embeddings
 * OpenAI implementation of IEmbeddings interface.
 */

import OpenAI from "openai";
import { AdapterCredentialsMissingError } from "@kb-labs/sdk";
import type { IEmbeddings } from "@kb-labs/sdk/adapters";

/**
 * Supported OpenAI embedding models and their dimensions.
 */
export const EMBEDDING_MODELS = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
} as const;

export type EmbeddingModel = keyof typeof EMBEDDING_MODELS;

/**
 * Configuration for OpenAI embeddings adapter.
 */
export interface OpenAIEmbeddingsConfig {
  /** OpenAI API key (defaults to OPENAI_API_KEY env var) */
  apiKey?: string;
  /** Base URL for API (optional, for proxies or Azure) */
  baseURL?: string;
  /** Embedding model to use */
  model?: EmbeddingModel;
  /** Organization ID (optional) */
  organization?: string;
}

/**
 * OpenAI implementation of IEmbeddings interface.
 */
export class OpenAIEmbeddings implements IEmbeddings {
  private client: OpenAI;
  private model: EmbeddingModel;
  private readonly hasApiKey: boolean;
  readonly dimensions: number;

  constructor(config: OpenAIEmbeddingsConfig = {}) {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    this.hasApiKey = typeof apiKey === "string" && apiKey.length > 0;
    this.client = new OpenAI({
      apiKey: apiKey ?? "missing-openai-api-key",
      baseURL: config.baseURL,
      organization: config.organization,
    });
    this.model = config.model ?? "text-embedding-3-small";
    this.dimensions = EMBEDDING_MODELS[this.model];
  }

  async embed(text: string): Promise<number[]> {
    this.assertCredentials();
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });

    const first = response.data[0];
    if (!first) {
      throw new Error("OpenAI embeddings API returned empty response");
    }
    return first.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    this.assertCredentials();

    // OpenAI supports batching natively
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });

    // Sort by index to maintain order
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map((item) => item.embedding);
  }

  /**
   * Get the dimensions of the embeddings.
   * This method is needed for IPC/Unix Socket transport to access the dimensions property.
   */
  async getDimensions(): Promise<number> {
    return this.dimensions;
  }

  private assertCredentials(): void {
    if (!this.hasApiKey) {
      throw new AdapterCredentialsMissingError(
        "embeddings",
        "OPENAI_API_KEY",
        "platform.adapterOptions.embeddings.apiKey",
      );
    }
  }
}

/**
 * Create OpenAI embeddings adapter.
 * This is the factory function called by initPlatform() when loading adapters.
 */
export function createAdapter(
  config?: OpenAIEmbeddingsConfig,
): OpenAIEmbeddings {
  return new OpenAIEmbeddings(config);
}


// Re-export manifest for adapter loading
export { manifest } from "./embeddings-manifest.js";

// Default export for direct import
export default createAdapter;
