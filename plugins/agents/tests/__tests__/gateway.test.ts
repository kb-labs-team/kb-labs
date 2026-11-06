import { describe, expect, it } from 'vitest';
import { ToolGateway } from '../../src/tools/gateway.js';

describe('ToolGateway', () => {
  it('filters definitions through policies and returns structured artifacts', async () => {
    const gateway = new ToolGateway(
      { workingDir: process.cwd() },
      [{ id: 'no-shell', allows: (toolName) => toolName !== 'shell_exec' }],
    );

    expect(gateway.getToolNames()).not.toContain('shell_exec');

    const result = await gateway.execute('fs_list', {});
    expect(result.artifact.status).toBe(result.result.success ? 'success' : 'error');
    expect(result.artifact.summary.length).toBeGreaterThan(0);
  });

  it('filters tools through capability policies without hardcoding tool names', () => {
    const gateway = new ToolGateway(
      {
        workingDir: process.cwd(),
      },
      [{
        id: 'no-shell-capability',
        allows: () => true,
        allowsCapability: (capability) => capability !== 'shell',
      }],
    );

    expect(gateway.getToolNames()).not.toContain('shell_exec');
    expect(gateway.getToolNames()).toContain('fs_read');
  });
});
