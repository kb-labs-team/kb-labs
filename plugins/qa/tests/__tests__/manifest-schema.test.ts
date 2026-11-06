import { describe, expect, it } from 'vitest';
import { manifest } from '../../src/manifest.js';

describe('QA CLI manifest', () => {
  it('places case coverage under a noun followed by the show verb', () => {
    const command = manifest.cli?.commands.find(({ path }) => path === 'qa coverage show');
    expect(command?.examples).toContain('kb qa coverage show --level release --json');
  });

  // case: S-203.21
  it('declares lowercase kebab-case CLI flag names so commands register', () => {
    const flags = manifest.cli?.commands.flatMap(command => command.flags ?? []) ?? [];
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every(flag => /^[a-z0-9-]+$/.test(flag.name))).toBe(true);
    expect(flags.map(flag => flag.name)).toContain('run-id');
    expect(flags.map(flag => flag.name)).toContain('exclude-job');
  });
});
