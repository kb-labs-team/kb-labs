// Discovery
export {
  discoverMonorepos,
  buildPackageMap,
  buildPackageMapFiltered,
  analyzePackageDeps,
  resolvePackageMonorepo,
  type MonorepoInfo,
} from './discovery/index.js';

// Npm
export { isPublishedOnNpm, filterPublishedPackages } from './npm/index.js';

// Plan
export {
  buildPlan,
  describeChange,
  groupByMonorepo,
} from './plan/index.js';

// Apply
export {
  applyPlan,
  checkGitDirty,
  type ApplyOptions,
  type ApplyResult,
} from './apply/index.js';

// State
export {
  loadState,
  saveState,
  freeze,
  loadLock,
  type LockFile,
} from './state/index.js';

// Backup
export {
  createBackup,
  listBackups,
  getLastBackup,
  restoreBackup,
  pruneBackups,
} from './backup/index.js';

// Workspace YAML
export {
  updateWorkspaceYamls,
  type WorkspaceYamlUpdate,
} from './workspace-yaml/index.js';

// Diagnostics
export {
  diagnose,
} from './diagnostics/index.js';
