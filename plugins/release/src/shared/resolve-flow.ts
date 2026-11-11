/**
 * Shared `--release-tag` / `--flow` resolution for commands that operate
 * on an already-decided release (`stage`, `deliver`) — mirrors the tag
 * grammar in `@kb-labs/release/core`'s `resolveFlowFromTag` so CI
 * can pass just the tag and the plugin decides the flow, per the
 * "plugin prepares, CI delivers" release plan.
 */

import { resolveFlowFromTag, type ReleaseConfig } from '../core/index.js';

export interface FlowResolvableFlags {
  flow?: string;
  'release-tag'?: string;
}

export function resolveFlowName(config: ReleaseConfig, flags: FlowResolvableFlags): string | { error: string } {
  if (flags.flow) { return flags.flow; }
  if (flags['release-tag']) {
    const resolved = resolveFlowFromTag(config, flags['release-tag']);
    if (!resolved) {
      return { error: `Could not resolve a release.flows entry from tag "${flags['release-tag']}"` };
    }
    return resolved.flowName;
  }
  return { error: 'requires --flow or --release-tag' };
}
