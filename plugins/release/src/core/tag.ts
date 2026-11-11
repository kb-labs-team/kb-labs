/**
 * Git tag grammar for release flows — one place that both generates a
 * flow's release tag and parses a tag back into a flow. Keeping generation
 * and resolution on the same template prevents them from drifting apart
 * (previously tag-building was inlined ad hoc in `commitAndTagRelease` and
 * nothing parsed a tag back into a flow at all — CI guessed via bash).
 *
 * Only stable-channel releases ever produce a git tag (canary is ephemeral,
 * npm-only — see pipeline.ts), so a resolved tag always implies `channel:
 * 'stable'`; it is never inferred from the tag itself.
 */

import type { ReleaseChannel, ReleaseConfig } from './types';

export const DEFAULT_TAG_PATTERN = '{flow}-v{version}';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches a bare semver, optionally with a prerelease/build suffix. */
const SEMVER_SRC = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?';

/**
 * Build the release tag for a flow. `tagPattern` defaults to
 * `{flow}-v{version}` (e.g. `platform-v2.105.0`) when omitted.
 */
export function buildReleaseTag(flowName: string, version: string, tagPattern?: string): string {
  const pattern = tagPattern ?? DEFAULT_TAG_PATTERN;
  return pattern.replace('{flow}', flowName).replace('{version}', version);
}

/**
 * Anchored regex matching exactly the tags `buildReleaseTag(flowName, ...,
 * tagPattern)` can produce — literal segments of the pattern are escaped,
 * `{flow}` is substituted with the (escaped) flow name, `{version}` with a
 * semver-capturing group.
 */
function buildTagRegex(flowName: string, tagPattern: string): RegExp {
  const escapedPattern = escapeRegex(tagPattern);
  const src = escapedPattern
    .replace(escapeRegex('{flow}'), escapeRegex(flowName))
    .replace(escapeRegex('{version}'), `(${SEMVER_SRC})`);
  return new RegExp(`^${src}$`);
}

/**
 * Resolve a git tag back into the flow (and channel) that produced it, by
 * matching it against every configured flow's tag pattern. Returns `null`
 * if no configured flow's pattern matches — callers (e.g. `deliver`) must
 * treat that as a hard failure, never a guess.
 */
export function resolveFlowFromTag(
  config: ReleaseConfig,
  tag: string,
): { flowName: string; channel: ReleaseChannel } | null {
  const flows = config.flows ?? {};
  for (const [flowName, flowConfig] of Object.entries(flows)) {
    const regex = buildTagRegex(flowName, flowConfig.tagPattern ?? DEFAULT_TAG_PATTERN);
    if (regex.test(tag)) {
      return { flowName, channel: 'stable' };
    }
  }
  return null;
}
