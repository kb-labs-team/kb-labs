import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanQACaseClaims } from '../../src/core/cases/claims.js';

describe('workspace case annotations', () => {
  it('places every unit claim directly above a supported test declaration', () => {
    const result = scanQACaseClaims(resolve('../..'), []);
    expect(result.diagnostics.filter(diagnostic => diagnostic.message.includes('must be directly above'))).toEqual([]);
  });
});
