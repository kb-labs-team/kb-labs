/**
 * Core types for @kb-labs/release/changelog
 */

export type VersionBump = 'patch' | 'minor' | 'major' | 'none';

export type CommitType = 'feat' | 'fix' | 'perf' | 'refactor' | 'docs' | 'build' | 'ci' | 'test' | 'chore' | 'revert' | 'style';

export interface Author {
  name: string;
  email: string;
}

export interface BreakingChange {
  summary: string;
  notes?: string;
}

export interface Reference {
  type: 'pr' | 'issue' | 'commit';
  id: string;
  url?: string;
}

export interface Change {
  sha: string;
  type: CommitType;
  scope?: string;
  subject: string;
  body?: string;
  breaking?: BreakingChange[];
  refs: Reference[];
  author: Author;
  coAuthors: Author[];
  packages: string[];  // affected package names
  filesChanged: string[];
  timestamp: string;  // authorDate ISO
  isMerge?: boolean;
  isRevert?: boolean;
  revertOf?: string;  // SHA if this is a revert
  cherryPickOf?: string;  // SHA if this is a cherry-pick
  providerLinks?: {
    commit?: string;
    pr?: string[];
    issues?: string[];
  };
}

export interface PackageRelease {
  name: string;
  prev: string;
  next: string;
  bump: VersionBump;
  reason: 'breaking' | 'feat' | 'fix' | 'perf' | 'ripple' | 'manual';
  rippleFrom?: string[];  // Source packages for ripple policy
  breaking: BreakingChange[];
  changes: Change[];
}

export interface ReleaseManifest {
  schemaVersion: '1.0';
  range: { from: string; to: string };
  timestamp: string;
  packages: PackageRelease[];
  workspace: {
    breakingCount: number;
    byType: Record<string, number>;
  };
  integrity?: {
    'CHANGELOG.md'?: string;  // sha256 hash
    'release.plan.json'?: string;
  };
}

export interface ChangelogResult {
  manifest: ReleaseManifest;
  markdown: string;
  hasBreaking: boolean;
}

export interface ParseOptions {
  cwd: string;
  from: string;
  to?: string;
  packagePath?: string;
  ignoreAuthors?: string[];
  includeTypes?: string[];
  excludeTypes?: string[];
  collapseMerges?: boolean;
  collapseReverts?: boolean;
  preferMergeSummary?: boolean;
}

export interface ChangelogOptions {
  cwd: string;
  from: string;
  to?: string;
  plan?: unknown;  // ReleasePlan from @kb-labs/release/core
  format?: 'json' | 'md' | 'both';
  level?: 'compact' | 'standard' | 'detailed';
  breakingOnly?: boolean;
  includeTypes?: string[];
  excludeTypes?: string[];
  workspace?: boolean;
  perPackage?: boolean;
  config?: ChangelogConfig;
}

export interface ChangelogConfig {
  enabled?: boolean;
  includeTypes?: string[];
  excludeTypes?: string[];
  ignoreAuthors?: string[];
  scopeMap?: Record<string, string>;
  collapseMerges?: boolean;
  collapseReverts?: boolean;
  preferMergeSummary?: boolean;
  bumpStrategy?: 'independent' | 'ripple' | 'lockstep';
  workspace?: boolean;
  perPackage?: boolean;
  format?: 'json' | 'md' | 'both';
  level?: 'compact' | 'standard' | 'detailed';
  template?: string | null;
  metadata?: Record<string, unknown>; // Custom metadata passed to templates
  locale?: 'en' | 'ru';
  cache?: boolean;
  requireAudit?: boolean;
  requireSignedTags?: boolean;
  redactPatterns?: string[];
  maxBodyLength?: number;
  stabilityGuards?: {
    experimental?: { allowMajor?: boolean };
  };
  ignoreSubmodules?: boolean;
}

export interface GitProvider {
  type: 'github' | 'gitlab' | 'generic';
  baseUrl: string | null;
}

export interface GitRange {
  from: string;
  to: string;
}

export interface ChangeCache {
  meta: {
    graphHash: string;
    HEAD: string;
  };
  commits: Record<string, Change>;
  lastTags: Record<string, { tag: string; sha: string }>;
}

export interface PackageImpact {
  name: string;
  direct: boolean;
  viaDependency?: string;
}


