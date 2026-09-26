/**
 * KB Labs Release Manager - Manifest V3
 *
 * Migration from V2 to V3 following best practices from V3-MIGRATION-GUIDE.md
 *
 * Key changes:
 * - Schema: kb.plugin/3
 * - Commands use handler#default suffix
 * - Commands have handlerPath field
 * - Permissions moved to manifest level
 * - All imports from @kb-labs/sdk
 */

import {
  defineCommandFlags,
  combinePermissions,
  gitWorkflowPreset,
  kbPlatformPreset,
  npmPublishPreset,
  ciEnvironmentPreset,
} from '@kb-labs/sdk';
import {
  RELEASE_BASE_PATH,
  RELEASE_ROUTES,
  RELEASE_CACHE_PREFIX,
} from '@kb-labs/release-manager-contracts';
import { CHECKS_CONCURRENCY } from '@kb-labs/release-manager-core';

/**
 * Build permissions using presets:
 * - gitWorkflow: HOME, USER, GIT_*, SSH_* for git/changelog operations
 * - kbPlatform: KB_* env vars and .kb/ directory
 * - npmPublish: NPM_TOKEN, npm registry access for publishing
 * - ciEnvironment: CI, GITHUB_TOKEN for CI/CD integrations
 * - Custom: KB_RELEASE_*, additional fs paths
 */
const pluginPermissions = combinePermissions()
  .with(gitWorkflowPreset)
  .with(kbPlatformPreset)
  .with(npmPublishPreset)
  .with(ciEnvironmentPreset)
  .withEnv(['KB_RELEASE_*', 'NODE_ENV'])
  .withFs({
    mode: 'readWrite',
    allow: [
      '.kb/release/**',
      'package.json',
      '**/package.json',
      'pnpm-workspace.yaml',
      '**/*.yml',
      '**/*.yaml',
      'CHANGELOG.md',
      '**/CHANGELOG.md',
    ],
    // Note: deny patterns (*.key, *.secret, node_modules) are enforced by platform
  })
  .withShell({
    allow: ['bash', 'git', 'npm', 'npx', 'pnpm'], // release gates/builds plus git, npm publishing, and configurable pnpm scripts
    // Must match CHECKS_CONCURRENCY (manager-core/src/checks.ts): the process
    // broker grants at most this many concurrent shells per plugin, so a lower
    // value here throttles perPackage check batches to 1-at-a-time and can
    // blow their timeout; a higher value defeats the plugin's own batching.
    maxConcurrent: CHECKS_CONCURRENCY,
  })
  .withPlatform({
    cache: [RELEASE_CACHE_PREFIX], // Cache namespace prefix for plan/changelog caching
    llm: true,                       // LLM for changelog generation
    analytics: true,                 // Track release events
  })
  .withQuotas({
    // 30 min default for complex releases (167 packages); overridable via
    // KB_RELEASE_CHECKS_TIMEOUT_MS for profiling/tuning without a rebuild.
    timeoutMs: Number(process.env.KB_RELEASE_CHECKS_TIMEOUT_MS) || 1800000,
    memoryMb: 4096, // full platform build:affected across 167 packages peaked at ~2.05GB on a CI runner, right at the old 2048 ceiling
    cpuMs: 300000, // 5 min CPU time
  })
  .build();

