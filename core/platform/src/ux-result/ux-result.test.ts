import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createUxFailureResult, createUxSuccessResult, decodeUxSuccessResult, isUxResult, validateUxResult } from './index.js';

const repositoryRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const fixturesRoot = join(repositoryRoot, 'core/platform/contracts/ux-result/fixtures');

function loadFixtures(kind: 'valid' | 'invalid'): Array<{ name: string; value: unknown }> {
  const directory = join(fixturesRoot, kind);
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ name: file, value: JSON.parse(readFileSync(join(directory, file), 'utf8')) as unknown }));
}

describe('shared UX-result fixtures', () => {
  // case: S-203.1
  it('decodes only valid success envelopes', () => {
    expect(decodeUxSuccessResult<{ answer: number }>({ ok: true, data: { answer: 42 } })).toEqual({ answer: 42 });
    expect(() => decodeUxSuccessResult({ answer: 42 })).toThrow(/valid UX success envelope/);
    expect(() => decodeUxSuccessResult({ ok: false, error: {} })).toThrow(/valid UX success envelope/);
  });

  it('constructs success and failure results with the shared contract shapes', () => {
    const failureFixture = JSON.parse(readFileSync(join(fixturesRoot, 'valid/failure.json'), 'utf8')) as { error: Parameters<typeof createUxFailureResult>[0] };
    const success = createUxSuccessResult({ id: 'item-1' }, { requestId: 'req-1' });
    const failure = createUxFailureResult(failureFixture.error);

    expect(success).toEqual({ ok: true, data: { id: 'item-1' }, meta: { requestId: 'req-1' } });
    expect(failure).toEqual(failureFixture);
    expect(isUxResult(success)).toBe(true);
    expect(isUxResult(failure)).toBe(true);
  });

  it('rejects undefined success data so JSON serialization cannot remove the required data field', () => {
    expect(() => Reflect.apply(createUxSuccessResult, undefined, [undefined])).toThrow(/data must be defined/);
  });

  for (const { name, value } of loadFixtures('valid')) {
    // case: S-203.5
    it(`accepts valid/${name}`, () => {
      expect(validateUxResult(value)).toEqual([]);
      expect(isUxResult(value)).toBe(true);
    });
  }

  for (const { name, value } of loadFixtures('invalid')) {
    // case: S-203.5
    it(`rejects invalid/${name}`, () => {
      expect(validateUxResult(value).length).toBeGreaterThan(0);
      expect(isUxResult(value)).toBe(false);
    });
  }
});
