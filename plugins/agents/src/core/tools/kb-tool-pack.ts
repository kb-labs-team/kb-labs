/**
 * KB Labs ToolPack — stub for future kb-labs-specific tools.
 *
 * Will include:
 * - mind-rag integration (semantic code search)
 * - workflow management tools
 * - plugin system integration
 *
 * Currently disabled by default — enabled via configuration.
 */

import type {
  ToolPack,
  ToolConflictPolicy,
  ToolPermissions,
} from '../../contracts/index.js';

/**
 * Create the KB Labs ToolPack (stub — no tools yet).
 */
export function createKBLabsToolPack(): ToolPack {
  return {
    id: 'kb-labs',
    namespace: 'kb',
    version: '0.1.0',
    priority: 50,
    conflictPolicy: 'namespace-prefix' as ToolConflictPolicy,
    tools: [],
    capabilities: [],
    permissions: {
      networkAllowed: true,
      auditTrail: true,
    } as ToolPermissions,

    enabled() {
      return false; // Disabled until tools are implemented
    },
  };
}
