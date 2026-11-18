import { describe, expect, it } from 'vitest';
import { shouldExecutePluginViaGateway } from '../plugin-execution-routing.js';

describe('plugin execution routing', () => {
  // case: S-307.1
  it('keeps explicit secured subprocess execution on the configured local backend', () => {
    expect(shouldExecutePluginViaGateway('secured', 'subprocess')).toBe(false);
  });

  // case: S-307.1
  it('keeps explicit secured worker-pool execution on the configured local backend', () => {
    expect(shouldExecutePluginViaGateway('secured', 'worker-pool')).toBe(false);
  });

  // case: S-307.1
  it('preserves Gateway routing for secured modes without an explicit local backend', () => {
    expect(shouldExecutePluginViaGateway('secured', undefined)).toBe(true);
    expect(shouldExecutePluginViaGateway('secured', 'container')).toBe(true);
  });

  // case: S-307.1
  it('keeps local access on the local execution path', () => {
    expect(shouldExecutePluginViaGateway('local', 'subprocess')).toBe(false);
    expect(shouldExecutePluginViaGateway('local', undefined)).toBe(false);
  });
});
