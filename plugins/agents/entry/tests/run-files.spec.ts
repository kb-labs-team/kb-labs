import { describe, expect, it } from 'vitest';
import { normalizeFiles, parsePositiveNumber, resolveTokenBudgetOverride } from '../src/cli/commands/run';

describe('normalizeFiles', () => {
  it('wraps a single CLI file value in an array', () => {
    expect(normalizeFiles('src/example.ts')).toEqual(['src/example.ts']);
  });

  it('preserves multiple file values', () => {
    const files = ['src/one.ts', 'src/two.ts'];
    expect(normalizeFiles(files)).toEqual(files);
  });

  it('returns an empty array when no files are provided', () => {
    expect(normalizeFiles(undefined)).toEqual([]);
  });
});

describe('resolveTokenBudgetOverride', () => {
  it('enables the configured token budget with the CLI override', () => {
    expect(resolveTokenBudgetOverride({ enabled: false, maxTokens: 100 }, '300000'))
      .toEqual({ enabled: true, maxTokens: 300000 });
  });

  it('preserves configured budget when no valid override is provided', () => {
    const configured = { enabled: true, maxTokens: 100 };
    expect(resolveTokenBudgetOverride(configured, undefined)).toBe(configured);
  });
});

describe('parsePositiveNumber', () => {
  it('parses numeric strings from CLI flags', () => {
    expect(parsePositiveNumber('1')).toBe(1);
    expect(parsePositiveNumber('300000')).toBe(300000);
  });

  it('accepts positive finite numbers and rejects empty, invalid, and non-positive values', () => {
    expect(parsePositiveNumber(2)).toBe(2);
    expect(parsePositiveNumber(undefined)).toBeUndefined();
    expect(parsePositiveNumber('')).toBeUndefined();
    expect(parsePositiveNumber('nope')).toBeUndefined();
    expect(parsePositiveNumber('0')).toBeUndefined();
    expect(parsePositiveNumber('-1')).toBeUndefined();
    expect(parsePositiveNumber('Infinity')).toBeUndefined();
  });
});
