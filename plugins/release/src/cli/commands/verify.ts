/**
 * Release verify command — validate release readiness via flag gates.
 * Package verification and release checks belong in release:run pipeline.
 */

import { defineCommand, type CLIInput, type CommandResult, type PluginCommandContextV3, useConfig } from '@kb-labs/sdk';
import { planRelease, type VersionBump, type ReleaseConfig } from '../../core/index.js';
import { resolveGitRange, parseCommits } from '../../changelog/index.js';
import { findRepoRoot } from '../../shared/utils';

interface VerifyFlags {
  scope?: string;
  bump?: 'patch' | 'minor' | 'major' | 'auto';
  'fail-if-empty'?: boolean;
  'fail-on-breaking'?: boolean;
  'allow-types'?: string;
  json?: boolean;
}

type ReleaseVerifyResult = CommandResult<unknown>;

// ── helpers ────────────────────────────────────────────────────────────────

function isBreakingChange(pkg: { currentVersion?: string; nextVersion?: string }): boolean {
  if (!pkg.currentVersion || !pkg.nextVersion) {
    return false;
  }
  const currentMajor = parseInt(pkg.currentVersion.split('.')[0] || '0');
  const nextMajor = parseInt(pkg.nextVersion.split('.')[0] || '0');
  return nextMajor > currentMajor;
}

function buildVerifySections(
  isValid: boolean,
  hasPackages: boolean,
  hasBreaking: boolean,
  issues: string[],
  symbols: { error: string },
): Array<{ header?: string; items: string[] }> {
  const sections: Array<{ header?: string; items: string[] }> = [
    {
      header: 'Status',
      items: [
        `Has Packages: ${hasPackages ? 'Yes' : 'No'}`,
        `Has Breaking Changes: ${hasBreaking ? 'Yes' : 'No'}`,
        `Result: ${isValid ? 'Valid for release' : 'Blocked'}`,
      ],
    },
  ];

  if (issues.length > 0) {
    sections.push({
      header: 'Issues',
      items: issues.map(issue => `${symbols.error} ${issue}`),
    });
  }

  return sections;
}

export default defineCommand({
  id: 'release:verify',
  description: 'Validate release readiness',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<VerifyFlags>): Promise<ReleaseVerifyResult> {
      const { flags } = input;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      const fileConfig = await useConfig<ReleaseConfig>();
      const config: ReleaseConfig = {
        ...fileConfig,
        ...(flags.bump && { bump: flags.bump }),
      };

      const plan = await planRelease({
        cwd: repoRoot,
        config,
        scope: flags.scope,
        bumpOverride: flags.bump as VersionBump | undefined,
      });

      const hasPackages = plan.packages.length > 0;
      const hasBreaking = plan.packages.some(isBreakingChange);

      let isValid = true;
      const issues: string[] = [];

      if (flags['fail-if-empty'] && !hasPackages) {
        isValid = false;
        issues.push('No packages to release (--fail-if-empty)');
      }

      if (flags['fail-on-breaking'] && hasBreaking) {
        isValid = false;
        issues.push('Breaking changes detected (--fail-on-breaking)');
      }

      if (flags['allow-types']) {
        const allowedTypes = flags['allow-types'].split(',');
        const range = await resolveGitRange({
          cwd: repoRoot,
          sinceTag: undefined,
          autoUnshallow: config.git?.autoUnshallow,
        });
        const changes = await parseCommits({
          cwd: repoRoot,
          from: range.from,
          to: range.to,
          ignoreAuthors: config.changelog?.ignoreAuthors || [],
        });
        const hasAllowedTypes = changes.some(change => allowedTypes.includes(change.type));
        if (!hasAllowedTypes) {
          isValid = false;
          issues.push(`Required types not found: ${allowedTypes.join(', ')}`);
        }
      }

      if (flags.json) {
        return { valid: isValid, hasPackages, hasBreaking, issues, plan };
      } else {
        ctx.ui?.sideBox?.({
          title: 'Release Verification',
          sections: buildVerifySections(isValid, hasPackages, hasBreaking, issues, ctx.ui.symbols),
          status: isValid ? 'success' : 'error',
        });
      }

      const result = {
        valid: isValid,
        plan,
        issues,
        breakingDetected: hasBreaking,
      };
      return isValid
        ? result
        : { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Release verification failed', hint: "Run `kb release validate --help` to review its inputs and recovery steps, then retry." } };
    },
  },
});
