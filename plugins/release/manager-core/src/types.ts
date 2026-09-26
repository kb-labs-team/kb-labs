/**
 * Core types for @kb-labs/release-manager-core
 */

/** Minimal logger interface — structurally compatible with ILogger from @kb-labs/core-platform. */
export interface PluginLogger {
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, error?: Error, meta?: Record<string, unknown>): void;
}

/** Governed process facade supplied by the plugin runtime. */
export interface ReleaseShell {
  exec(command: string, args?: string[], options?: { cwd?: string; timeout?: number; env?: Record<string, string> }): Promise<{
    code: number;
    stdout: string;
    stderr: string;
    ok: boolean;
  }>;
}

export type ReleaseStage = 'planning' | 'checking' | 'versioning' | 'publishing' | 'verifying' | 'rollback';

export type VersionBump = 'patch' | 'minor' | 'major' | 'auto' | 'none';

/**
 * Release track. Orthogonal to VersionBump — bump decides how much to
 * increment, channel decides which track a release ships on.
 * - 'stable': normal versioned release, committed to git, publishes to
 *   `config.registry` (typically Verdaccio for pre-promote validation).
 * - 'canary': prerelease published straight to real npm under a dist-tag,
 *   with an in-memory `-canary.<shortsha>` version that is never committed
 *   to package.json/git.
 */
export type ReleaseChannel = 'stable' | 'canary';

export interface ReleaseContext {
  repo: string;
  cwd: string;
  branch: string;
  profile?: string;
  dryRun?: boolean;
}

export interface PackageVersion {
  name: string;
  path: string;
  /** Absolute path to the git repository root for this package. Populated during planning. */
  gitRoot: string;
  currentVersion: string;
  nextVersion: string;
  bump: VersionBump;
  isPublished: boolean;
  dependencies?: string[];
  /**
   * `nextVersion` was adopted as-is from a bump that already exists on disk
   * (see the trust-disk branch in planner.ts) rather than derived by bumping
   * `currentVersion`. Downstream version resolution — notably lockstep — must
   * treat it as final: re-deriving it would bump a second time on top of an
   * already-applied bump.
   */
  versionPinned?: boolean;
}

export interface ReleasePlan {
  packages: PackageVersion[];
  strategy: 'semver';
  registry: string;
  rollbackEnabled: boolean;
  channel: ReleaseChannel;
  /**
   * The flow/scope this plan was computed for. Persisted with the plan
   * artifact so a later pipeline step can tell whether the plan on disk is
   * the one it is supposed to consume, instead of silently reusing another
   * flow's plan (all flows share one scope-derived artifact path).
   */
  flow?: string;
  scope?: string;
}

export interface CheckResultDetails {
  /** Which package path this failure came from (for perPackage checks). */
  packagePath?: string;
  /** Full stdout from the check command. */
  stdout?: string;
  /** Full stderr from the check command. */
  stderr?: string;
  /** Exit code of the check command. */
  exitCode?: number;
  /** Short human-readable error summary. */
  error?: string;
}

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  /** Mirrors CustomCheckConfig.optional — a failed optional check must not fail the overall run. */
  optional?: boolean;
  /** Structured failure details — present when ok=false. */
  details?: CheckResultDetails;
  hint?: string;
  timingMs?: number;
  /**
   * True when the check did not run (or did not run for some packages) because a
   * blocking check it depends on failed. A skipped check always has ok=false so the
   * overall run still fails, but it is not itself a root-cause failure.
   */
  skipped?: boolean;
  /** Why the check was skipped, e.g. "blocking check dist-exports failed". */
  skipReason?: string;
  /** Wall-clock timing per phase for checks that run in phases (pack-static, pack-install). */
  phases?: CheckPhaseTiming[];
  /** Per-package breakdown for perPackage checks. */
  packages?: Array<{
    path: string;
    ok: boolean;
    /** True when this package was not checked because a blocking dependency failed for it. */
    skipped?: boolean;
    skipReason?: string;
    details?: CheckResultDetails;
  }>;
}

export interface CheckPhaseTiming {
  name: string;
  durationMs: number;
  /** Optional human-readable note (counts, truncation, fallback taken). */
  detail?: string;
}

/** Checks implemented inside the release plugin instead of by a shell command. */
export type BuiltinCheckKind = 'pack-static' | 'pack-install';

/**
 * Tuning for the aggregated `pack-install` builtin check. See
 * plugins/release/manager-core/src/pack-verify.ts.
 */
