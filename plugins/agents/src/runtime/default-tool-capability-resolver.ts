import type { ToolCapabilityResolver } from '../sdk/index.js';
import type { ToolCapability } from '../contracts/index.js';

const DEFAULT_CAPABILITIES: ToolCapability[] = [
  'filesystem',
  'search',
  'code-navigation',
  'shell',
  'memory',
  'planning',
  'todo',
  'interaction',
  'reporting',
  'delegation',
];

export function createDefaultToolCapabilityResolver(): ToolCapabilityResolver {
  return {
    id: 'default-tool-capability-resolver',
    resolve() {
      return DEFAULT_CAPABILITIES;
    },
  };
}
