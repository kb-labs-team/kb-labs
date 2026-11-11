/**
 * Git analyzer module
 * @module @kb-labs/commit/core/analyzer
 */

export {
  getGitStatus,
  getAllChangedFiles,
  hasChanges,
  getCurrentBranch,
  isProtectedBranch,
} from "./git-status";

export { getFileSummaries, getFileDiffs, formatFileSummary } from "./file-summary";

export { getFileDiff, type FileDiff } from "./file-diff";

export { getRecentCommits, detectCommitStyle } from "./recent-commits";

export {
  resolveScope,
  matchesScope,
  type ResolvedScope,
  type PackageInfo,
} from "./scope-resolver";

export {
  isSecretFile,
  containsSecrets,
  detectSecretFiles,
  detectSecretsInDiffs,
  formatSecretsWarning,
  SecretsDetectedError,
  isSecretsDetectedError,
  detectSecretsWithLocation,
  formatSecretsReport,
  type SecretMatch,
} from "./secrets-detector";
