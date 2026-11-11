import { describe, it, expect } from 'vitest';
import { normalizeOffsetLimit } from '../../src/tools/utils.js';

const CONFIG = { defaultLimit: 100, maxLimit: 200 };

describe('normalizeOffsetLimit', () => {
  it('returns defaults when no input provided', () => {
    expect(normalizeOffsetLimit({}, CONFIG)).toEqual({ offset: 0, limit: 100 });
  });

  it('parses valid offset and limit', () => {
    expect(normalizeOffsetLimit({ offset: 5, limit: 50 }, CONFIG)).toEqual({ offset: 5, limit: 50 });
  });

  it('floors non-integer values', () => {
    expect(normalizeOffsetLimit({ offset: 2.9, limit: 50.7 }, CONFIG)).toEqual({ offset: 2, limit: 50 });
  });

  it('clamps limit to maxLimit', () => {
    expect(normalizeOffsetLimit({ offset: 0, limit: 999 }, CONFIG)).toEqual({ offset: 0, limit: 200 });
  });

  it('treats negative offset as 0', () => {
    expect(normalizeOffsetLimit({ offset: -5, limit: 10 }, CONFIG)).toEqual({ offset: 0, limit: 10 });
  });

  it('treats zero limit as default', () => {
    expect(normalizeOffsetLimit({ offset: 0, limit: 0 }, CONFIG)).toEqual({ offset: 0, limit: 100 });
  });

  it('treats negative limit as default', () => {
    expect(normalizeOffsetLimit({ offset: 0, limit: -1 }, CONFIG)).toEqual({ offset: 0, limit: 100 });
  });

  it('treats NaN offset as 0', () => {
    expect(normalizeOffsetLimit({ offset: 'abc', limit: 10 }, CONFIG)).toEqual({ offset: 0, limit: 10 });
  });

  it('treats NaN limit as default', () => {
    expect(normalizeOffsetLimit({ offset: 0, limit: 'bad' }, CONFIG)).toEqual({ offset: 0, limit: 100 });
  });

  it('treats undefined fields as defaults', () => {
    expect(normalizeOffsetLimit({ offset: undefined, limit: undefined }, CONFIG)).toEqual({ offset: 0, limit: 100 });
  });

  it('uses caller-provided defaultLimit and maxLimit', () => {
    const custom = { defaultLimit: 25, maxLimit: 50 };
    expect(normalizeOffsetLimit({ limit: 999 }, custom)).toEqual({ offset: 0, limit: 50 });
    expect(normalizeOffsetLimit({}, custom)).toEqual({ offset: 0, limit: 25 });
  });
});
