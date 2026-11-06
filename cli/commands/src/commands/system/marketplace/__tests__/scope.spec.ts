import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registryRoot, resolveRegisteredRoot } = vi.hoisted(() => ({
  registryRoot: vi.fn(),
  resolveRegisteredRoot: vi.fn(),
}));
vi.mock('@kb-labs/core-workspace', () => ({
  findRegisteredProjectRoot: registryRoot,
  resolveProjectRoot: resolveRegisteredRoot,
}));

import { resolveCliScope } from '../scope.js';

describe('marketplace CLI project scope', () => {
  beforeEach(() => {
    registryRoot.mockReset();
    resolveRegisteredRoot.mockReset();
  });

  // case: S-204.3
  it('selects the registered project containing cwd for implicit scope', async () => {
    registryRoot.mockResolvedValue('/projects/alpha');

    await expect(resolveCliScope('/projects/alpha/packages/app', undefined)).resolves.toEqual({
      scope: 'project',
      projectRoot: '/projects/alpha',
      reason: 'auto-detect',
    });
  });

  it('requires registry membership when project scope is explicitly requested', async () => {
    const unknown = Object.assign(new Error('unknown project'), { code: 'KB_PROJECT_UNKNOWN' });
    resolveRegisteredRoot.mockRejectedValue(unknown);

    await expect(resolveCliScope('/unregistered', 'project')).rejects.toMatchObject({
      code: 'KB_PROJECT_UNKNOWN',
    });
  });
});
