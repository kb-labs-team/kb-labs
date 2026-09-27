/**
 * Shared helpers for `kb project *`: registry access (KB_HOME aware, works
 * directly against the file because there is no host yet) and printing of
 * failures as the unified error envelope (08-errors.md; built by `projectErrorEnvelope`).
 */

import { resolve } from 'node:path';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import type { ErrorEnvelope } from '@kb-labs/core-platform';
import { createProjectRegistry } from '@kb-labs/core-project-registry';

export function openRegistry() {
  return createProjectRegistry({ env: process.env });
}

/**
 * Turns a positional argument into a registry reference. No argument means the
 * current folder; path-looking values are anchored at the command cwd; ids and
 * names pass through verbatim.
 */
export function projectRef(arg: string | undefined, cwd: string): string {
  if (arg === undefined) {
    return cwd;
  }
  return arg.startsWith('.') || arg.includes('/') || arg.includes('\\') ? resolve(cwd, arg) : arg;
}

type Ui = PluginContextV3['ui'];

/** Prints an envelope (JSON: one object; human: message, hint, code) and returns the failure result. */
export function failWithEnvelope(ui: Ui | undefined, envelope: ErrorEnvelope, json: boolean) {
  if (json) {
    ui?.json({ ok: false, error: envelope });
  } else {
    ui?.error(`${envelope.message} [${envelope.code}]`);
    ui?.write(`Hint: ${envelope.hint}\n`);
  }
  return { ok: false as const, error: envelope.message, result: { envelope } };
}
