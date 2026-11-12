export {
  findRegisteredProjectRoot,
  resolvePlatformRoot,
  resolveProjectRoot,
  resolveRoots,
  resolveWorkspaceRoot,
} from './workspace/root-resolver'

export type {
  PlatformRootResolution,
  PlatformRootSource,
  ProjectRootResolution,
  ProjectRootSource,
  ResolvePlatformRootOptions,
  ResolveProjectRootOptions,
  ResolveRootsOptions,
  ResolveWorkspaceRootOptions,
  RootsResolution,
  WorkspaceFs,
  WorkspaceRootResolution,
} from './workspace/types'