export interface PackInstallConfig {
  /**
   * Package name patterns that always get their own isolated clean install in
   * addition to the aggregated one: public standalone packages consumers
   * install directly (e.g. `@kb-labs/sdk`, `@kb-labs/platform-client`).
   */
  isolatedPackages?: string[];
  /** Also isolate packages the planner marks as changed (bump != none). Default true. */
  isolateChanged?: boolean;
  /** Upper bound for isolated installs of changed packages. Default 15. */
  maxIsolatedChanged?: number;
  /** Package name patterns that must never be `import()`ed (daemons/apps): resolve-only. */
  appPackages?: string[];
  /** Also treat packages with a `bin` field or a `-app`/`-daemon` name as apps. Default true. */
  detectApps?: boolean;
  /** Per-import timeout inside the single import pass. Default 20000. */
  importTimeoutMs?: number;
  /** Concurrency of isolated installs. Default 2. */
  isolatedConcurrency?: number;
  /** Max extra installs spent bisecting a failed aggregated install. Default 40. */
  maxBisectInstalls?: number;
}

// CheckId is now dynamic - any string is allowed
export type CheckId = string;

/**
 * Custom check configuration
 * Allows defining checks declaratively through config
 */
export interface CustomCheckConfig {
  id: string;
  /** Human-readable name shown in UI. Falls back to id if not set. */
  name?: string;
  /** Shell command. Required unless `builtin` is set. */
  command?: string;
  args?: string[];
  parser?: 'json' | 'exitcode' | ((stdout: string, stderr: string, exitCode: number) => boolean);
  timeoutMs?: number;
  optional?: boolean;
  /**
   * When true and this check fails (non-optional), checks that list it in
   * `dependsOn` are skipped with an explicit reason. All other checks still run
   * (fail-late). Default false: the failure fails the run but blocks nothing.
   * Ignored for optional checks (an optional failure never blocks).
   */
  blocking?: boolean;
  /**
   * Ids of earlier checks this check depends on. If a blocking dependency failed,
   * this check is skipped; for perPackage checks that depend on a perPackage
   * dependency only the packages that failed the dependency are skipped.
   */
  dependsOn?: string[];
  /**
   * Run this check once in a single directory instead of once per package.
   * "repoRoot" — run in the git repo root (default for monorepo builds)
   * "scopePath" — run in the scope directory (monorepo root like kb-labs-core/)
   * If omitted, check runs in each package directory (original behaviour).
   */
  runIn?: 'repoRoot' | 'scopePath' | 'perPackage';
  /**
   * Package name patterns (same matcher as PackagesFilter.exclude) skipped
   * by this check only — unlike `packages.exclude`, the package still gets
   * discovered, packed, versioned, and published normally by the rest of
   * the release. Use this for a check whose assumption doesn't hold for a
   * specific package (e.g. `pack-install`'s bare top-level import against a
   * config-only or test-harness-only package), not as a substitute for
   * excluding the package from the release itself.
   */
  skipPackages?: string[];
  /**
   * Run an in-process check from the release plugin instead of `command`
   * (`command` is then ignored). `pack-static` verifies every staged tarball in
   * one process; `pack-install` does one aggregated clean install + one import
   * pass, plus isolated installs only for a small configured/changed subset.
   */
  builtin?: BuiltinCheckKind;
  /** Options for `builtin: 'pack-install'`. */
  packInstall?: PackInstallConfig;
  /**
   * Keep the check in config but do not run it, unless it is requested
   * explicitly with `kb release checks --only <id>`. Used for the legacy
   * per-package `pack-install-per-package` debugging check.
   */
  disabled?: boolean;
}

export interface ReleaseResult {
  ok: boolean;
  version?: string;
  published?: string[];
  /** Versions already present on npm — treated as success, not re-published. */
  alreadyPublished?: string[];
  failed?: string[];
  skipped?: string[];
  changelog?: string;
  checks?: Partial<Record<CheckId, CheckResult>>;
  checksPerPackage?: Record<string, Partial<Record<CheckId, CheckResult>>>;
  versionUpdates?: Array<{
    package: string;
    from: string;
    to: string;
    updated: boolean;
  }>;
  git?: {
    committed: boolean;
    tagged: string[];
    pushed: boolean;
  };
  timingMs: number;
  errors?: string[];
}

