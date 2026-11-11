# Utilities

This folder contains shared utility functions, constants, and helpers used across the plugin.

## Structure

```
utils/
├── logger.ts          # Logger adapter (DEPRECATED - use ctx.logger)
├── constants.ts       # Shared constants
├── errors.ts          # Error handling utilities (TODO)
└── index.ts          # Barrel export
```

## What Goes in Utils?

**Utils is for framework-agnostic helpers:**
- Constants and enums
- Type guards and validators
- String formatting functions
- Date/time utilities
- Error classes
- Pure helper functions

**Utils should NOT:**
- Import from CLI/REST/Studio (leaf module)
- Contain business logic (use `core/` instead)
- Have side effects or state

## Adding Utilities

### Constants

```typescript
// constants.ts
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_RETRY_ATTEMPTS = 3;
export const API_TIMEOUT_MS = 5000;

export const STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed'
} as const;

export type Status = typeof STATUS[keyof typeof STATUS];
```

### Error Classes

```typescript
// errors.ts
export class ValidationError extends Error {
  constructor(
    message: string,
    public field: string,
    public code: string = 'VALIDATION_ERROR'
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(
    public resourceType: string,
    public resourceId: string
  ) {
    super(`${resourceType} not found: ${resourceId}`);
    this.name = 'NotFoundError';
  }
}

export function createError(
  code: string,
  message: string,
  meta?: Record<string, unknown>
): Error {
  const error = new Error(message);
  (error as any).code = code;
  (error as any).meta = meta;
  return error;
}
```

### Type Guards

```typescript
// type-guards.ts
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}
```

### Validators

```typescript
// validators.ts
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function validateRequired<T>(
  value: T | null | undefined,
  field: string
): T {
  if (value === null || value === undefined) {
    throw new ValidationError(`${field} is required`, field);
  }
  return value;
}
```

### String Utilities

```typescript
// string-utils.ts
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}
```

### Date/Time Utilities

```typescript
// date-utils.ts
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function formatDateTime(date: Date): string {
  return date.toISOString();
}

export function isExpired(expiryDate: Date): boolean {
  return expiryDate < new Date();
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
```

### Array Utilities

```typescript
// array-utils.ts
export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

export function groupBy<T>(
  arr: T[],
  keyFn: (item: T) => string
): Record<string, T[]> {
  return arr.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = acc[key] || [];
    acc[key].push(item);
    return acc;
  }, {} as Record<string, T[]>);
}
```

### Retry Logic

```typescript
// retry.ts
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    delayMs?: number;
    onRetry?: (attempt: number, error: Error) => void;
  } = {}
): Promise<T> {
  const { maxAttempts = 3, delayMs = 1000, onRetry } = options;

  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxAttempts) {
        onRetry?.(attempt, lastError);
        await sleep(delayMs * attempt); // Exponential backoff
      }
    }
  }

  throw lastError!;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

## Best Practices

### ✅ DO

- **Keep functions pure** - no side effects
- **Make functions small** - single responsibility
- **Export types** - alongside functions
- **Document complex logic** - JSDoc comments
- **Write tests** - utilities are easy to test

### ❌ DON'T

- Don't import from CLI/REST/Studio/Core
- Don't access global state or environment
- Don't have side effects (logging, fs, network)
- Don't put business logic here (use `core/`)

## Testing Utilities

Utilities are the easiest to test - pure functions:

```typescript
import { describe, it, expect } from 'vitest';
import { slugify, truncate, isValidEmail } from './string-utils.js';

describe('string-utils', () => {
  describe('slugify', () => {
    it('should convert to lowercase', () => {
      expect(slugify('Hello World')).toBe('hello-world');
    });

    it('should replace spaces with dashes', () => {
      expect(slugify('foo bar baz')).toBe('foo-bar-baz');
    });

    it('should remove special characters', () => {
      expect(slugify('Hello@World!')).toBe('helloworld');
    });
  });

  describe('truncate', () => {
    it('should not truncate short strings', () => {
      expect(truncate('Hello', 10)).toBe('Hello');
    });

    it('should truncate long strings', () => {
      expect(truncate('Hello World', 8)).toBe('Hello...');
    });
  });

  describe('isValidEmail', () => {
    it('should validate correct emails', () => {
      expect(isValidEmail('user@example.com')).toBe(true);
    });

    it('should reject invalid emails', () => {
      expect(isValidEmail('not-an-email')).toBe(false);
      expect(isValidEmail('@example.com')).toBe(false);
    });
  });
});
```

## Examples

Current utilities:

- [constants.ts](./constants.ts) - Default greeting target
- [logger.ts](./logger.ts) - **DEPRECATED** - Use `ctx.logger` instead

Recommended additions (TODO):

- `errors.ts` - Error classes and factories
- `validators.ts` - Common validation functions
- `string-utils.ts` - String manipulation helpers
- `array-utils.ts` - Array helpers (unique, groupBy, etc.)

## Logger (Deprecated)

**⚠️ DEPRECATED:** `createConsoleLogger()` is deprecated. Use `ctx.logger` instead.

```typescript
// ❌ OLD (deprecated):
import { createConsoleLogger } from './utils/logger.js';
const logger = createConsoleLogger('my-module');
logger.log('info', 'Hello');

// ✅ NEW (correct):
export const run = defineCommand({
  async handler(ctx, argv, flags) {
    ctx.logger?.info('Hello', { meta });
  }
});
```

## Related Documentation

- [Architecture Guide](../../../docs/architecture.md)
- [Core README](../core/README.md) - For business logic
- [Error Handling Guide](../../../docs/error-handling.md) (TODO)
