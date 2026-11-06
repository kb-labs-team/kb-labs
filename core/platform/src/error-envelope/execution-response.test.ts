import { describe, expect, it } from 'vitest';
import { serializeError } from './execution-response.js';

describe('platform serialized execution errors', () => {
  it('preserves structured module resolution identity across execution transport', () => {
    const error = Object.assign(new Error("Cannot find package '@kb-labs/shared-command-kit'"), {
      code: 'ERR_MODULE_NOT_FOUND',
      specifier: '@kb-labs/shared-command-kit',
    });

    expect(serializeError(error)).toMatchObject({
      moduleResolution: {
        code: 'ERR_MODULE_NOT_FOUND',
        specifier: '@kb-labs/shared-command-kit',
      },
    });
  });

  it('preserves an Error stack and serializes its cause through the owner', () => {
    const cause = new Error('root cause');
    cause.stack = 'root cause stack';
    const error = new Error('handler failed', { cause });
    error.stack = 'handler stack';

    expect(serializeError(error)).toEqual({
      name: 'Error',
      message: 'handler failed',
      stack: 'handler stack',
      cause: { name: 'Error', message: 'root cause', stack: 'root cause stack' },
    });
  });

  it('gives non-Error throws one explicit name at the serialization owner', () => {
    expect(serializeError('handler threw a string')).toEqual({
      name: 'NonErrorThrown',
      message: 'handler threw a string',
    });
    expect(serializeError({ reason: 'bad input' })).toEqual({
      name: 'NonErrorThrown',
      message: '[object Object]',
    });
  });

  it('preserves a serialized error received across a process boundary', () => {
    const transported = {
      name: 'Error',
      message: 'serialized handler failure',
      stack: 'original process stack',
    };

    expect(serializeError(transported)).toBe(transported);
  });
});
