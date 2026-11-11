# Validation Examples

This document shows practical validation patterns using Zod schemas.

## Basic validation

### Required fields

```typescript
import { z } from 'zod';

const UserSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email format'),
  age: z.number().int().min(18, 'Must be 18 or older')
});

// Usage in REST handler
export const handleCreateUser = defineHandler({
  async execute(ctx, input) {
    // The route schema validates input before handler execution.
    const user = await createUser(input);
    return { userId: user.id };
  }
});
```

### Optional fields with defaults

```typescript
const SearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().default(10),
  offset: z.number().int().nonnegative().default(0),
  sort: z.enum(['asc', 'desc']).default('asc'),
  filters: z.object({
    status: z.enum(['active', 'inactive']).optional(),
    category: z.string().optional()
  }).optional()
});

type SearchInput = z.infer<typeof SearchSchema>;
// {
//   query: string;
//   limit: number;     // defaults to 10
//   offset: number;    // defaults to 0
//   sort: 'asc' | 'desc';  // defaults to 'asc'
//   filters?: {
//     status?: 'active' | 'inactive';
//     category?: string;
//   };
// }
```

## Advanced patterns

### Nested objects

```typescript
const OrderSchema = z.object({
  customer: z.object({
    name: z.string(),
    email: z.string().email(),
    address: z.object({
      street: z.string(),
      city: z.string(),
      zip: z.string().regex(/^\d{5}$/, 'ZIP must be 5 digits')
    })
  }),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().positive(),
    price: z.number().positive()
  })).min(1, 'At least one item required'),
  total: z.number().positive()
});
```

### Arrays with validation

```typescript
const BatchUpdateSchema = z.object({
  updates: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(100),
    tags: z.array(z.string()).max(10, 'Maximum 10 tags')
  })).min(1).max(100, 'Maximum 100 updates per batch')
});
```

### Discriminated unions

```typescript
const NotificationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('email'),
    to: z.string().email(),
    subject: z.string(),
    body: z.string()
  }),
  z.object({
    type: z.literal('sms'),
    phone: z.string().regex(/^\+\d{10,15}$/),
    message: z.string().max(160)
  }),
  z.object({
    type: z.literal('push'),
    deviceId: z.string(),
    title: z.string(),
    message: z.string()
  })
]);

// TypeScript infers the correct type based on 'type' field
type Notification = z.infer<typeof NotificationSchema>;
```

### Custom validation with `.refine()`

```typescript
const PasswordSchema = z.string()
  .min(8, 'Password must be at least 8 characters')
  .refine(
    (val) => /[A-Z]/.test(val),
    'Password must contain at least one uppercase letter'
  )
  .refine(
    (val) => /[a-z]/.test(val),
    'Password must contain at least one lowercase letter'
  )
  .refine(
    (val) => /\d/.test(val),
    'Password must contain at least one number'
  )
  .refine(
    (val) => /[!@#$%^&*]/.test(val),
    'Password must contain at least one special character'
  );

const RegisterSchema = z.object({
  email: z.string().email(),
  password: PasswordSchema,
  confirmPassword: z.string()
}).refine(
  (data) => data.password === data.confirmPassword,
  {
    message: 'Passwords must match',
    path: ['confirmPassword']
  }
);
```

### Date validation

```typescript
const EventSchema = z.object({
  title: z.string(),
  startDate: z.string().datetime(), // ISO 8601 datetime
  endDate: z.string().datetime(),
  timezone: z.string().default('UTC')
}).refine(
  (data) => new Date(data.endDate) > new Date(data.startDate),
  {
    message: 'End date must be after start date',
    path: ['endDate']
  }
);
```

### File upload validation

```typescript
const FileUploadSchema = z.object({
  filename: z.string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Invalid filename'),
  mimeType: z.enum([
    'image/jpeg',
    'image/png',
    'application/pdf',
    'text/plain'
  ]),
  sizeBytes: z.number()
    .int()
    .positive()
    .max(10 * 1024 * 1024, 'File must be less than 10MB'),
  content: z.string() // Base64 encoded
});
```

## CLI command validation

### Using Zod in CLI commands

```typescript
import { ValidationError } from '../../utils/errors.js';

const CreateProjectFlags = z.object({
  name: z.string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Name must be lowercase alphanumeric with dashes'),
  template: z.enum(['basic', 'advanced', 'minimal']).default('basic'),
  path: z.string().optional()
});

export const run = defineCommand({
  name: getCommandId('template:create-project'),
  flags: {
    name: { type: 'string', required: true },
    template: { type: 'string' },
    path: { type: 'string' }
  },
  async handler(ctx, argv, flags) {
    // Validate flags with Zod
    const validation = CreateProjectFlags.safeParse(flags);

    if (!validation.success) {
      const errors = validation.error.errors
        .map(err => `${err.path.join('.')}: ${err.message}`)
        .join(', ');

      throw new ValidationError(
        `Invalid flags: ${errors}`,
        'flags',
        'INVALID_FLAGS'
      );
    }

    const validated = validation.data;

    ctx.logger?.info('Creating project', validated);

    const result = await createProject(validated);

    ctx.output?.write(`Project created: ${result.name}\n`);

    return { ok: true, project: result };
  }
});
```

