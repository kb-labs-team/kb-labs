import { createErrorEnvelope, type ErrorEnvelope } from '@kb-labs/core-platform';

/**
 * A plugin resolved a platform package to a copy outside the platform and the
 * host has no copy to substitute, so the plugin would run against a second,
 * private platform. Carries the `KB_PLUGIN_PLATFORM_DUPLICATE` envelope.
 */
export class PlatformDuplicateError extends Error {
  readonly code = 'KB_PLUGIN_PLATFORM_DUPLICATE';
  readonly envelope: ErrorEnvelope;

  constructor(details: { plugin: string; package: string; ownCopy: string; requester: string }) {
    const envelope = createErrorEnvelope('KB_PLUGIN_PLATFORM_DUPLICATE', {
      cause: `"${details.requester}" resolved ${details.package} to ${details.ownCopy}, outside the platform, and the host has no copy of it.`,
      details,
    });
    super(`${envelope.code}: ${envelope.message} ${envelope.hint}`);
    this.name = 'PlatformDuplicateError';
    this.envelope = envelope;
  }
}