export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/release',
  version: '0.1.0',

  display: {
    name: 'Release Manager',
    description: 'Plan, execute, and audit releases across your workspace',
    tags: ['release', 'publish', 'versioning'],
  },

  // Platform requirements
  platform: {
    requires: ['storage', 'cache'], // cache required for plan/changelog caching
    optional: ['llm', 'analytics', 'logger'],
  },

  // Setup handler - V3 pattern
  setup: {
    handler: './setup/handler.js#default',
    describe: 'Prepare the .kb/release workspace (plans, reports, backups).',
  },

  // CLI commands - V3 format
  cli: {
    groupMeta: [
      { path: 'release', describe: 'Release management commands' },
    ],
    commands: [
      // release:plan - Analyze changes and prepare release plan
      {
        path: 'release plan',
        category: 'Pipeline',
        describe: 'Analyze changes and prepare release plan',
        operationType: 'analyze' as const,
        longDescription: 'Detect modified packages and compute version bumps based on changes',

        handler: './cli/commands/plan.js#default',

        flags: defineCommandFlags({
          scope: { type: 'string', description: 'Package scope (glob pattern)' },
          flow: { type: 'string', description: 'Named release flow from release.flows' },
          bump: {
            type: 'string',
            choices: ['patch', 'minor', 'major', 'auto'] as const,
            default: 'auto',
            description: 'Version bump strategy',
          },
          channel: {
            type: 'string',
            choices: ['stable', 'canary'] as const,
            default: 'stable',
            description: 'Release channel — canary previews the -canary.<shortsha> version shape',
          },
          json: { type: 'boolean', description: 'Print plan as JSON' },
        }),

        examples: [
          'kb release plan',
          'kb release plan --scope packages/*',
          'kb release plan --bump minor',
          'kb release plan --channel canary',
          'kb release plan --json',
        ],
      },

      // release:run - Execute release process
      {
        path: 'release run',
        category: 'Pipeline',
        describe: 'Execute release process (plan, check, publish)',
        operationType: 'execute' as const,
        longDescription: 'Run full release: plan versions, run checks, publish packages',

        handler: './cli/commands/run.js#default',

        flags: defineCommandFlags({
          scope: { type: 'string', description: 'Package scope or glob pattern (e.g. @my-org/core, packages/*)' },
          bump: {
            type: 'string',
            choices: ['patch', 'minor', 'major', 'auto'] as const,
            default: 'auto',
            description: 'Version bump override (default: auto-detect from commits)',
          },
          strict: { type: 'boolean', description: 'Fail on any check failure' },
          channel: {
            type: 'string',
            choices: ['stable', 'canary'] as const,
            default: 'stable',
            description: 'Release channel — canary publishes straight to npm under a prerelease tag, no git commit/tag',
          },
          'dry-run': { type: 'boolean', description: 'Simulate release without publishing or tagging' },
          'skip-checks': { type: 'boolean', description: 'Skip pre-release checks' },
          'skip-build': { type: 'boolean', description: 'Skip build step' },
          'skip-verify': { type: 'boolean', description: 'Skip artifact verification (npm pack check)' },
          'skip-publish': {
            type: 'boolean',
            description: 'Prepare-only: build, version, changelog, git commit/tag — never publish to npm. No npm credentials required. Pair with a tag-triggered CI job running `kb release promote`.',
          },
          'no-verify': { type: 'boolean', description: 'Pass --no-verify to git push (bypasses pre-push hooks)' },
          yes: { type: 'boolean', description: 'Skip confirmation prompt — for CI/headless mode' },
          json: { type: 'boolean', description: 'Print result as JSON' },
        }),

        examples: [
          'kb release run',
          'kb release run --dry-run',
          'kb release run --yes',
          'kb release run --yes --no-verify',
          'kb release run --bump minor --yes',
          'kb release run --scope @my-org/core',
          'kb release run --skip-checks --skip-build',
          'kb release run --strict --json',
          'kb release run --channel canary --yes',
          'kb release run --flow platform --skip-publish --yes',
        ],
      },

      // release:publish - Publish packages to npm
      {
        path: 'release publish',
        category: 'Publish',
        describe: 'Publish packages to npm registry',
        operationType: 'execute' as const,
        longDescription: 'Smart npm publish with interactive 2FA support and better UX',

        handler: './cli/commands/publish.js#default',

        flags: defineCommandFlags({
          scope: { type: 'string', description: 'Package scope (glob pattern)' },
          otp: { type: 'string', description: 'One-time password (optional, will prompt if needed)' },
          'dry-run': { type: 'boolean', description: 'Simulate publish without actually publishing' },
          tag: { type: 'string', description: 'NPM dist-tag (default: latest)' },
          access: {
            type: 'string',
            choices: ['public', 'restricted'] as const,
            description: 'Package access level',
          },
          token: { type: 'string', description: 'NPM auth token (overrides NPM_TOKEN env)' },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: [
          'kb release publish',
          'kb release publish --scope @kb-labs/core',
          'kb release publish --otp 123456',
          'kb release publish --dry-run',
          'kb release publish --tag next --access public',
        ],
      },

      // release:stage - Pack the currently-committed versions into real tarballs, once
      {
        path: 'release stage',
        category: 'Publish',
        describe: 'Pack the currently-committed package versions for a flow into real npm tarballs, once, for `release deliver` to ship',
        operationType: 'execute' as const,
        longDescription:
          'Produces the actual npm tarball artifacts for a flow\'s already-committed package.json versions ' +
          '— no re-bump, no rebuild. Writes a manifest.json (name/version/tarball/sha256) alongside the tarballs. ' +
          'Intended to run once in CI right after checking out a release tag; every `release deliver` target then ' +
          'ships these exact bytes instead of re-packing independently. Not the same command as `release pack` ' +
          '(that one verifies proposed packages before a release is decided; this one packs an already-decided one).',

        handler: './cli/commands/stage.js#default',

        flags: defineCommandFlags({
          'release-tag': { type: 'string', description: 'Git tag to resolve {flow, channel} from (via release.flows[*].tagPattern) — alternative to --flow' },
          flow: { type: 'string', description: 'Named flow — selects packages the same way `release run --flow` does (e.g. excludes sdk from platform)' },
          'out-dir': { type: 'string', description: 'Output directory for tarballs + manifest.json (default: .kb/release/artifacts)' },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: [
          'kb release stage --flow platform',
          'kb release stage --release-tag platform-v2.105.0',
          'kb release stage --flow sdk --out-dir .kb/release/artifacts',
        ],
      },

      // release:stage-plan - Publish a release plan's PLANNED versions to a
      // local staging registry, before Bump versions has run
      {
        path: 'release stage plan',
        category: 'Publish',
        describe: 'Publish a release plan\'s planned package versions to a local staging registry (Verdaccio)',
        operationType: 'execute' as const,
        longDescription:
          'Runs BEFORE version bump, off the in-memory plan `release plan` already computed. Publishes each plan ' +
          'package at its PLANNED nextVersion — internal sibling dependencies rewritten to `^nextVersion` too — to ' +
          '--registry, so the `pack-install` Checks gate can verify cross-package dependencies against the version ' +
          'this release is about to ship instead of whatever is already live on npm. Distinct from `release stage`, ' +
          'which packs already-committed, already-bumped versions for CI delivery after approval.',

        handler: './cli/commands/stage-plan.js#default',

        flags: defineCommandFlags({
          'plan-path': { type: 'string', description: 'Path to the plan.json written by `release plan`' },
          registry: { type: 'string', description: 'Target staging registry URL (e.g. http://localhost:4873)' },
          flow: { type: 'string', description: 'Named flow — used only to resolve config for package discovery' },
          token: { type: 'string', description: 'Auth token to send (default: "verdaccio-local" — a placeholder; the staging registry allows anonymous publish)' },
          tag: { type: 'string', description: 'npm dist-tag to publish under (default: "latest")' },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: [
          'kb release stage plan --flow platform --plan-path .kb/release/plans/root/current/plan.json --registry http://localhost:4873',
        ],
      },

      // release:clean-install - Shared install-verification used by both
      // check-pack-install.sh and `release stage`
      {
        path: 'release clean install',
        category: 'Publish',
        describe: 'Install a packed tarball into a throwaway consumer and confirm it imports cleanly',
        operationType: 'execute' as const,
        longDescription:
          'Installs --tarball into a fresh, outside-the-workspace consumer project and confirms --name can be ' +
          'imported afterward. Shared by check-pack-install.sh (local release gate) and `release stage` (CI publish ' +
          'path) so both use identical verification — catches an already-published PEER dependency that is itself ' +
          'broken, which static manifest checks cannot see. Surfaces the real failure reason via @npmcli/arborist ' +
          'directly; plain `npm install` swallows this exact failure class as an unhandled rejection with no usable error.',

        handler: './cli/commands/verify-clean-install.js#default',

        flags: defineCommandFlags({
          tarball: { type: 'string', description: 'Path to the packed tarball to install' },
          name: { type: 'string', description: 'Package name to import after install' },
          registry: { type: 'string', description: 'Registry override for ALL dependency resolution (default: real npm) — e.g. a local staging Verdaccio' },
          json: { type: 'boolean', description: 'Output in JSON format' },
          additionalTarballs: {
            type: 'string',
            description:
              'Comma-separated tarball paths for workspace siblings. Forces pnpm to install these exact local ' +
              'artifacts via pnpm.overrides instead of resolving the same package names from the real npm registry ' +
              '— required with --package-manager pnpm to avoid silently testing an already-published, possibly ' +
              'stale, version of an in-repo sibling.',
          },
          packageManager: {
            type: 'string',
            description: '"pnpm" enables the additionalTarballs override path; "npm" (default) keeps the plain Arborist install.',
          },
        }),

        examples: [
          'kb release clean install --tarball ./kb-labs-sdk-2.115.0.tgz --name @kb-labs/sdk',
          'kb release clean install --tarball ./a.tgz --name @kb-labs/a --package-manager pnpm --additional-tarballs ./b.tgz,./c.tgz',
        ],
      },

      // release:promote - Promote an already-released version to npm
      {
        path: 'release promote',
        category: 'Publish',
        describe: 'Promote already-released package versions to npm (no re-bump, no rebuild)',
        operationType: 'execute' as const,
        longDescription:
          'Publishes the CURRENT on-disk package.json versions to npm — no version bump, no rebuild. ' +
          'Intended to run after `release run --channel stable` (typically targeting Verdaccio via ' +
          'config.registry): once that run is verified, `release promote` pushes the exact same, ' +
          'already-committed versions to npm under the stable dist-tag.',

        handler: './cli/commands/promote.js#default',

        flags: defineCommandFlags({
          scope: { type: 'string', description: 'Package scope (glob pattern)' },
          flow: { type: 'string', description: 'Named flow — selects packages the same way `release run --flow` does (e.g. excludes sdk from platform)' },
          tag: { type: 'string', description: 'npm dist-tag override (default: config.publish.stableTag, falls back to "latest")' },
          registry: { type: 'string', description: 'Registry override (default: config.publish.npmRegistry, falls back to real npm)' },
          otp: { type: 'string', description: 'One-time password (optional, will prompt if needed)' },
          'dry-run': { type: 'boolean', description: 'Simulate promote without actually publishing' },
          access: {
            type: 'string',
            choices: ['public', 'restricted'] as const,
            description: 'Package access level',
          },
          token: { type: 'string', description: 'NPM auth token (overrides NPM_TOKEN env)' },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: [
          'kb release promote',
          'kb release promote --flow platform',
          'kb release promote --flow sdk',
          'kb release promote --scope @kb-labs/core',
          'kb release promote --dry-run',
          'kb release promote --tag next',
        ],
      },

      // release:deliver - Ship a `release stage`d artifact to a target (npm)
      {
        path: 'release deliver',
        category: 'Publish',
        describe: 'Ship the tarballs `release stage` already packed to a target — no packing, no rebuild',
        operationType: 'execute' as const,
        longDescription:
          'CI-side half of the "plugin prepares, CI delivers" release flow: reads manifest.json written by ' +
          '`release stage` and ships those exact tarballs to --target (only "npm" is implemented this pass). ' +
          'Resolves {flow, channel} from --release-tag via release.flows[*].tagPattern so CI never needs to ' +
          'guess the flow itself — just pass the tag. Verifies the delivery against the real registry ' +
          'afterwards (with retry, since real npm has propagation lag); never attempts npm unpublish on a ' +
          'verification failure — that is a human decision.',

        handler: './cli/commands/deliver.js#default',

        flags: defineCommandFlags({
          'release-tag': { type: 'string', description: 'Git tag to resolve {flow, channel} from (via release.flows[*].tagPattern) — alternative to --flow' },
          flow: { type: 'string', description: 'Named flow — alternative to --release-tag' },
          target: { type: 'string', choices: ['npm'] as const, description: 'Delivery target (default: npm — the only target implemented this pass)' },
          'artifacts-dir': { type: 'string', description: 'Where `release stage` wrote tarballs + manifest.json (default: .kb/release/artifacts)' },
          tag: { type: 'string', description: 'npm dist-tag override (default: config.publish.stableTag, falls back to "latest")' },
          registry: { type: 'string', description: 'Registry override (default: config.publish.npmRegistry, falls back to real npm)' },
          otp: { type: 'string', description: 'One-time password (optional, will prompt if needed)' },
          'dry-run': { type: 'boolean', description: 'Simulate delivery without actually publishing' },
          access: {
            type: 'string',
            choices: ['public', 'restricted'] as const,
            description: 'Package access level',
          },
          token: { type: 'string', description: 'NPM auth token (overrides NPM_TOKEN env)' },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: [
          'kb release deliver --release-tag platform-v2.105.0 --target npm',
          'kb release deliver --flow sdk --target npm',
          'kb release deliver --release-tag sdk-v3.2.0 --dry-run',
        ],
      },

      // release:rollback - Rollback last release
      {
        path: 'release rollback',
        category: 'Utilities',
        describe: 'Rollback last release',
        operationType: 'mutate' as const,
        longDescription: 'Restore workspace state from backup snapshot',

        handler: './cli/commands/rollback.js#default',

        flags: defineCommandFlags({
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: ['kb release rollback', 'kb release rollback --json'],
      },

      // release:report - Show last release report
      {
        path: 'release report',
        category: 'Utilities',
        describe: 'Show last release report',
        operationType: 'read' as const,
        longDescription: 'Display the most recent release execution report',

        handler: './cli/commands/report.js#default',

        flags: defineCommandFlags({
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: ['kb release report', 'kb release report --json'],
      },

      // release:status - What is actually stable vs. candidate right now
      {
        path: 'release status',
        category: 'Utilities',
        describe: 'Show what is actually stable vs. candidate for a flow (git tag, npm dist-tags, recent candidate CI)',
        operationType: 'read' as const,
        longDescription: 'Cross-checks the latest stable git tag against real npm dist-tags and recent candidate CI runs, and flags drift — a tag or npm publish existing is not the same as a verified, promoted release.',

        handler: './cli/commands/status.js#default',

        flags: defineCommandFlags({
          flow: { type: 'string', description: 'Named release flow from release.flows (e.g. "platform", "sdk")', required: true },
          ci: { type: 'boolean', description: 'Include recent candidate CI run status (default: true)' },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: ['kb release status --flow platform', 'kb release status --flow sdk --json'],
      },

      // release:changelog - Generate changelog
      {
        path: 'release changelog',
        category: 'Utilities',
        describe: 'Generate changelog from conventional commits',
        operationType: 'read' as const,
        longDescription: 'Parse git history and generate changelog with conventional commits support',

        handler: './cli/commands/changelog.js#default',

        flags: defineCommandFlags({
          scope: { type: 'string', description: 'Filter to specific package' },
          flow: { type: 'string', description: 'Named release flow from release.flows' },
          from: { type: 'string', description: 'Start commit/tag' },
          to: { type: 'string', description: 'End commit/tag (default: HEAD)' },
          'since-tag': { type: 'string', description: 'Shorthand for --from <tag>' },
          format: {
            type: 'string',
            choices: ['json', 'md', 'both'] as const,
            default: 'both',
            description: 'Output format',
          },
          level: {
            type: 'string',
            choices: ['compact', 'standard', 'detailed'] as const,
            default: 'standard',
            description: 'Detail level',
          },
          template: {
            type: 'string',
            description:
              'Template name (builtin: corporate, corporate-ai, technical, compact) or custom path',
          },
          'breaking-only': { type: 'boolean', description: 'Show only breaking changes' },
          include: { type: 'string', description: 'Comma-separated types to include' },
          exclude: { type: 'string', description: 'Types to exclude' },
          'workspace-only': { type: 'boolean', description: 'Only workspace changelog' },
          'per-package': { type: 'boolean', description: 'Only per-package changelogs' },
          force: { type: 'boolean', description: 'Skip audit gate' },
          'allow-major': { type: 'boolean', description: 'Allow major bumps for experimental packages' },
          preid: { type: 'string', description: 'Pre-release identifier (rc, beta, alpha)' },
        }),

        examples: [
          'kb release changelog',
          'kb release changelog --from v1.0.0',
          'kb release changelog --format md --level detailed',
          'kb release changelog --template corporate-ai',
          'kb release changelog --template ./my-template.ts',
          'kb release changelog --breaking-only',
        ],
      },

      // release:verify - Validate release readiness
      {
        path: 'release verify',
        category: 'Validation',
        describe: 'Validate release readiness',
        operationType: 'analyze' as const,
        longDescription: 'Validate release readiness via flag gates (packages, breaking changes, commit types)',

        handler: './cli/commands/verify.js#default',

        flags: defineCommandFlags({
          'fail-if-empty': { type: 'boolean', description: 'Fail if no version bumps needed' },
          'fail-on-breaking': { type: 'boolean', description: 'Fail if breaking changes detected' },
          'allow-types': {
            type: 'string',
            description: 'Comma-separated types required (e.g., feat,fix)',
          },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: [
          'kb release verify',
          'kb release verify --fail-if-empty',
          'kb release verify --allow-types feat,fix',
        ],
      },

      // release:checks - Run pre-release checks
      {
        path: 'release checks',
        category: 'Validation',
        describe: 'Run pre-release checks from release config',
        operationType: 'analyze' as const,
        longDescription: 'Execute custom checks defined in release config (lint, test, audit, etc.)',

        handler: './cli/commands/checks.js#default',

        flags: defineCommandFlags({
          scope: { type: 'string', description: 'Package scope (glob pattern)' },
          flow: { type: 'string', description: 'Named release flow from release.flows' },
          preflight: { type: 'boolean', description: 'Run the release preflight first and stop before checks if the environment is broken' },
          'net-offset': { type: 'number', description: 'kb-dev network offset for the staging registry (used with --preflight)' },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: [
          'kb release checks',
          'kb release checks --scope @my-org/core',
          'kb release checks --json',
        ],
      },

      // release:preflight - Seconds-fast environment gate before checks
      {
        path: 'release preflight',
        category: 'Validation',
        describe: 'Check the release environment before running the long checks stage',
        operationType: 'analyze' as const,
        longDescription:
          'Read-only: verifies the release branch, clean working tree, Docker, local staging registry, npm registry, ' +
          'GitHub auth and stable-tag/npm baseline drift. Never starts anything; prints the exact command to fix a broken environment.',

        handler: './cli/commands/preflight.js#default',

        flags: defineCommandFlags({
          flow: { type: 'string', description: 'Named release flow; enables the baseline drift check' },
          branch: { type: 'string', description: 'Branch releases must start from (default: master)' },
          'net-offset': { type: 'number', description: 'kb-dev network offset used to derive the staging registry port (default: $KB_NET_OFFSET or 0)' },
          'staging-registry': { type: 'string', description: 'Staging registry URL override (default: $KB_RELEASE_STAGING_REGISTRY or http://localhost:<4873+offset>)' },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: [
          'kb release preflight --flow platform',
          'kb release preflight --flow platform --net-offset 100 --json',
        ],
      },

      // release:build - Build packages
      {
        path: 'release build',
        category: 'Publish',
        describe: 'Build packages from release plan',
        operationType: 'execute' as const,
        longDescription: 'Build all packages in plan into temp dir then atomically swap dist/',

        handler: './cli/commands/build.js#default',

        flags: defineCommandFlags({
          scope: { type: 'string', description: 'Package scope (glob pattern)' },
          flow: { type: 'string', description: 'Named release flow from release.flows' },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: [
          'kb release build',
          'kb release build --scope platform',
          'kb release build --json',
        ],
      },

      // release:pack - Verify npm artifacts
      {
        path: 'release pack',
        category: 'Publish',
        describe: 'Verify built package artifacts via npm pack',
        operationType: 'execute' as const,
        longDescription: 'Run npm pack checks: directory imports, test file leaks, missing exports, syntax errors',

        handler: './cli/commands/pack.js#default',

        flags: defineCommandFlags({
          scope: { type: 'string', description: 'Package scope (glob pattern)' },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: [
          'kb release pack',
          'kb release pack --scope @my-org/core',
          'kb release pack --json',
        ],
      },

      // release:version - Bump package.json versions
      {
        path: 'release version',
        category: 'Publish',
        describe: 'Bump package.json versions per release plan',
        operationType: 'mutate' as const,
        longDescription: 'Update version fields in package.json files based on computed plan',

        handler: './cli/commands/version.js#default',

        flags: defineCommandFlags({
          scope: { type: 'string', description: 'Package scope (glob pattern)' },
          flow: { type: 'string', description: 'Named release flow from release.flows' },
          bump: {
            type: 'string',
            choices: ['patch', 'minor', 'major', 'auto'] as const,
            default: 'auto',
            description: 'Version bump override',
          },
          channel: {
            type: 'string',
            choices: ['stable', 'canary'] as const,
            default: 'stable',
            description: 'Release channel — must match the channel `release plan` used, so a stale/rejected persisted plan is recomputed under the same channel instead of silently falling back to stable',
          },
          'dry-run': { type: 'boolean', description: 'Show what would be bumped without writing' },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: [
          'kb release version',
          'kb release version --bump minor',
          'kb release version --channel canary',
          'kb release version --dry-run',
          'kb release version --scope platform --json',
        ],
      },

      // release:git - Commit, tag, push
      {
        path: 'release git',
        category: 'Publish',
        describe: 'Commit, tag, and push release changes',
        operationType: 'mutate' as const,
        longDescription: 'Create release commit, create version tags, and push to remote',

        handler: './cli/commands/git.js#default',

        flags: defineCommandFlags({
          scope: { type: 'string', description: 'Package scope (glob pattern)' },
          flow: { type: 'string', description: 'Named release flow from release.flows' },
          bump: {
            type: 'string',
            choices: ['patch', 'minor', 'major', 'auto'] as const,
            description: 'Version bump override (used to reload plan)',
          },
          channel: {
            type: 'string',
            choices: ['stable', 'canary'] as const,
            default: 'stable',
            description: 'Release channel — must match the channel `release plan`/`release version` used, so a stale/rejected persisted plan is recomputed under the same channel instead of silently falling back to stable',
          },
          'dry-run': { type: 'boolean', description: 'Skip git operations' },
          'no-verify': { type: 'boolean', description: 'Pass --no-verify to git push' },
          json: { type: 'boolean', description: 'Output in JSON format' },
        }),

        examples: [
          'kb release git',
          'kb release git --scope platform',
          'kb release git --dry-run',
          'kb release git --no-verify --json',
        ],
      },
    ],
  },

  // REST API routes - V3 format (scope-based architecture)
  rest: {
    basePath: RELEASE_BASE_PATH,
    routes: [
      // GET /scopes - List available release scopes
      {
        method: 'GET',
        path: RELEASE_ROUTES.SCOPES,
        handler: './rest/handlers/scopes-handler.js#default',
        output: {
          zod: '@kb-labs/release-manager-contracts#ScopesResponseSchema',
        },
      },
      // GET /status - Get release status for a scope
      {
        method: 'GET',
        path: RELEASE_ROUTES.STATUS,
        handler: './rest/handlers/status-handler.js#default',
        output: {
          zod: '@kb-labs/release-manager-contracts#StatusResponseSchema',
        },
      },
      // GET /plan - Get current release plan for a scope
      {
        method: 'GET',
        path: RELEASE_ROUTES.PLAN,
        handler: './rest/handlers/plan-handler.js#default',
        input: {
          zod: '@kb-labs/release-manager-contracts#PlanInputSchema',
        },
        output: {
          zod: '@kb-labs/release-manager-contracts#PlanResponseSchema',
        },
      },
      // POST /generate - Generate release plan (LLM)
      {
        method: 'POST',
        path: RELEASE_ROUTES.GENERATE,
        handler: './rest/handlers/generate-handler.js#default',
        input: {
          zod: '@kb-labs/release-manager-contracts#GeneratePlanRequestSchema',
        },
        output: {
          zod: '@kb-labs/release-manager-contracts#GeneratePlanResponseSchema',
        },
        timeoutMs: 120000, // 2 minutes for LLM analysis
      },
      // DELETE /plan - Reset release plan
      {
        method: 'DELETE',
        path: RELEASE_ROUTES.RESET,
        handler: './rest/handlers/reset-handler.js#default',
        input: {
          zod: '@kb-labs/release-manager-contracts#ResetPlanRequestSchema',
        },
        output: {
          zod: '@kb-labs/release-manager-contracts#ResetPlanResponseSchema',
        },
      },
      // GET /changelog - Get changelog for a scope
      {
        method: 'GET',
        path: RELEASE_ROUTES.CHANGELOG,
        handler: './rest/handlers/changelog-handler.js#default',
        input: {
          zod: '@kb-labs/release-manager-contracts#ChangelogInputSchema',
        },
        output: {
          zod: '@kb-labs/release-manager-contracts#ChangelogResponseSchema',
        },
      },
      // POST /changelog/generate - Generate changelog (LLM)
      {
        method: 'POST',
        path: RELEASE_ROUTES.CHANGELOG_GENERATE,
        handler: './rest/handlers/changelog-generate-handler.js#default',
        input: {
          zod: '@kb-labs/release-manager-contracts#GenerateChangelogRequestSchema',
        },
        output: {
          zod: '@kb-labs/release-manager-contracts#GenerateChangelogResponseSchema',
        },
        timeoutMs: 120000, // 2 minutes for LLM generation
      },
      // POST /changelog/save - Save edited changelog
      {
        method: 'POST',
        path: RELEASE_ROUTES.CHANGELOG_SAVE,
        handler: './rest/handlers/changelog-save-handler.js#default',
        input: {
          zod: '@kb-labs/release-manager-contracts#SaveChangelogRequestSchema',
        },
        output: {
          zod: '@kb-labs/release-manager-contracts#SaveChangelogResponseSchema',
        },
      },
      // POST /run - Execute release process
      {
        method: 'POST',
        path: RELEASE_ROUTES.RUN,
        handler: './rest/handlers/run-handler.js#default',
        input: {
          zod: '@kb-labs/release-manager-contracts#RunReleaseRequestSchema',
        },
        output: {
          zod: '@kb-labs/release-manager-contracts#RunReleaseResponseSchema',
        },
        timeoutMs: 300000, // 5 minutes for release execution
      },
      // GET /report - Get latest release report
      {
        method: 'GET',
        path: RELEASE_ROUTES.REPORT,
        handler: './rest/handlers/report-handler.js#default',
        output: {
          zod: '@kb-labs/release-manager-contracts#ReportResponseSchema',
        },
      },
      // GET /history - Get release history
      {
        method: 'GET',
        path: RELEASE_ROUTES.HISTORY,
        handler: './rest/handlers/history-handler.js#default',
        output: {
          zod: '@kb-labs/release-manager-contracts#HistoryResponseSchema',
        },
      },
      // GET /history/:id/report - Get historical release report
      {
        method: 'GET',
        path: RELEASE_ROUTES.HISTORY_REPORT,
        handler: './rest/handlers/history-report-handler.js#default',
        output: {
          zod: '@kb-labs/release-manager-contracts#HistoryReportResponseSchema',
        },
      },
      // GET /history/:id/plan - Get historical release plan
      {
        method: 'GET',
        path: RELEASE_ROUTES.HISTORY_PLAN,
        handler: './rest/handlers/history-plan-handler.js#default',
        output: {
          zod: '@kb-labs/release-manager-contracts#HistoryPlanResponseSchema',
        },
      },
      // GET /history/:id/changelog - Get historical changelog
      {
        method: 'GET',
        path: RELEASE_ROUTES.HISTORY_CHANGELOG,
        handler: './rest/handlers/history-changelog-handler.js#default',
        output: {
          zod: '@kb-labs/release-manager-contracts#HistoryChangelogResponseSchema',
        },
      },
      // GET /git-timeline - Get git commit timeline and version preview
      {
        method: 'GET',
        path: RELEASE_ROUTES.GIT_TIMELINE,
        handler: './rest/handlers/git-timeline-handler.js#default',
        output: {
          zod: '@kb-labs/release-manager-contracts#GitTimelineResponseSchema',
        },
      },
      // GET /preview - Preview package contents before publish
      {
        method: 'GET',
        path: RELEASE_ROUTES.PREVIEW,
        handler: './rest/handlers/preview-handler.js#default',
        output: {
          zod: '@kb-labs/release-manager-contracts#PreviewResponseSchema',
        },
      },
      // POST /build - Trigger package build
      {
        method: 'POST',
        path: RELEASE_ROUTES.BUILD,
        handler: './rest/handlers/build-handler.js#default',
        input: {
          zod: '@kb-labs/release-manager-contracts#BuildRequestSchema',
        },
        output: {
          zod: '@kb-labs/release-manager-contracts#BuildResponseSchema',
        },
        timeoutMs: 300000, // 5 minutes for build
      },
      // GET /checklist - Get unified release checklist status
      {
        method: 'GET',
        path: RELEASE_ROUTES.CHECKLIST,
        handler: './rest/handlers/checklist-handler.js#default',
        output: {
          zod: '@kb-labs/release-manager-contracts#ReleaseChecklistSchema',
        },
      },
      // GET /checks - Get list of configured checks (without running them)
      {
        method: 'GET',
        path: RELEASE_ROUTES.CHECKS,
        handler: './rest/handlers/get-checks-handler.js#default',
        output: {
          zod: '@kb-labs/release-manager-contracts#GetChecksResponseSchema',
        },
      },
      // POST /checks/run - Run pre-release checks from kb.config.json release.checks
      {
        method: 'POST',
        path: RELEASE_ROUTES.CHECKS_RUN,
        handler: './rest/handlers/run-checks-handler.js#default',
        input: {
          zod: '@kb-labs/release-manager-contracts#RunChecksRequestSchema',
        },
        output: {
          zod: '@kb-labs/release-manager-contracts#RunChecksResponseSchema',
        },
        timeoutMs: 600000, // 10 minutes - all checks combined
      },
    ],
  },

  // Studio V2 — Module Federation pages
  studio: {
    version: 2 as const,
    remoteName: 'releasePlugin',
    pages: [
      {
        id: 'release.overview',
        title: 'Release',
        icon: 'RocketOutlined',
        route: '/p/release',
        entry: './ReleasePage',
        order: 1,
      },
    ],
    menus: [
      {
        id: 'release',
        label: 'Release',
        icon: 'RocketOutlined',
        target: 'release.overview',
        order: 60,
      },
    ],
  },

  // Studio widgets (legacy - commented out, using new UI integration)
  // studio_legacy: {
  //   widgets: [
  //     {
  //       id: 'release.plan',
  //       kind: 'infopanel',
  //       title: 'Latest Release Plan',
  //       description: 'Shows the most recent release plan generated via `kb release plan`.',
  //       data: {
  //         source: {
  //           type: 'rest',
  //           routeId: 'plan/latest',
  //           method: 'GET',
  //         },
  //       },
  //       layoutHint: {
  //         w: 4,
  //         h: 5,
  //         minW: 3,
  //         minH: 3,
  //       },
  //     },
  //     {
  //       id: 'release.report',
  //       kind: 'cardlist',
  //       title: 'Release Report',
  //       description: 'Status of the last release execution.',
  //       data: {
  //         source: {
  //           type: 'rest',
  //           routeId: 'report/latest',
  //           method: 'GET',
  //         },
  //       },
  //       options: {
  //         layout: 'list',
  //       },
  //       layoutHint: {
  //         w: 4,
  //         h: 4,
  //         minW: 3,
  //         minH: 3,
  //       },
  //     },
  //   ],
  //   menus: [
  //     {
  //       id: 'release-menu',
  //       label: 'Release',
  //       icon: 'RocketOutlined',
  //       target: '/plugins/release/dashboard',
  //       order: 0,
  //     },
  //     {
  //       id: 'release-dashboard',
  //       label: 'Dashboard',
  //       icon: 'DashboardOutlined',
  //       parentId: 'release-menu',
  //       target: '/plugins/release/dashboard',
  //       order: 1,
  //     },
  //   ],
  //   layouts: [
  //     {
  //       id: 'release.dashboard',
  //       kind: 'grid',
  //       title: 'Release Dashboard',
  //       description: 'Overview of release planning and execution.',
  //       config: {
  //         cols: { sm: 2, md: 4, lg: 6 },
  //         rowHeight: 5,
  //       },
  //     },
  //   ],
  // },

  // Auto-detects kb.config.json section for useConfig()
  // maps to profiles[].products.release in kb.config.json
  configSection: 'release',

  capabilities: ['fs:read', 'fs:write'],

  // V3: Manifest-first permissions using composable presets
  permissions: pluginPermissions,

  // Workflow templates — composed from atomic release CLI commands
  // Registered in workflow engine and runnable via `kb workflow run plugin:@kb-labs/release/<id>`
  workflows: {
    handlers: [],
    templates: [
      {
        id: 'full-release',
        path: './workflows/templates/full-release.yaml',
        describe: 'Full release cycle: plan → checks → build → pack → approve → publish → git',
        tags: ['release', 'full'],
      },
      {
        id: 'hotfix',
        path: './workflows/templates/hotfix.yaml',
        describe: 'Quick hotfix: plan → approve → publish → git (patch bump, no checks)',
        tags: ['release', 'hotfix'],
      },
      {
        id: 'dry-run',
        path: './workflows/templates/dry-run.yaml',
        describe: 'Preview release: plan, checks, pack, changelog — no publish or git ops',
        tags: ['release', 'dry-run'],
      },
    ],
  },

  // Artifacts
  artifacts: [
    {
      id: 'release.plan.json',
      pathTemplate: '.kb/release/plan.json',
      description: 'Serialized release plan generated by `kb release plan`.',
    },
    {
      id: 'release.report.json',
      pathTemplate: '.kb/release/report.json',
      description: 'Execution report emitted by `kb release run`.',
    },
    {
      id: 'release.changelog.md',
      pathTemplate: '.kb/release/changelog.md',
      description: 'Workspace changelog output produced during release.',
    },
  ],
};

export default manifest;
