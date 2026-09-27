import type { ILogger } from './logger.js';
import type { ILLM } from './llm.js';
import {
  LLM_CAPABILITIES,
  type ILLMRouter,
  type LLMCapability,
  type LLMRouterMetadata,
  type LLMTier,
} from './llm-types.js';

/**
 * Create the non-secret model routing snapshot needed by isolated plugin
 * workers. Provider credentials and adapter options remain in the host.
 */
export async function getLLMRouterMetadata(
  llm: ILLM | undefined,
  logger?: Pick<ILogger, 'debug'>,
): Promise<LLMRouterMetadata | undefined> {
  if (!llm) { return undefined; }
  const router = llm as ILLM & Partial<ILLMRouter>;
  if (
    typeof router.getConfiguredTier !== 'function' ||
    typeof router.resolveAdapter !== 'function' ||
    typeof router.supportsCapabilities !== 'function' ||
    typeof router.getCapabilities !== 'function'
  ) {
    return undefined;
  }

  const tiers: LLMTier[] = ['small', 'medium', 'large'];
  const tierMapping: NonNullable<LLMRouterMetadata['tierMapping']> = {};
  for (const tier of tiers) {
    try {
      const binding = await router.resolveAdapter({ tier });
      const capabilities = (Object.keys(LLM_CAPABILITIES) as LLMCapability[]).filter(
        (capability) => router.supportsCapabilities?.({ tier, capabilities: [capability] }),
      );
      tierMapping[tier] = [{ model: binding.model, priority: 1, capabilities }];
    } catch {
      // Omit unavailable tiers; the worker will surface normal preflight errors.
    }
  }

  const metadata: LLMRouterMetadata = {
    defaultTier: router.getConfiguredTier(),
    tierMapping,
    capabilities: router.getCapabilities(),
  };
  logger?.debug('Forwarding sanitized LLM routing metadata to plugin worker', {
    defaultTier: metadata.defaultTier,
    tiers: Object.keys(metadata.tierMapping ?? {}),
    capabilities: metadata.capabilities,
  });
  return metadata;
}
