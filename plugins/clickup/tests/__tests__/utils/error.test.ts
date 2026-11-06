import { describe, expect, it } from 'vitest';
import { ClickUpApiError } from '../../../src/core/index.js';
import { handleError } from '../../../src/utils/error.js';

describe('ClickUp command errors', () => {
  it('keeps ClickUp authorization failures within the command failure catalogue contract', () => {
    const result = handleError(new ClickUpApiError(403, 'OAUTH_017', 'Access denied'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('KB_RUNTIME_COMMAND_FAILED');
      expect(Object.entries(result.error.details ?? {})).toContainEqual(['clickUpStatus', '403']);
    }
  });
});
