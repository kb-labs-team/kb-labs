/**
 * The single place the plugin touches platform hooks.
 *
 * Assembles `MindServices` from `@kb-labs/sdk` hooks and resolves the plugin
 * config. CLI commands and REST handlers both call `buildMind(...)` so they
 * drive the exact same engine.
 */

import {
  useVectorStore,
  useEmbeddings,
  useStorage,
  useCache,
  useLLM,
  useLogger,
  useConfig,
} from '@kb-labs/sdk';
import { createMind, type Mind, type MindServices } from './core/index.js';
import { resolveMindConfig, type MindConfigInput } from './contracts/index.js';

/** Build MindServices from platform hooks, failing fast on missing required adapters. */
export function buildServices(): MindServices {
  const vectorStore = useVectorStore();
  const embeddings = useEmbeddings();
  const storage = useStorage();
  const cache = useCache();
  const llm = useLLM();
  const logger = useLogger();

  const missing: string[] = [];
  if (!vectorStore) {
    missing.push('vectorStore');
  }
  if (!embeddings) {
    missing.push('embeddings');
  }
  if (!storage) {
    missing.push('storage');
  }
  if (!cache) {
    missing.push('cache');
  }
  if (!llm) {
    missing.push('llm');
  }
  if (missing.length > 0) {
    throw new Error(
      `mind: required platform adapters not configured: ${missing.join(', ')}. ` +
        `Configure them in .kb/kb.config.json under "adapters".`,
    );
  }

  return { vectorStore: vectorStore!, embeddings: embeddings!, storage: storage!, cache: cache!, llm: llm!, logger };
}

/** Resolve the plugin config from the `mind` config section. */
export async function loadConfig() {
  const raw = await useConfig<MindConfigInput>();
  return resolveMindConfig(raw ?? {});
}

/**
 * Convenience: build the Mind facade (services + config) in one call.
 * `cwd` is the workspace root source paths resolve against (from `ctx.cwd`).
 */
export async function buildMind(cwd?: string): Promise<Mind> {
  return createMind(buildServices(), await loadConfig(), { cwd: cwd ?? process.cwd() });
}
