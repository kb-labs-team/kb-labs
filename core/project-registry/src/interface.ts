import type { PlatformDiagnostic } from '@kb-labs/core-platform';
import type { AddProjectOptions, AddProjectResult, ProjectId, ProjectRecord, ProjectView } from '@kb-labs/core-contracts';

/** Valid project records and catalogue diagnostics from a registry read. */
export interface ProjectRegistryList {
  projects: ProjectView[];
  diagnostics: PlatformDiagnostic[];
}

/** Runtime-facing project registry contract, including path resolution. */
export interface IProjectRegistry {
  readonly root: string;
  readonly filePath: string;
  add(path: string, options?: AddProjectOptions): Promise<AddProjectResult>;
  list(): Promise<ProjectRegistryList>;
  get(ref: string): Promise<ProjectView>;
  remove(ref: string): Promise<ProjectRecord>;
  touch(ref: string): Promise<ProjectRecord>;
  stateDir(id: ProjectId): string;
  findContainingPath(cwd: string): Promise<ProjectView | undefined>;
}
