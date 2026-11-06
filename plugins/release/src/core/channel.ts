/**
 * Resolve the npm dist-tag and target registry for a release channel.
 *
 * Shared by CLI (run.ts), REST (run-handler.ts) and the pipeline itself so
 * "canary always goes to real npm under a canary tag, stable uses whatever
 * config.registry says" is defined once, config-driven, not hardcoded at
 * each call site.
 */
import type { ReleaseChannel, ReleaseConfig } from './types';

const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

export function resolvePublishTag(config: ReleaseConfig, channel: ReleaseChannel): string {
  if (channel === 'canary') {
    return config.publish?.canaryTag ?? 'canary';
  }
  return config.publish?.stableTag ?? 'latest';
}

export function resolvePublishRegistry(config: ReleaseConfig, channel: ReleaseChannel): string {
  if (channel === 'canary') {
    // Canary never reads config.registry (that's the stable/Verdaccio target) —
    // a stale Verdaccio registry override must not swallow a canary publish.
    return config.publish?.npmRegistry ?? DEFAULT_NPM_REGISTRY;
  }
  return config.registry ?? DEFAULT_NPM_REGISTRY;
}
