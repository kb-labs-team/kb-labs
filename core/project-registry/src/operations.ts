/**
 * @module @kb-labs/core-project-registry/operations
 *
 * The project operations behind `kb project *` and the host API
 * (`/api/v1/projects`). Both front ends call these functions, so the terminal
 * and Studio cannot diverge: same validation, same registry writes, same
 * failures (`ProjectRegistryError` with a catalog code).
 *
 * Nothing here prints, prompts or shapes a transport response; callers own
 * that. Removal has no wrapper on purpose: `IProjectRegistry.remove` already is
 * the operation, and confirmation is a front-end concern (the CLI asks, Studio
 * shows a dialog).
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { initWorkspaceConfig } from '@kb-labs/core-config';
import type { IProjectRegistry, ProjectRecord, ProjectSummary, ProjectView } from '@kb-labs/core-contracts';
import { ProjectRegistryError } from './errors.js';
import { canonicalizeProjectPath } from './project-id.js';

/** Flattens a registry view into the summary shown by `kb project` and the host API. */
export function toProjectSummary(view: ProjectView): ProjectSummary {
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

export async function listProjects(registry: IProjectRegistry): Promise<ProjectSummary[]> {
  return (await registry.list()).map(toProjectSummary);
}

/** Looks a project up by id, name or path. Throws `KB_PROJECT_UNKNOWN` when absent. */
export async function showProject(registry: IProjectRegistry, ref: string): Promise<ProjectSummary> {
  return toProjectSummary(await registry.get(ref));
}

export interface AddProjectRequest {
  /** Folder to register; resolved against `cwd` when relative. */
  path: string;
  /** Base for a relative `path`. Defaults to the process cwd. */
  cwd?: string;
  /** Alias; defaults to the folder name. */
  name?: string;
  /** Create the minimal `.kb/` when the folder has none. */
  init?: boolean;
  /** Validate and report what would happen; write nothing. */
  dryRun?: boolean;
}

export type AddProjectOutcome =
  /** The folder has no `.kb/` and `init` was not requested; nothing was registered. */
  | { status: 'initialization-required'; path: string }
  | { status: 'planned'; project: ProjectRecord; wouldInitialize: boolean }
  | { status: 'added'; project: ProjectRecord; initialized: boolean; created: string[] };

async function hasKbDir(projectPath: string): Promise<boolean> {
  try {
    return (await fs.stat(join(projectPath, '.kb'))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Registers a project folder. A folder that already has `.kb/` is picked up
 * as-is; a folder without one is never modified silently: the outcome is
 * `initialization-required` unless `init` is set.
 */
export async function addProject(registry: IProjectRegistry, request: AddProjectRequest): Promise<AddProjectOutcome> {
  const canonical = await canonicalizeProjectPath(resolve(request.cwd ?? process.cwd(), request.path));
  const declared = await hasKbDir(canonical);

  if (!declared && !request.init) {
    return { status: 'initialization-required', path: canonical };
  }

  // Validate the registration (duplicate, name) before touching the folder.
  const planned = await registry.add(canonical, { name: request.name, dryRun: true });
  const needsInit = !declared;

  let created: string[] = [];
  if (needsInit) {
    // initWorkspaceConfig looks upward for an existing config; never let it edit a parent's.
    const probe = await initWorkspaceConfig({ cwd: canonical, dryRun: true });
    const escapes = probe.actions.some((action) => {
      const rel = relative(join(canonical, '.kb'), resolve(action.path));
      return rel.startsWith('..') || isAbsolute(rel);
    });
    if (escapes) {
      throw new ProjectRegistryError(
        'KB_RUNTIME_INPUT_INVALID',
        'An enclosing folder already owns a .kb/ configuration; initializing here would modify it.',
      );
    }
    if (!request.dryRun) {
      created = (await initWorkspaceConfig({ cwd: canonical })).created;
    }
  }

  if (request.dryRun) {
    return { status: 'planned', project: planned.project, wouldInitialize: needsInit };
  }

  const { project } = await registry.add(canonical, { name: request.name });
  return { status: 'added', project, initialized: needsInit, created };
}
