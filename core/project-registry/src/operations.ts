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

import { resolve } from 'node:path';
import type {
  ProjectRecord,
  ProjectSummary,
  ProjectView,
} from '@kb-labs/core-contracts';
import type { PlatformDiagnostic } from '@kb-labs/core-platform';
import type { IProjectRegistry } from './interface.js';
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

export async function listProjects(registry: IProjectRegistry): Promise<{
  projects: ProjectSummary[];
  diagnostics: PlatformDiagnostic[];
}> {
  const result = await registry.list();
  return { projects: result.projects.map(toProjectSummary), diagnostics: result.diagnostics };
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
  /** Validate and report what would happen; write nothing. */
  dryRun?: boolean;
}

export type AddProjectOutcome =
  | { status: 'planned'; project: ProjectRecord; alreadyExisted: boolean }
  | { status: 'added'; project: ProjectRecord; alreadyExisted: boolean };

/**
 * Registers a project folder by canonical path. Registration never inspects
 * or modifies files in the project repository.
 */
export async function addProject(registry: IProjectRegistry, request: AddProjectRequest): Promise<AddProjectOutcome> {
  const canonical = await canonicalizeProjectPath(resolve(request.cwd ?? process.cwd(), request.path));
  const planned = await registry.add(canonical, { name: request.name, dryRun: true });
  if (request.dryRun) {
    return { status: 'planned', project: planned.project, alreadyExisted: planned.alreadyExisted };
  }

  const committed = await registry.add(canonical, { name: request.name });
  return { status: 'added', project: committed.project, alreadyExisted: committed.alreadyExisted };
}
