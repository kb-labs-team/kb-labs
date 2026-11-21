import { describe, expect, it } from 'vitest';
import { PROJECT_RUNTIME_TOKEN_ENV } from '@kb-labs/shared-daemon';
import { consumeProjectRuntimeToken } from './runtime-token.js';

describe('project runtime credential ownership', () => {
  // case: S-160.1
  it('consumes the guard credential before plugin work can inherit the environment', () => {
    const env: NodeJS.ProcessEnv = { [PROJECT_RUNTIME_TOKEN_ENV]: 'internal-guard-credential' };

    expect(consumeProjectRuntimeToken(env)).toBe('internal-guard-credential');
    expect(env).not.toHaveProperty(PROJECT_RUNTIME_TOKEN_ENV);
  });
});
