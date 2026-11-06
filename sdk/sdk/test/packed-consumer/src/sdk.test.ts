import { describe, expect, it } from 'vitest';
import { mockLogger } from '@kb-labs/sdk/testing';
import { readSdkError } from './errors.js';

describe('packed SDK testing subpath', () => {
  it('provides SDK-owned test helpers', () => {
    expect(mockLogger().info).toBeTypeOf('function');
  });

  it('resolves the published SDK errors subpath', () => {
    expect(readSdkError('KB_CONFIG_INVALID')?.code).toBe('KB_CONFIG_INVALID');
  });
});
