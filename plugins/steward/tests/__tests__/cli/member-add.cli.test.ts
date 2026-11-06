import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  addMember: vi.fn(),
}));

import { addMember } from '../../../src/core/index.js';
import command from '../../../src/commands/member-add.js';

const mockedAddMember = vi.mocked(addMember);

beforeEach(() => {
  mockedAddMember.mockReset();
});

describe('steward:member.add', () => {
  it('links a person to a project with a role and priority', async () => {
    mockedAddMember.mockResolvedValue({
      id: 'mem_1',
      personId: 'per_1',
      projectId: 'prj_1',
      role: 'lead',
      priority: 0,
      createdAt: 1,
      updatedAt: 1,
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(
      ctx,
      mockCLIInput({ flags: { person: 'per_1', project: 'prj_1', role: 'lead', priority: 0 } }),
    );

    expect(result).not.toHaveProperty('ok');
    expect(mockedAddMember).toHaveBeenCalledWith({
      personId: 'per_1',
      projectId: 'prj_1',
      role: 'lead',
      topics: undefined,
      priority: 0,
    });
    expect(captured.infos[0]?.message).toContain('lead');
  });

  it('missing --person/--project/--role is a validation error', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await command.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    if ('error' in result) {
      expect(result.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
    }
    expect(mockedAddMember).not.toHaveBeenCalled();
    if ('error' in result) { expect(result.error.hint).toBeTruthy(); }
  });
});
