import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';

vi.mock('../../http.js', () => ({
  post: vi.fn(),
}));

vi.mock('../../scope.js', () => ({
  resolveCliScope: vi.fn(),
  scopeBody: vi.fn(),
  CliScopeError: class CliScopeError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'CliScopeError';
    }
  },
}));

vi.mock('node:fs/promises', () => ({
  unlink: vi.fn(),
  default: { unlink: vi.fn() },
}));

import { post } from '../../http.js';
import { resolveCliScope, scopeBody } from '../../scope.js';
import enableCommand from '../../commands/plugins/enable.js';
import disableCommand from '../../commands/plugins/disable.js';
import addCommand from '../../commands/plugins/add.js';
import removeCommand from '../../commands/plugins/remove.js';
import { marketplaceGroup } from '../../index.js';

const marketplacePluginGroup = marketplaceGroup.subgroups?.find(({ name }) => name === 'plugins');
const marketplacePluginCommands = marketplacePluginGroup?.commands ?? [];

const mockedPost = vi.mocked(post);
const mockedResolveCliScope = vi.mocked(resolveCliScope);
const mockedScopeBody = vi.mocked(scopeBody);

const DEFAULT_SCOPE_CTX = { scope: 'project' as const, projectRoot: '/workspace', reason: 'auto-detect' as const };
const DEFAULT_SCOPE_BODY = { scope: 'project' as const, projectRoot: '/workspace' };

beforeEach(() => {
  vi.resetAllMocks();
  mockedResolveCliScope.mockResolvedValue(DEFAULT_SCOPE_CTX);
  mockedScopeBody.mockReturnValue(DEFAULT_SCOPE_BODY);
});

describe('marketplace:plugins:enable', () => {
  it('PE-01: enables plugin successfully', async () => {
    mockedPost.mockResolvedValue({ packageId: 'my-plugin', scope: 'project' });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await enableCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('PE-02: --dry-run shows intent, HTTP post is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await enableCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: { 'dry-run': true } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedPost).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('my-plugin');
  });
});

describe('marketplace:plugins:disable', () => {
  it('PD-01: disables plugin successfully', async () => {
    mockedPost.mockResolvedValue({ packageId: 'my-plugin', scope: 'project' });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await disableCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('PD-02: --dry-run shows intent, HTTP post is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await disableCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: { 'dry-run': true } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedPost).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});

describe('marketplace plugins add', () => {
  it('S-179.32: declares --json on the mutating add command', () => {
    const command = marketplacePluginCommands.find(({ name }) => name === 'add');

    expect(command).toBeDefined();
    expect(command?.flags).toContainEqual(expect.objectContaining({ name: 'json', type: 'boolean' }));
  });

  it('declares the --link and --scope flags consumed by the add handler', () => {
    const command = marketplacePluginCommands.find(({ name }) => name === 'add');

    expect(command?.flags).toContainEqual(expect.objectContaining({ name: 'link', type: 'string' }));
    expect(command?.flags).toContainEqual(expect.objectContaining({ name: 'scope', type: 'string' }));
  });

  it('registers add and remove under the existing plural plugins group', () => {
    const names = marketplacePluginCommands.map(({ name }) => name);

    expect(names).toContain('add');
    expect(names).toContain('remove');
    expect(marketplacePluginGroup?.describe).toBe('Plugin management');
    expect(marketplacePluginCommands.find(({ name }) => name === 'add')?.examples)
      .toContain('kb marketplace plugins add --link .kb/plugins/my-plugin');
    expect(marketplacePluginCommands.find(({ name }) => name === 'remove')?.examples)
      .toContain('kb marketplace plugins remove @kb-labs/my-plugin');
  });

  it('adds a project-relative local plugin successfully', async () => {
    mockedPost.mockResolvedValue({ id: 'my-plugin', scope: 'project' });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await addCommand.execute(ctx, mockCLIInput({ argv: [], flags: { link: '.kb/plugins/my-plugin' } }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
  });

  // case: S-003.8
  it('rejects absolute paths before calling the marketplace', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await addCommand.execute(ctx, mockCLIInput({ argv: [], flags: { link: '/path/to/plugin' } }));

    if (!('error' in result)) { throw new Error('expected invalid plugin add path to fail'); }
    expect(mockedPost).not.toHaveBeenCalled();
    expect(result.error.message).toContain('The --link path must be relative to the selected scope directory.');
  });
});

describe('marketplace plugins remove', () => {
  it('declares --json on the mutating remove command', () => {
    const command = marketplacePluginCommands.find(({ name }) => name === 'remove');

    expect(command).toBeDefined();
    expect(command?.flags).toContainEqual(expect.objectContaining({ name: 'json', type: 'boolean' }));
  });

  it('declares the --scope flag consumed by the remove handler', () => {
    const command = marketplacePluginCommands.find(({ name }) => name === 'remove');

    expect(command?.flags).toContainEqual(expect.objectContaining({ name: 'scope', type: 'string' }));
  });

  it('removes a project plugin registration', async () => {
    mockedPost.mockResolvedValue({ packageId: 'my-plugin', scope: 'project' });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await removeCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
  });
});

describe('marketplace:plugins:remove', () => {
  it('PU-01: removes a plugin registration successfully', async () => {
    mockedPost.mockResolvedValue({ packageId: 'my-plugin', scope: 'project' });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await removeCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('PU-02: --dry-run shows intent, HTTP post is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });

    const result = await removeCommand.execute(ctx, mockCLIInput({ argv: ['my-plugin'], flags: { 'dry-run': true } }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedPost).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});
