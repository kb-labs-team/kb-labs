/**
 * @module @kb-labs/core-project-registry/envelope
 *
 * Renders project failures as the unified error envelope (ADR-0049). Shared by
 * `kb project *` and the host API so both report the same code, message and
 * hint for the same failure.
 */

import { homedir } from 'node:os';
import { createErrorEnvelope, toErrorEnvelope, type ErrorEnvelope } from '@kb-labs/core-platform';
import { isProjectRegistryError } from './errors.js';

/** Replaces the home directory prefix with `~` so envelopes never carry it. */
function redactHome(value: string): string {
  const home = homedir();
  return home.length > 1 ? value.split(home).join('~') : value;
}

/** A registry failure keeps its catalog code; anything else becomes the generic unexpected-error envelope. */
export function projectErrorEnvelope(error: unknown): ErrorEnvelope {
  if (isProjectRegistryError(error)) {
    const details = Object.fromEntries(Object.entries(error.details).map(([k, v]) => [k, redactHome(v)]));
    return createErrorEnvelope(error.code, { cause: redactHome(error.message), details });
  }
  return toErrorEnvelope(error);
}