export interface ReleaseReport {
  schemaVersion: '1.0';
  ts: string;
  context: ReleaseContext;
  stage: ReleaseStage;
  plan?: ReleasePlan;
  result: ReleaseResult;
}

export interface FlowConfig {
  /** Completely replaces global packages config — no array merging with global exclude. */
  packages?: PackagesFilter;
  /** Replaces global versioningStrategy. */
  versioningStrategy?: 'lockstep' | 'independent' | 'adaptive';
  /** If set, adds to global checks; matching ids override the global check. */
  checks?: CustomCheckConfig[];
  /**
   * Git tag template for this flow's stable releases. Tokens: `{flow}`
   * (the flow's config key, e.g. "platform") and `{version}` (the release
   * version). Default: `{flow}-v{version}` (e.g. `platform-v2.105.0`).
   * Used both to generate the tag (`buildReleaseTag`) and to parse a tag
   * back into a flow (`resolveFlowFromTag`) — see `./tag.ts`.
   */
  tagPattern?: string;
  /** Replaces global build config for this flow. */
  build?: BuildConfig;
}

export interface BuildConfig {
  /**
   * Name of a script in the repo root package.json to build all packages
   * in the flow as one unit (run as `pnpm run <script>`, e.g.
   * "build:affected"). Replaces the built-in per-package tsup build
   * entirely — use this if you already have a build tool (topological
   * ordering, caching, etc.) and don't want the release pipeline
   * reimplementing it. Exit code 0 = success. When unset, falls back to
   * the built-in safe-build strategy (`buildPackages` in build.ts).
   */
  script?: string;
}

export interface PackagesFilter {
  /** Glob dirs to scan, e.g. ['packages/*', 'apps/*'].
   *  Defaults to full tree scan when omitted. */
  paths?: string[];
  /** If set — only packages matching any pattern are included. */
  include?: string[];
  /** Packages matching any pattern are excluded (applied after include). */
  exclude?: string[];
}

export interface ReleaseConfig {
  registry?: string;
  strategy?: 'semver';
  bump?: VersionBump;
  /** Release track. Defaults to 'stable' when omitted. See ReleaseChannel. */
  channel?: ReleaseChannel;
  versioningStrategy?: 'lockstep' | 'independent' | 'adaptive';
  strict?: boolean;
  verify?: CheckId[];
  checks?: CustomCheckConfig[];
  publish?: {
    npm?: boolean;
    github?: boolean;
    /** npm publish --access. Default: 'public'. */
    access?: 'public' | 'restricted';
    /** Package manager to use for publishing. Default: 'pnpm'. */
    packageManager?: 'pnpm' | 'npm' | 'yarn';
    /** npm dist-tag for canary publishes. Default: 'canary'. */
    canaryTag?: string;
    /** npm dist-tag for stable promote-to-npm. Default: 'latest'. */
    stableTag?: string;
    /**
     * Real npm registry used for canary publishes and for `kb release
     * promote`. Deliberately separate from `registry` (which controls
     * where a 'stable' `release run` publishes — typically Verdaccio) so a
     * stale Verdaccio `registry` value can't accidentally swallow a canary
     * publish or a promote. Default: 'https://registry.npmjs.org'.
     */
    npmRegistry?: string;
    /** Timeout (ms) for registry-verification HTTP calls before promoting a stable release. Default: 30000. */
    verifyRegistryTimeoutMs?: number;
  };
  /** Workspace configuration — package manager used for publishing. */
  workspace?: {
    type?: 'pnpm' | 'npm' | 'yarn';
    root?: string;
  };
  /** Global build config — overridable per flow. See BuildConfig. */
  build?: BuildConfig;
  /** Filter which packages are discovered and released. */
  packages?: PackagesFilter;
  /** Per-scope overrides — packages filter merged with global, checks are additive. */
  scopes?: Record<string, {
    packages?: PackagesFilter;
    /** If set, adds to global `checks`; matching ids override the global check. */
    checks?: CustomCheckConfig[];
    /** If set, overrides global versioningStrategy for this scope. */
    versioningStrategy?: 'lockstep' | 'independent' | 'adaptive';
  }>;
  /** Named release configuration profiles — completely replace (not merge) global packages/versioning/checks. */
  flows?: Record<string, FlowConfig>;
  rollback?: {
    enabled?: boolean;
    maxHistory?: number;
  };
  output?: {
    json?: boolean;
    md?: boolean;
    text?: boolean;
  };
  changelog?: {
    enabled?: boolean;
    /**
     * Where the consolidated repo-root changelog is written, relative to
     * repoRoot. Default: '.kb/release/CHANGELOG.md'. Set to 'CHANGELOG.md'
     * to write it at the repo root instead.
     */
    outputPath?: string;
    includeTypes?: string[];
    excludeTypes?: string[];
    ignoreAuthors?: string[];
    scopeMap?: Record<string, string>;
    /** Group commits by scope into named sections for the changelog template */
    groups?: Array<{
      title: string;
      emoji?: string;
      /** Scope values that belong to this group. Supports prefix matching (e.g. "adapters" matches "adapters-redis") */
      scopes: string[];
    }>;
    collapseMerges?: boolean;
    collapseReverts?: boolean;
    preferMergeSummary?: boolean;
    bumpStrategy?: 'independent' | 'ripple' | 'lockstep';
    workspace?: boolean;
    perPackage?: boolean;
    format?: 'json' | 'md' | 'both';
    level?: 'compact' | 'standard' | 'detailed';
    template?: string | null;
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
    metadata?: Record<string, unknown>;
  };
  git?: {
    provider?: 'auto' | 'github' | 'gitlab' | 'generic';
    baseUrl?: string | null;
    autoUnshallow?: boolean;
    requireSignedTags?: boolean;
  };
}

