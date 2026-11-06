/**
 * bootstrapAgentSDK — registers SDKAgentRunner as the RunnerFactory.
 *
 * Call this exactly once at application startup, before any sdk.createRunner() call.
 * Typically called at the top of the CLI entry point (agent:run command).
 *
 * @example
 *   import { bootstrapAgentSDK } from '@kb-labs/agents/core';
 *   bootstrapAgentSDK();
 *   const runner = new AgentSDK().register(pack).createRunner(config);
 */

import { AgentSDK } from '../../sdk/index.js';
import { SDKAgentRunner } from './runner.js';

export function bootstrapAgentSDK(): void {
  AgentSDK.setRunnerFactory((config, sdk) => new SDKAgentRunner(config, sdk));
}
