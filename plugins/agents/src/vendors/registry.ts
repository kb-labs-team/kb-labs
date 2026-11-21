import type { AgentRunFailure } from '../contracts/index.js';
import type { AgentRunnerModule } from '../sdk/index.js';

const registeredRunners = new Map<string, AgentRunnerModule>();

export class AgentRunnerResolutionError extends Error {
  readonly code = 'KB_RUNTIME_RESOURCE_NOT_FOUND';
  readonly details: { runnerId: string };
  readonly failure: AgentRunFailure;

  constructor(runnerId: string) {
    super(`Agent runner '${runnerId}' is not registered by the agents plugin.`);
    this.name = 'AgentRunnerResolutionError';
    this.details = { runnerId };
    this.failure = {
      kind: 'unknown_runner',
      code: this.code,
      message: this.message,
      retryable: false,
      details: this.details,
    };
  }
}

/** Register a runner implementation owned by this plugin's vendor modules. */
export function registerAgentRunner(runnerId: string, runner: AgentRunnerModule): void {
  if (registeredRunners.has(runnerId)) {
    throw new Error(`Agent runner '${runnerId}' is already registered.`);
  }
  registeredRunners.set(runnerId, runner);
}

/** Resolve only runners registered by the agents plugin's vendor modules. */
export async function resolveExternalRunner(runnerId: string): Promise<AgentRunnerModule> {
  const runner = registeredRunners.get(runnerId);
  if (!runner) {
    throw new AgentRunnerResolutionError(runnerId);
  }
  return runner;
}
