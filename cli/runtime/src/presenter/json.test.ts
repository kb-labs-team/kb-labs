import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJsonPresenter } from './json.js';

describe('JSON presenter envelope', () => {
  afterEach(() => vi.restoreAllMocks());

  // case: S-203.1
  it('writes the command boundary envelope without interpreting payload fields', () => {
    const stdout = vi.fn();

    createJsonPresenter(stdout).json({ ok: true, data: { ok: true, plugins: [] } });

    expect(stdout).toHaveBeenCalledOnce();
    expect(stdout.mock.calls[0]?.[0]).toEqual({
      ok: true,
      data: { ok: true, plugins: [] },
    });
  });

  // case: S-203.2
  it('writes the command boundary failure envelope unchanged', () => {
    const stdout = vi.fn();

    createJsonPresenter(stdout).json({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID' } });

    const result = stdout.mock.calls[0]?.[0];
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_INPUT_INVALID' },
    });
  });
});
