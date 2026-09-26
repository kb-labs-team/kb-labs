/**
 * System command groups - Organized categories for system commands
 *
 * NOTE: Marketplace commands have been migrated to the @kb-labs/marketplace-cli plugin.
 * They are now registered via ManifestV3 with subgroup support, not as system commands.
 */

import { defineSystemCommandGroup } from '@kb-labs/shared-command-kit';
import { hello } from './hello';
import { version } from './version';
import { health } from './health';
import { diag } from './diag';
import { registryDiagnostics } from './registry-diagnostics';
import { docsGenerateCliReference } from './docs-generate-cli-reference';
import { logsDiagnose, logsContext, logsSummarize, logsQuery, logsSearch, logsGet, logsStats } from './logs';
import { authLogin, authLogout, authStatus, authRegister, authResetAdmin } from './auth';
import { platformSyncCommand } from './platform/sync';
import { webhookProvision, webhookList, webhookRevoke } from './webhook';
import { configShow, configGet, configSet } from './config';

/**
 * Info Commands Group
 */
export const infoGroup = defineSystemCommandGroup('info', 'System information commands', [
  hello,
  version,
  health,
  diag,
]);

/**
 * Docs Commands Group
 */
export const docsGroup = defineSystemCommandGroup('docs', 'Documentation generation commands', [
  docsGenerateCliReference,
]);

/**
 * Logs Commands Group
 */
export const logsGroup = defineSystemCommandGroup('logs', 'Log viewing and analysis commands', [
  logsDiagnose,
  logsContext,
  logsSummarize,
  logsQuery,
  logsSearch,
  logsGet,
  logsStats,
]);

/**
 * Registry Commands Group
 */
export const registryGroup = defineSystemCommandGroup('registry', 'Entity registry commands', [
  registryDiagnostics,
]);

/**
 * Auth Commands Group
 */
export const authGroup = defineSystemCommandGroup('auth', 'Gateway authentication commands', [
  authLogin,
  authLogout,
  authStatus,
  authRegister,
  authResetAdmin,
]);

/**
 * Platform Commands Group
 *
 * Lifecycle commands for the platform itself: provisioning, validation,
 * and (in the future) info/doctor. These are distinct from:
 *   - `kb marketplace` — user-facing install/discovery
 *   - `kb dev`          — local service management
 */
export const platformGroup = defineSystemCommandGroup('platform', 'Platform lifecycle commands', [
  platformSyncCommand,
]);

/**
 * Webhook Commands Group
 *
 * Manage webhook secrets for plugin event endpoints.
 */
export const webhookGroup = defineSystemCommandGroup('webhook', 'Webhook management commands', [
  webhookProvision,
  webhookList,
  webhookRevoke,
]);

/**
 * Config Commands Group
 *
 * Read and change configuration: `show` prints the effective config with
 * per-value provenance, `get` reads one key, `set` is the single writer of the
 * user config file. See ADR-0047 (config layers), ADR-0012 (field scope policy)
 * and ADR-0013 (installer-config-placement).
 */
export const configGroup = defineSystemCommandGroup('config', 'Config commands', [
  configShow,
  configGet,
  configSet,
]);
