import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Output } from '@kb-labs/core-sys/output';

const mocks = vi.hoisted(() => ({ initPlatform: vi.fn() }));
vi.mock('@kb-labs/core-runtime', () => ({ initPlatform: mocks.initPlatform }));

import { recreateContext } from './context-recreator.js';

describe('sandbox worker platform initialization', () => {
  beforeEach(() => mocks.initPlatform.mockReset().mockResolvedValue({}));

  // case: S-227.1
  it('passes the owning platform root and mode instead of using the project workdir', async () => {
    const context = {
      requestId: 'request',
      workdir: '/registered/project',
      pluginRoot: '/plugin',
      platformConfig: { adapters: {} },
      platformRoot: '/installed/platform',
      workspaceDevelopment: true,
    };

    await recreateContext({
      serializedCtx: context,
      sandboxOutput: {} as unknown as Output,
    });

    expect(mocks.initPlatform).toHaveBeenCalledWith(
      context.platformConfig,
      context.workdir,
      undefined,
      context.platformRoot,
      { workspaceDevelopment: true, workspaceRoot: context.platformRoot },
    );
  });

  it('refuses worker adapter initialization without explicit root and mode', async () => {
    await expect(recreateContext({
      serializedCtx: {
        requestId: 'request',
        workdir: '/registered/project',
        pluginRoot: '/plugin',
        platformConfig: { adapters: {} },
      },
      sandboxOutput: {} as unknown as Output,
    })).rejects.toThrow('platformRoot and workspaceDevelopment are required');
    expect(mocks.initPlatform).not.toHaveBeenCalled();
  });
});
