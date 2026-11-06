/**
 * @module @kb-labs/workflow-engine/manifest-converter
 *
 * Pure conversion utilities for plugin manifest declarations → WorkflowRuntime.
 * No I/O, no caching, no platform dependency — testable in isolation.
 *
 * Used by ManifestScanner which handles fetch + cache responsibilities.
 */

import type {
  WorkflowHandlerDecl,
  JobHandlerDecl,
} from '@kb-labs/plugin-contracts';
import type { WorkflowRuntime } from './manifest-scanner.js';

export class ManifestConverter {
  convertWorkflowHandler(
    pluginId: string,
    handler: WorkflowHandlerDecl,
    pluginRoot: string,
  ): WorkflowRuntime {
    const id = `${pluginId}/${handler.id}`;

    return {
      kind: 'workflow',
      id,
      source: 'manifest',
      pluginId,
      manifestPath: pluginRoot,
      name: handler.describe ?? handler.id,
      description: handler.describe,
      tags: ['plugin', pluginId],
      triggers: [{ type: 'manual' }],
      handler: handler.handler,
      status: 'active',
      permissions: handler.permissions,
      input: handler.input,
      output: handler.output,
    };
  }

  convertJobHandler(
    pluginId: string,
    handler: JobHandlerDecl,
    pluginRoot: string,
  ): WorkflowRuntime {
    const id = `${pluginId}:job:${handler.id}`;

    return {
      kind: 'job',
      id,
      source: 'manifest',
      pluginId,
      manifestPath: pluginRoot,
      name: handler.describe ?? handler.id,
      description: handler.describe,
      tags: ['plugin', 'job', pluginId],
      triggers: [{ type: 'manual' }],
      handler: handler.handler,
      status: 'active',
      permissions: handler.permissions,
      input: handler.input,
      output: handler.output,
    };
  }

}
