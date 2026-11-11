/**
 * System command groups - Organized categories for system commands
 *
 */

import { defineSystemCommandGroup } from '@kb-labs/shared-command-kit';
import { hello } from './hello';
import { version } from './version';
import { health } from './health';
import { registryDiagnostics } from './registry-diagnostics';
import { registryCommands } from './registry-commands';
import { docsGenerateCliReference } from './docs-generate-cli-reference';
import { logsDiagnose, logsContext, logsSummarize, logsQuery, logsSearch, logsGet, logsStats } from './logs';
import { authLogin, authLogout, authStatus, authRegister, authResetLink, authTokens } from './auth';
import { platformSyncCommand } from './platform/sync';
import { webhookProvision, webhookList, webhookRevoke, webhookHistory } from './webhook';
import { configShow, configGet, configSet } from './config';
import { projectAdd, projectList, projectShow, projectRemove } from './project';
import { mcpConfig } from './mcp';
import { adapterBind, adapterList, adapterUnbind } from './adapter';
import { workspaceAgentGroup } from './workspace-agent';
import { marketplaceGroup } from './marketplace';
import { scaffoldGroup } from '@kb-labs/scaffold';

/**
 * Info Commands Group
 */
export const infoGroup = defineSystemCommandGroup('info', 'System information commands', [
  hello,
  version,
  health,
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
  registryCommands,
]);

/**
 * Auth Commands Group
 */
export const authGroup = defineSystemCommandGroup('auth', 'Gateway authentication commands', [
  authLogin,
  authLogout,
  authStatus,
  authRegister,
  authResetLink,
  authTokens,
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
  webhookHistory,
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

/**
 * Project Commands Group
 *
 * Machine-level project registry (ADR-0044). Works directly against
 * `<KB_HOME>/projects.json`; no host is required.
 */
export const projectGroup = defineSystemCommandGroup('project', 'Project registry commands', [
  projectAdd,
  projectList,
  projectShow,
  projectRemove,
]);

export const mcpGroup = defineSystemCommandGroup('mcp', 'Model Context Protocol commands', [
  mcpConfig,
]);

/** Adapter commands manage platform-installed adapters and bindings. */
export const adapterGroup = defineSystemCommandGroup('adapter', 'Adapter installation and binding commands', [
  adapterList,
  adapterBind,
  adapterUnbind,
]);

/** Workspace Agent registration and connection commands. */
export const workspaceGroup = workspaceAgentGroup;
export { marketplaceGroup };
export { scaffoldGroup };
