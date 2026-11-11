import { ErrorEnvelopeError } from '@kb-labs/core-platform';
import { getCatalogEntry } from '@kb-labs/core-platform/error-envelope';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireProjectContext } from '../project-context.js';

afterEach(() => vi.unstubAllEnvs());

describe('requireProjectContext', () => {
  it('returns a registered project root', () => {
    expect(requireProjectContext('/workspace/project', '/outside')).toBe('/workspace/project');
  });

  it('raises the catalogued project error when the root is absent', () => {
    let caught: unknown;
    try {
      requireProjectContext(undefined, '/workspace/unregistered');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ErrorEnvelopeError);
    if (caught instanceof ErrorEnvelopeError) {
      const entry = getCatalogEntry('KB_PROJECT_UNKNOWN');
      const values = { path: '/workspace/unregistered' };
      expect(caught.envelope).toMatchObject({
        code: 'KB_PROJECT_UNKNOWN',
        message: entry.message.replace('{path}', values.path),
        hint: entry.hint.replace('{path}', values.path),
      });
    }
  });

  // case: S-051.1
  it('redacts the active HOME prefix in the catalogued project error', () => {
    vi.stubEnv('HOME', '/fixture/home');
    let caught: unknown;
    try {
      requireProjectContext(undefined, '/fixture/home/unregistered');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ErrorEnvelopeError);
    if (caught instanceof ErrorEnvelopeError) {
      const entry = getCatalogEntry('KB_PROJECT_UNKNOWN');
      expect(caught.envelope.details).toMatchObject({ path: '~/unregistered' });
      expect(caught.envelope.message).toBe(entry.message.replace('{path}', '~/unregistered'));
      expect(caught.envelope.hint).toBe(entry.hint.replace('{path}', '~/unregistered'));
      expect(caught.envelope.cause).toBeUndefined();
    }
  });
});
