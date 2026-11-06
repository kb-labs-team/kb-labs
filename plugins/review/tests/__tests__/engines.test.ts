import { describe, it, expect } from 'vitest';
import { eslintEngine } from '../../src/heuristic/engines/eslint.js';
import { ruffEngine } from '../../src/heuristic/engines/ruff.js';

// Regression: buildCommand must return argv array, not a shell string.
// Shell strings with file paths allow injection via crafted filenames.
describe('engine buildCommand — no shell injection', () => {
  const maliciousFile = 'foo"; rm -rf /; echo "bar.ts';

  it('eslint: returns argv array, malicious filename is a single discrete element', () => {
    const argv = eslintEngine.buildCommand([maliciousFile], '/cwd');
    expect(Array.isArray(argv)).toBe(true);
    // The malicious filename must appear as a single discrete element,
    // not split or interpreted by a shell
    expect(argv).toContain(maliciousFile);
    expect(argv.filter(a => a === maliciousFile)).toHaveLength(1);
  });

  it('ruff: returns argv array, never a shell string', () => {
    const argv = ruffEngine.buildCommand([maliciousFile], '/cwd');
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).toContain(maliciousFile);
  });

  it('eslint: each file is a separate element', () => {
    const files = ['a.ts', 'b.ts', 'path with spaces/c.ts'];
    const argv = eslintEngine.buildCommand(files, '/cwd');
    for (const f of files) {
      expect(argv).toContain(f);
    }
  });
});
