import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { flattenZodIssues, registerZodEnumIssueHint } from './schema-keys.js';

describe('flattenZodIssues enum hints', () => {
  it('uses a hint resolver registered for the enum option tuple', () => {
    const options = ['first', 'second'] as const;
    registerZodEnumIssueHint(options, (issue) => `Choose from ${issue.options.join(', ')}.`);

    const schema = z.enum(options, { errorMap: () => ({ message: 'invalid choice' }) });
    const result = schema.safeParse('unknown');
    expect(result.success).toBe(false);
    if (result.success) {return;}

    expect(flattenZodIssues(result.error)).toEqual([
      { path: '', message: 'invalid choice', hint: 'Choose from first, second.' },
    ]);
  });
});
