import { describe, expect, it } from 'vitest';
import manifest from '../manifest.js';

describe('host-agent CLI manifest', () => {
  it('keeps host management in the workspace namespace', () => {
    const paths = manifest.cli.commands.map(command => command.path);

    expect(paths).toContain('workspace register');
    expect(paths).toContain('workspace status');
    expect(paths).toContain('workspace list');
    expect(paths).not.toContain('agent register');
    expect(paths).not.toContain('agent status');
  });
});
