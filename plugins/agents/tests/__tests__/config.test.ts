import { describe, it, expect } from 'vitest';
import {
  FILESYSTEM_CONFIG,
  SEARCH_CONFIG,
  SHELL_CONFIG,
  TODO_CONFIG,
  DELEGATION_CONFIG,
  SOURCE_FILE_EXTENSIONS,
  ALL_SOURCE_EXTENSIONS,
  toRgIncludes,
  toFindNames,
} from '../../src/tools/config.js';

describe('FILESYSTEM_CONFIG', () => {
  it('has sensible limits', () => {
    expect(FILESYSTEM_CONFIG.maxFileSize).toBeGreaterThan(0);
    expect(FILESYSTEM_CONFIG.maxLinesPerRead).toBeGreaterThanOrEqual(FILESYSTEM_CONFIG.defaultLines);
    expect(FILESYSTEM_CONFIG.maxWriteSize).toBeGreaterThan(FILESYSTEM_CONFIG.maxFileSize);
    expect(FILESYSTEM_CONFIG.maxListLimit).toBeGreaterThan(FILESYSTEM_CONFIG.defaultListLimit);
  });
});

describe('SEARCH_CONFIG', () => {
  it('has sensible limits', () => {
    expect(SEARCH_CONFIG.timeoutMs).toBeGreaterThan(0);
    expect(SEARCH_CONFIG.maxBuffer).toBeGreaterThan(0);
    expect(SEARCH_CONFIG.maxResultLimit).toBeGreaterThan(SEARCH_CONFIG.defaultResultLimit);
  });

  it('defaultExcludes includes common noise dirs', () => {
    expect(SEARCH_CONFIG.defaultExcludes).toContain('node_modules');
    expect(SEARCH_CONFIG.defaultExcludes).toContain('dist');
    expect(SEARCH_CONFIG.defaultExcludes).toContain('.git');
  });
});

describe('SHELL_CONFIG', () => {
  it('maxBuffer is a positive number', () => {
    expect(SHELL_CONFIG.maxBuffer).toBeGreaterThan(0);
  });
});

describe('TODO_CONFIG', () => {
  it('cacheTtlMs is 7 days', () => {
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(TODO_CONFIG.cacheTtlMs).toBe(sevenDays);
  });

  it('cachePrefix has agent namespace', () => {
    expect(TODO_CONFIG.cachePrefix).toMatch(/^agent:/);
  });
});

describe('DELEGATION_CONFIG', () => {
  it('defaultMaxIterations is positive', () => {
    expect(DELEGATION_CONFIG.defaultMaxIterations).toBeGreaterThan(0);
  });
});

describe('SOURCE_FILE_EXTENSIONS', () => {
  it('covers TypeScript and JavaScript', () => {
    expect(SOURCE_FILE_EXTENSIONS.typescript).toContain('ts');
    expect(SOURCE_FILE_EXTENSIONS.typescript).toContain('tsx');
    expect(SOURCE_FILE_EXTENSIONS.javascript).toContain('js');
    expect(SOURCE_FILE_EXTENSIONS.javascript).toContain('jsx');
  });

  it('covers common backend languages', () => {
    expect(SOURCE_FILE_EXTENSIONS.python).toContain('py');
    expect(SOURCE_FILE_EXTENSIONS.go).toContain('go');
    expect(SOURCE_FILE_EXTENSIONS.rust).toContain('rs');
  });
});

describe('ALL_SOURCE_EXTENSIONS', () => {
  it('is flat list including ts, py, go', () => {
    expect(ALL_SOURCE_EXTENSIONS).toContain('ts');
    expect(ALL_SOURCE_EXTENSIONS).toContain('py');
    expect(ALL_SOURCE_EXTENSIONS).toContain('go');
  });

  it('has no duplicates', () => {
    const unique = new Set(ALL_SOURCE_EXTENSIONS);
    expect(unique.size).toBe(ALL_SOURCE_EXTENSIONS.length);
  });
});

describe('toRgIncludes', () => {
  it('builds --include flags for ripgrep', () => {
    const result = toRgIncludes(['ts', 'tsx']);
    expect(result).toBe("--include='*.ts' --include='*.tsx'");
  });

  it('handles single extension', () => {
    expect(toRgIncludes(['py'])).toBe("--include='*.py'");
  });

  it('handles empty array', () => {
    expect(toRgIncludes([])).toBe('');
  });
});

describe('toFindNames', () => {
  it('builds -name flags joined with -o for find', () => {
    const result = toFindNames(['ts', 'tsx']);
    expect(result).toBe("-name '*.ts' -o -name '*.tsx'");
  });

  it('handles single extension', () => {
    expect(toFindNames(['py'])).toBe("-name '*.py'");
  });

  it('handles empty array', () => {
    expect(toFindNames([])).toBe('');
  });
});
