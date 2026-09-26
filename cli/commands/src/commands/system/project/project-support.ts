/**
 * Shared helpers for `kb project *`: registry access (KB_HOME aware, works
 * directly against the file because there is no host yet) and rendering of
 * failures as the unified error envelope (08-errors.md).
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import type { ProjectView } from '@kb-labs/core-contracts';
import { createErrorEnvelope, toErrorEnvelope, type ErrorEnvelope } from '@kb-labs/core-platform';
import { createProjectRegistry, isProjectRegistryError } from '@kb-labs/core-project-registry';

export function openRegistry() {
  return createProjectRegistry({ env: process.env });
}

/** Replaces the home directory prefix with `~` so envelopes never carry it. */
function redactHome(value: string): string {
  const home = homedir();
  return home.length > 1 ? value.split(home).join('~') : value;
}

export function toProjectEnvelope(error: unknown): ErrorEnvelope {
  if (isProjectRegistryError(error)) {
    const details = Object.fromEntries(Object.entries(error.details).map(([k, v]) => [k, redactHome(v)]));
    return createErrorEnvelope(error.code, { cause: redactHome(error.message), details });
  }
  return toErrorEnvelope(error);
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

export interface ProjectRow {
  id: string;
  name: string;
  status: string;
  declaration: string;
  pathExists: boolean;
  addedAt: string;
  lastUsedAt: string | null;
  path: string;
  stateDir: string;
}

export function toRow(view: ProjectView): ProjectRow {
  const { project } = view;
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    declaration: view.declaration,
    pathExists: view.pathExists,
    addedAt: project.addedAt,
    lastUsedAt: project.lastUsedAt,
    path: project.path,
    stateDir: view.stateDir,
  };
}
