/**
 * Error definitions for Plugin Template
 *
 * Uses defineError() from @kb-labs/sdk for type-safe error handling.
 *
 * @example
 * ```typescript
 * import { TemplateError } from './utils/errors';
 *
 * throw new TemplateError.BusinessRuleViolation('Insufficient funds');
 * throw new TemplateError.QuotaExceeded('api_requests');
 * throw new TemplateError.MissingConfig('apiKey');
 * ```
 */

import { defineError, PluginError, commonErrors } from '@kb-labs/sdk';

/**
 * Template-specific errors
 */
export const TemplateError = defineError('TEMPLATE', {
  BusinessRuleViolation: {
    code: 400,
    message: (rule: string) => `Business rule violated: ${rule}`,
    hint: 'Update the input to satisfy the reported rule, then retry.',
  },
  QuotaExceeded: {
    code: 429,
    message: (resource: string) => `Quota exceeded for ${resource}`,
    hint: 'Wait for quota to reset or request a higher limit, then retry.',
  },
  MissingConfig: {
    code: 500,
    message: (key: string) => `Missing configuration: ${key}`,
    hint: 'Set the named configuration value and retry the command.',
  },
});

/**
 * Common errors (validation, not found, etc.)
 */
export const CommonError = defineError('COMMON', commonErrors);

export { PluginError };
