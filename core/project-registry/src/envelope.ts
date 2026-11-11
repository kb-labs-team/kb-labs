/**
 * @module @kb-labs/core-project-registry/envelope
 *
 * Renders project failures as the unified error envelope (ADR-0049). Shared by
 * `kb project *` and the host API so both report the same code, message and
 * hint for the same failure.
 */

import { homedir } from 'node:os';
import { createCatalogErrorEnvelope, toErrorEnvelope, type ErrorEnvelope } from '@kb-labs/core-platform';
import { isProjectRegistryError } from './errors.js';

/** Replaces the active process HOME prefix with `~` so envelopes never carry fixture or user home paths. */
function redactHome(value: string): string {
  const home = process.env.HOME?.trim() || homedir();
  return home.length > 1 ? value.split(home).join('~') : value;
}

/** A registry failure keeps its catalog code; anything else becomes the generic unexpected-error envelope. */
export function projectErrorEnvelope(error: unknown): ErrorEnvelope {
  if (isProjectRegistryError(error)) {
    const request = structuredClone(error.request);
    const details = request.details;
    for (const [key, value] of Object.entries(details)) {
      Object.defineProperty(details, key, { value: redactHome(value), writable: true, enumerable: true, configurable: true });
    }
    return createCatalogErrorEnvelope(request);
  }
  return toErrorEnvelope(error);
}