## Error handling

### Catching validation errors

```typescript
export const handleCreateUser = defineHandler({
  async execute(ctx, input) {
    try {
      // The route schema validates input before handler execution
      const user = await createUser(input);
      return { userId: user.id, createdAt: user.createdAt.toISOString() };
    } catch (error) {
      if (error instanceof z.ZodError) {
        // This shouldn't happen (input is pre-validated)
        // But if manually parsing, handle Zod errors
        ctx.output?.error('Validation failed', {
          errors: error.errors
        });
        throw new ValidationError(
          error.errors.map(e => e.message).join(', '),
          'input',
          'VALIDATION_ERROR'
        );
      }
      throw error;
    }
  }
});
```

### Manual validation with `.safeParse()`

```typescript
import { NotFoundError, ValidationError } from '../../utils/errors.js';

export async function updateUser(userId: string, updates: unknown) {
  // Manual validation
  const validation = UserUpdateSchema.safeParse(updates);

  if (!validation.success) {
    throw new ValidationError(
      validation.error.errors[0].message,
      validation.error.errors[0].path.join('.'),
      'INVALID_UPDATE'
    );
  }

  const user = await findUser(userId);

  if (!user) {
    throw new NotFoundError('User', userId);
  }

  return await applyUpdates(user, validation.data);
}
```

## Type inference

### Extracting types from schemas

```typescript
// Define schema once
const ProductSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  price: z.number().positive(),
  inStock: z.boolean(),
  metadata: z.record(z.string()).optional()
});

// Infer TypeScript type
export type Product = z.infer<typeof ProductSchema>;

// Use in functions
export async function createProduct(data: Product): Promise<Product> {
  // TypeScript knows the exact shape
  return data;
}

// Partial updates
const ProductUpdateSchema = ProductSchema.partial();
export type ProductUpdate = z.infer<typeof ProductUpdateSchema>;
// All fields are optional
```

### Reusing schemas

```typescript
// Base schemas
const IdSchema = z.string().uuid();
const TimestampSchema = z.string().datetime();

// Composed schema
const AuditedEntitySchema = z.object({
  id: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  createdBy: IdSchema,
  updatedBy: IdSchema
});

// Extend with `.extend()`
const UserSchema = AuditedEntitySchema.extend({
  email: z.string().email(),
  name: z.string(),
  role: z.enum(['admin', 'user'])
});

// Merge with `.merge()`
const ProductSchema = z.object({
  name: z.string(),
  price: z.number()
}).merge(AuditedEntitySchema);
```

## Testing validation

### Testing valid inputs

```typescript
import { describe, it, expect } from 'vitest';

describe('UserSchema validation', () => {
  it('should accept valid user', () => {
    const valid = {
      name: 'John Doe',
      email: 'john@example.com',
      age: 25
    };

    const result = UserSchema.parse(valid);
    expect(result).toEqual(valid);
  });

  it('should apply defaults', () => {
    const input = { query: 'test' };
    const result = SearchSchema.parse(input);

    expect(result).toEqual({
      query: 'test',
      limit: 10,
      offset: 0,
      sort: 'asc'
    });
  });
});
```

### Testing invalid inputs

```typescript
describe('UserSchema validation errors', () => {
  it('should reject missing required field', () => {
    const invalid = { name: 'John' }; // missing email

    expect(() => UserSchema.parse(invalid)).toThrow();
  });

  it('should reject invalid email', () => {
    const invalid = {
      name: 'John',
      email: 'not-an-email',
      age: 25
    };

    expect(() => UserSchema.parse(invalid)).toThrow('Invalid email format');
  });

  it('should reject age below minimum', () => {
    const invalid = {
      name: 'John',
      email: 'john@example.com',
      age: 17
    };

    expect(() => UserSchema.parse(invalid)).toThrow('Must be 18 or older');
  });
});
```

## Best practices

### ✅ DO

- **Define schemas close to usage** - in `rest/schemas/` or as constants
- **Export TypeScript types** - use `z.infer<typeof Schema>`
- **Use descriptive error messages** - help users fix validation errors
- **Reuse common schemas** - extract shared patterns (ID, timestamp, etc.)
- **Test validation** - write tests for both valid and invalid inputs
- **Use `.safeParse()` for manual validation** - avoid throwing in non-handler code
- **Leverage type inference** - let Zod generate TypeScript types

### ❌ DON'T

- Don't use `any` or skip validation
- Don't duplicate validation logic (use Zod everywhere)
- Don't write vague error messages ("Invalid input")
- Don't validate in multiple places (centralize in schemas)
- Don't forget to test edge cases

## Related documentation

- [Zod Documentation](https://zod.dev) - Full Zod API reference
- [rest/README.md](../../packages/plugin-template-core/src/rest/README.md) - REST handler patterns
- [utils/errors.ts](../../packages/plugin-template-core/src/utils/errors.ts) - Error handling
