/**
 * Project registry data source (stage 6, first slice: "add project -> see
 * it"). Backed by the host's `/api/v1/projects` API, which runs the same
 * operations as `kb project *` (ADR-0044).
 */

import type { ProjectEntry } from '@kb-labs/core-contracts';

export interface AddProjectParams {
  /** Absolute (or host-cwd-relative) folder path. */
  path: string;
  /** Alias; defaults to the folder name. */
  name?: string;
  title?: string;
  description?: string;
  /** Create the minimal `.kb/` when the folder has none. */
  init?: boolean;
}

export interface UpdateProjectParams {
  path?: string;
  title?: string;
  description?: string;
}

export interface ProjectsDataSource {
  pickFolder(): Promise<string | null>;
  listProjects(): Promise<ProjectEntry[]>;
  getProject(id: string): Promise<ProjectEntry>;
  addProject(params: AddProjectParams): Promise<ProjectEntry>;
  updateProject(id: string, params: UpdateProjectParams): Promise<ProjectEntry>;
  removeProject(id: string): Promise<{ id: string }>;
}
