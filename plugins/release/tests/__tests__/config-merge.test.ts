import { describe, expect, it } from 'vitest';
import { mergeConfigWithFlow } from '../../src/core/planner.js';

describe('mergeConfigWithFlow', () => {
  it('keeps global checks and lets a flow override only matching ids', () => {
    const config = mergeConfigWithFlow({
      checks: [
        { id: 'typecheck', command: 'pnpm', args: ['type-check'] },
        { id: 'pack-install', command: 'bash', args: ['old-pack-check'] },
      ],
      flows: {
        platform: {
          checks: [
            { id: 'pack-install', command: 'bash', args: ['strict-pack-check'] },
            { id: 'user-journey', command: 'bash', args: ['e2e'] },
          ],
        },
      },
    }, 'platform');

    expect(config.checks).toEqual([
      { id: 'typecheck', command: 'pnpm', args: ['type-check'] },
      { id: 'pack-install', command: 'bash', args: ['strict-pack-check'] },
      { id: 'user-journey', command: 'bash', args: ['e2e'] },
    ]);
  });
});
