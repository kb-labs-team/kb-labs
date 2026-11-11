import { describe, it, expect } from 'vitest';
import { buildReleaseTag, resolveFlowFromTag, DEFAULT_TAG_PATTERN } from '../../src/core/tag';
import type { ReleaseConfig } from '../../src/core/types';

describe('buildReleaseTag', () => {
  it('defaults to {flow}-v{version}', () => {
    expect(buildReleaseTag('platform', '2.105.0')).toBe('platform-v2.105.0');
    expect(buildReleaseTag('sdk', '3.2.0')).toBe('sdk-v3.2.0');
  });

  it('honors a custom tagPattern', () => {
    expect(buildReleaseTag('platform', '2.105.0', 'release/{flow}/{version}')).toBe('release/platform/2.105.0');
  });

  it('DEFAULT_TAG_PATTERN matches the documented default', () => {
    expect(DEFAULT_TAG_PATTERN).toBe('{flow}-v{version}');
  });
});

describe('resolveFlowFromTag', () => {
  const config: ReleaseConfig = {
    flows: {
      platform: { packages: { exclude: ['@kb-labs/sdk'] } },
      sdk: { versioningStrategy: 'independent', packages: { include: ['@kb-labs/sdk'] } },
    },
  };

  it('resolves a lockstep-flow tag', () => {
    expect(resolveFlowFromTag(config, 'platform-v1.2.3')).toEqual({ flowName: 'platform', channel: 'stable' });
  });

  it('resolves an independent-flow tag', () => {
    expect(resolveFlowFromTag(config, 'sdk-v3.2.0')).toEqual({ flowName: 'sdk', channel: 'stable' });
  });

  it('never matches a binaries-style tag — binaries is not a release.flows entry', () => {
    expect(resolveFlowFromTag(config, 'v0.4.0-binaries')).toBeNull();
  });

  it('returns null for a tag matching no configured flow', () => {
    expect(resolveFlowFromTag(config, 'not-a-real-flow-v1.0.0')).toBeNull();
  });

  it('disambiguates flows whose names are prefixes of one another via the anchored regex', () => {
    const adversarial: ReleaseConfig = {
      flows: {
        core: { packages: { include: ['@kb-labs/core'] } },
        'core-utils': { packages: { include: ['@kb-labs/core-utils'] } },
      },
    };
    expect(resolveFlowFromTag(adversarial, 'core-v1.0.0')).toEqual({ flowName: 'core', channel: 'stable' });
    expect(resolveFlowFromTag(adversarial, 'core-utils-v1.0.0')).toEqual({ flowName: 'core-utils', channel: 'stable' });
  });

  it('returns null when config.flows is empty or missing', () => {
    expect(resolveFlowFromTag({}, 'platform-v1.0.0')).toBeNull();
  });
});