export interface AuditSummary {
  ok: boolean;
  checks: Partial<Record<string, { ok: boolean; code?: string; hint?: string }>>;
  overall?: { ok: boolean; failReasons: string[] };
}

// ─── Pipeline interfaces ─────────────────────────────────────────────────────

export interface BuildResult {
  name: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

export interface VerifyResult {
  name: string;
  success: boolean;
  issues: string[];
}

export interface PublishablePackage {
  name: string;
  version: string;
  path: string;
}

export interface PublishResult {
  published: string[];
  /** Versions that were already on npm — treated as success, no re-publish attempted. */
  alreadyPublished?: string[];
  failed: string[];
  skipped: string[];
  errors: string[];
}

/** Injected by CLI (OTP) or REST (token-based) */
export interface PackagePublisher {
  publish(packages: PublishablePackage[], options: { dryRun?: boolean; access?: string; tag?: string; registry?: string }): Promise<PublishResult>;
}

/** Injected by caller — generates changelog */
export interface ChangelogGenerator {
  generate(plan: ReleasePlan, options: {
    repoRoot: string;
    gitCwd: string;
    config: ReleaseConfig;
    /** Named flow whose release tag pattern bounds the changelog. */
    flow?: string;
    /** Explicit git boundaries; these take precedence over the flow baseline. */
    range?: { from?: string; to?: string; sinceTag?: string };
  }): Promise<string>;
}

export interface PipelineOptions {
  cwd: string;
  repoRoot: string;
  /** Resolved absolute path to the monorepo being released (e.g. infra/kb-labs-adapters).
   *  Planner uses this as cwd for package discovery. */
  scopeCwd: string;
  /** Original scope name for display/reporting only */
  scope?: string;
  /** Named flow — selects a release config profile. Packages/versioning replace global values; checks are additive. */
  flow?: string;
  config: ReleaseConfig;
  dryRun?: boolean;
  skipChecks?: boolean;
  skipBuild?: boolean;
  skipVerify?: boolean;
  /**
   * Prepare-only mode: run checks/build/verify/version-bump/changelog and
   * commit+tag git, but never call the publisher. No npm credentials are
   * required. Intended for a local/CI "prepare" step whose git tag is the
   * trigger for a separate CI job that runs `kb release promote` to do the
   * actual npm publish. See plugins/release/docs/adr/0001-*.
   */
  skipPublish?: boolean;

  /** Custom check configs from kb.config.json */
  checks?: CustomCheckConfig[];

  /** Injected publisher (CLI = interactive OTP, REST = programmatic token) */
  publisher: PackagePublisher;

  /** Injected changelog generator (with or without LLM) */
  changelog?: ChangelogGenerator;

  /** Pass --no-verify to git push and pushTags. Default: false (hooks run normally). */
  noVerify?: boolean;

  logger?: PluginLogger;
  shell: ReleaseShell;
  onProgress?: (stage: ReleaseStage, message: string) => void;
}

export interface PipelineResult {
  success: boolean;
  report: ReleaseReport;
  plan: ReleasePlan;
}
