import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { flattenZodIssues, registerZodEnumIssueHint, resolveKeyPath } from './schema-keys.js';

describe('flattenZodIssues enum hints', () => {
  it('uses a hint resolver registered for the enum option tuple', () => {
    const options = ['first', 'second'] as const;
    registerZodEnumIssueHint(options, (issue) => `Choose from ${issue.values.join(', ')}.`);

    const schema = z.enum(options, { error: 'invalid choice' });
    const result = schema.safeParse('unknown');
    expect(result.success).toBe(false);
    if (result.success) {return;}

    expect(flattenZodIssues(result.error)).toEqual([
      { path: '', message: 'invalid choice', hint: 'Choose from first, second.' },
    ]);
  });

  it('keeps the document path when descending into a failed union', () => {
    const schema = z.object({
      platform: z.union([z.string(), z.object({ execution: z.object({ mode: z.literal('auto') }) })]),
    });
    const result = schema.safeParse({ platform: { execution: { mode: 'remote' } } });
    expect(result.success).toBe(false);
    if (result.success) {return;}

    expect(flattenZodIssues(result.error)[0]?.path).toBe('platform.execution.mode');
  });
});

it('resolves keys through an open record and a wrapped strict object', () => {
  const schema = z.record(z.string(), z.strictObject({ enabled: z.boolean() }).optional());
  expect(resolveKeyPath(schema, ['custom', 'enabled'])).toMatchObject({ status: 'ok' });
  expect(resolveKeyPath(schema, ['custom', 'enablde'])).toMatchObject({
    status: 'unknown',
    parentPath: 'custom',
    suggestion: 'enabled',
  });
});
