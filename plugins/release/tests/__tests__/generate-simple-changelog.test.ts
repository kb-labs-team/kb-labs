import { describe, it, expect } from 'vitest';
import { generateSimpleChangelog } from '../../src/changelog/changelog-generator';
import type { ChangelogPackageInfo } from '../../src/changelog/changelog-generator';

function makePkgs(count: number): ChangelogPackageInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `@scope/pkg-${i}`,
    path: `/tmp/pkg-${i}`,
    currentVersion: '1.0.0',
    nextVersion: '1.1.0',
    bump: 'minor' as const,
  }));
}

describe('generateSimpleChangelog — lockstep package table collapsing', () => {
  it('renders the package table inline for a small release', () => {
    const md = generateSimpleChangelog(makePkgs(3));
    expect(md).not.toContain('<details>');
    expect(md).toContain('| Package | Previous | Bump |');
    expect(md).toContain('@scope/pkg-0');
  });

  it('wraps the package table in a collapsed <details> block for a large release', () => {
    const md = generateSimpleChangelog(makePkgs(50));
    expect(md).toContain('<details>');
    expect(md).toContain('<summary>');
    expect(md).toContain('50');
    expect(md).toContain('</details>');
    // Table content must still be present, just collapsed
    expect(md).toContain('@scope/pkg-0');
    expect(md).toContain('@scope/pkg-49');
  });
});
