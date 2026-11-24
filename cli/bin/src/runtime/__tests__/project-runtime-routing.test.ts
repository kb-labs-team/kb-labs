import { describe, expect, it } from 'vitest';
import { shouldUseInstalledProjectRuntime } from '../project-runtime-routing.js';

describe('installed project runtime routing', () => {
  it('selects the host-owned route only for a verified installed secured project', () => {
    expect(shouldUseInstalledProjectRuntime({
      accessMode: 'secured', projectScope: 'required', installationId: 'install-a',
    })).toBe(true);
  });

  it.each([
    { accessMode: 'local', projectScope: 'required' as const, installationId: 'install-a' },
    { accessMode: 'secured', projectScope: 'platform' as const, installationId: 'install-a' },
    { accessMode: 'secured', projectScope: 'required' as const },
    { accessMode: 'secured', projectScope: 'required' as const, installationId: 'install-a', explicitGatewayUrl: 'https://other.test' },
  ])('preserves existing routing for $accessMode scope=$projectScope explicit=$explicitGatewayUrl', (input) => {
    expect(shouldUseInstalledProjectRuntime(input)).toBe(false);
  });
});
