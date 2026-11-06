/**
 * platform:sync — reconcile filesystem with .kb/marketplace.lock.
 *
 * Behaves as a provisioning step:
 *   - dev / monorepo  → validate mode (no installs)
 *   - prod / Docker   → reconcile mode (installs missing marketplace entries)
 *   - auto            → detect from workspace layout
 */

import { defineSystemCommand, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { platformSync, type PlatformSyncMode, type PlatformSyncResult } from '@kb-labs/core-runtime';
import { generateExamples } from '../../../utils/generate-examples';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import { getResolvedCatalog } from '../../../registry/discovery-state.js';

type PlatformSyncFlags = {
  json: { type: 'boolean'; description?: string };
  mode: { type: 'string'; description?: string };
  'dry-run': { type: 'boolean'; description?: string };
  root: { type: 'string'; description?: string };
};

type PlatformSyncCommandResult = CommandResult & PlatformSyncResult;

function isMode(value: string | undefined): value is PlatformSyncMode {
  return value === 'validate' || value === 'reconcile' || value === 'auto';
}

export const platformSyncCommand = defineSystemCommand<PlatformSyncFlags, PlatformSyncCommandResult>({
  name: 'provision',
  scope: 'platform',
  jsonTest: { safeArgs: ["--mode", "validate"] },
  description: 'Reconcile .kb/marketplace.lock with installed adapters & plugins',
  longDescription:
    'Reads .kb/marketplace.lock as the declarative source of truth for which adapters ' +
    'and plugins this installation needs, and makes the filesystem match. ' +
    'In monorepo/dev mode it only validates. In prod/Docker build mode it installs ' +
    'missing marketplace packages via pnpm.',
  category: 'platform',
  examples: generateExamples('platform provision', 'kb', [
    { flags: {} },
    { flags: { mode: 'validate' } },
    { flags: { mode: 'reconcile', json: true } },
    { flags: { 'dry-run': true } },
  ]),
  flags: {
    json: { type: 'boolean', description: 'Output machine-readable JSON' },
    mode: {
      type: 'string',
      description: 'Sync mode: validate | reconcile | auto (default: auto)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Never install, fail on drift',
    },
    root: {
      type: 'string',
      description: 'Workspace root (default: current working directory)',
    },
  },
  analytics: {
    command: 'platform.sync',
    startEvent: 'PLATFORM_SYNC_STARTED',
    finishEvent: 'PLATFORM_SYNC_FINISHED',
  },
  async handler(ctx, _argv, flags) {
    const cwd = getContextCwd(ctx);
    const root = (flags.root as string | undefined) ?? cwd;
    const modeFlag = flags.mode as string | undefined;
    const mode: PlatformSyncMode = isMode(modeFlag) ? modeFlag : 'auto';
    const dryRun = Boolean(flags['dry-run']);

    const logger = ctx.platform?.logger;
    logger?.info('platform sync started', { root, mode, dryRun });

    const result = await platformSync({
      root,
      catalog: getResolvedCatalog()!,
      mode,
      dryRun,
      logger,
    });

    logger?.info('platform sync finished', {
      ok: result.ok,
      mode: result.mode,
      checked: result.checked,
      missing: result.missing.length,
      mismatched: result.mismatched.length,
      installed: result.installed.length,
      errors: result.errors.length,
    });

    if (result.ok) {
      return result;
    }

    throwSystemCommandError(
      result.errors.map(({ message }) => message).join('; ') || 'Platform sync failed',
      'Run `kb platform sync --help` to review recovery steps, then retry.',
      undefined,
      result.errors.map(({ message }) => ({ code: 'KB_RUNTIME_COMMAND_FAILED', message, severity: 'error' as const })),
    );
  },
  // eslint-disable-next-line sonarjs/cognitive-complexity
  formatter(result, ctx, flags) {
    const sync = result;

    const summary: string[] = [
      `Mode: ${sync.mode}${sync.mode !== (flags.mode as string | undefined) && flags.mode !== 'auto' ? ' (auto-detected)' : ''}`,
      `Checked: ${sync.checked}`,
    ];
    if (sync.lockMissing) {
      summary.push('Lock: not found (nothing to reconcile)');
    }
    if (sync.installed.length) {
      summary.push(`Installed: ${sync.installed.length}`);
    }
    if (sync.missing.length) {
      summary.push(`Missing: ${sync.missing.length}`);
    }
    if (sync.mismatched.length) {
      summary.push(`Integrity mismatch: ${sync.mismatched.length}`);
    }
    if (sync.errors.length) {
      summary.push(`Errors: ${sync.errors.length}`);
    }

    const sections: Array<{ header: string; items: string[] }> = [
      { header: 'Summary', items: summary },
    ];

    if (sync.installed.length) {
      sections.push({
        header: 'Installed',
        items: sync.installed.map((id) => `• ${id}`),
      });
    }
    if (sync.missing.length) {
      sections.push({
        header: 'Missing',
        items: sync.missing.map((id) => `• ${id}`),
      });
    }
    if (sync.mismatched.length) {
      sections.push({
        header: 'Integrity mismatch',
        items: sync.mismatched.map((id) => `• ${id}`),
      });
    }
    if (sync.errors.length) {
      sections.push({
        header: 'Errors',
        items: sync.errors.map((e) => `• ${e.packageId}: ${e.message}`),
      });
    }

    const nextSteps: string[] = [];
    if (!sync.ok) {
      if (sync.missing.length && sync.mode === 'validate') {
        nextSteps.push('kb platform provision --mode reconcile   Install missing packages');
      }
      if (sync.mismatched.length) {
        nextSteps.push('kb marketplace install <pkg>             Re-install mismatched packages');
      }
    }
    if (nextSteps.length) {
      sections.push({ header: 'Next Steps', items: nextSteps });
    }

    if (sync.ok) {
      ctx.ui.success('Platform Sync', { sections });
    } else {

    }
  },
});
