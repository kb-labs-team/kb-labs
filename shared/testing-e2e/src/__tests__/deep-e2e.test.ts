import { afterEach, describe, expect, it } from 'vitest';
import { isDeepAgentE2EEnabled } from '../deep-e2e.js';

const originalValue = process.env.KB_AGENTS_E2E_DEEP;

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.KB_AGENTS_E2E_DEEP;
  } else {
    process.env.KB_AGENTS_E2E_DEEP = originalValue;
  }
});

describe('isDeepAgentE2EEnabled', () => {
  it.each(['1', 'true', 'TRUE'])('enables deep scenarios for %s', (value) => {
    process.env.KB_AGENTS_E2E_DEEP = value;
    expect(isDeepAgentE2EEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'no', ''])('does not enable deep scenarios for %j', (value) => {
    process.env.KB_AGENTS_E2E_DEEP = value;
    expect(isDeepAgentE2EEnabled()).toBe(false);
  });
});
