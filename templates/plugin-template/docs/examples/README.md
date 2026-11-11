# Examples

This folder contains comprehensive examples for building production-ready KB Labs plugins.

## Available examples

### [Validation Examples](./validation-examples.md)

Learn Zod schema validation patterns:
- ✅ Required/optional fields with defaults
- ✅ Nested objects and arrays
- ✅ Custom validation with `.refine()`
- ✅ Discriminated unions
- ✅ Type inference from schemas
- ✅ Error handling

**When to use:** Adding REST endpoints with request validation, validating CLI command flags.

### [Test Examples](./test-examples.md)

Testing patterns for all plugin surfaces:
- ✅ CLI command tests (mocking context, validation, errors)
- ✅ REST handler tests (Zod validation, dependencies, integration)
- ✅ Studio widget tests (rendering, states, interactions)
- ✅ Core business logic tests (pure functions, edge cases)
- ✅ Test utilities (mock factories, custom matchers)

**When to use:** Writing tests for new commands, handlers, widgets, or core logic.

### [Contracts Examples](./contracts-examples.md)

Type-safe identifiers with contracts:
- ✅ Command IDs, Route IDs, Widget IDs
- ✅ Artifact IDs, Event IDs
- ✅ Hierarchical contracts
- ✅ Contract validation helpers
- ✅ Testing with contracts

**When to use:** Preventing typos in manifest registration, enabling refactoring across surfaces.

### [Multi-Tenancy Examples](./multi-tenancy-examples.md)

Building SaaS plugins with tenant isolation:
- ✅ Tenant context in CLI/REST/Workflows
- ✅ Per-tenant rate limiting and quotas
- ✅ Data isolation patterns
- ✅ Tenant-aware logging
- ✅ Testing multi-tenancy
- ✅ Migration path (InMemory → Redis)

**When to use:** Building SaaS plugins, team workspaces, or user-specific data isolation.

## Quick links

### Getting started
1. Read [getting-started.md](../getting-started.md) for setup
2. Read [architecture.md](../architecture.md) for structure
3. Pick an example matching your use case
4. Copy patterns into your plugin

### Common patterns
- **Adding REST endpoint?** → [validation-examples.md](./validation-examples.md)
- **Writing tests?** → [test-examples.md](./test-examples.md)
- **Preventing typos in IDs?** → [contracts-examples.md](./contracts-examples.md)
- **Building SaaS plugin?** → [multi-tenancy-examples.md](./multi-tenancy-examples.md)

### Guides
- [CLI Guide](../cli-guide.md) - CLI command patterns
- [REST Guide](../rest-guide.md) - REST handler patterns
- [Studio Guide](../studio-guide.md) - React widget patterns

## Example-driven development

### 1. Start with examples

Don't start from scratch—copy proven patterns:

```typescript
// ✅ DO: Copy validation pattern from examples
const UserSchema = z.object({
  email: z.string().email(),
  age: z.number().int().min(18)
});

// ❌ DON'T: Reinvent validation
function validateUser(input: any) {
  if (!input.email || !/@/.test(input.email)) {
    throw new Error('Invalid email');
  }
  // ... manual validation code
}
```

### 2. Test from examples

Copy test structure and adapt:

```typescript
// Copy from test-examples.md
describe('handleCreateUser', () => {
  it('should reject invalid email', async () => {
    const invalidInput = { email: 'not-an-email' };

    await expect(
      handleCreateUser.handle(invalidInput, {})
    ).rejects.toThrow();
  });

  it('should accept valid user', async () => {
    const validInput = {
      name: 'John',
      email: 'john@example.com',
      age: 25
    };

    const result = await handleCreateUser.handle(validInput, {});

    expect(result.userId).toBeDefined();
  });
});
```

### 3. Build incrementally

1. **Copy validation example** → Define Zod schema
2. **Copy handler example** → Implement REST handler
3. **Copy test example** → Write tests
4. **Copy contract example** → Add type-safe IDs

## FAQ

### When should I use contracts?

**Always.** Contracts prevent typos and enable refactoring. Use them for:
- Command IDs (`template:hello`)
- Route IDs (`/users/:id`)
- Widget IDs (`template.hello-widget`)
- Artifact IDs (`template:report`)
- Event IDs (`template:user-created`)

See [contracts-examples.md](./contracts-examples.md).

### How do I add validation to CLI commands?

Use Zod schemas with `.safeParse()`:

```typescript
const FlagsSchema = z.object({
  name: z.string().min(1).max(50),
  verbose: z.boolean().default(false)
});

export const run = defineCommand({
  async handler(ctx, argv, flags) {
    const validation = FlagsSchema.safeParse(flags);

    if (!validation.success) {
      throw new ValidationError(
        validation.error.errors[0].message,
        validation.error.errors[0].path.join('.'),
        'INVALID_FLAGS'
      );
    }

    const validated = validation.data;
    // Use validated.name, validated.verbose
  }
});
```

See [validation-examples.md](./validation-examples.md#cli-command-validation).

### How do I test widgets?

Use React Testing Library:

```typescript
import { render, screen } from '@testing-library/react';

describe('YourWidget', () => {
  it('should render data', () => {
    const data = { message: 'Hello' };

    render(<YourWidget data={data} />);

    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('should show loading state', () => {
    render(<YourWidget loading />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});
```

See [test-examples.md](./test-examples.md#testing-studio-widgets).

### When should I add multi-tenancy?

Add multi-tenancy if:
- ✅ Building SaaS plugin for multiple companies
- ✅ Need team-based workspaces
- ✅ Require user-specific data isolation
- ✅ Want per-customer rate limiting

**Don't add** if:
- ❌ Single-user plugin
- ❌ Internal tool for one company
- ❌ MVP that doesn't need isolation yet

See [multi-tenancy-examples.md](./multi-tenancy-examples.md).

### How do I handle errors?

Use custom error classes from `utils/errors.ts`:

```typescript
import {
  ValidationError,
  NotFoundError,
  BusinessRuleError,
  formatErrorForLogging
} from '../utils/errors.js';

// Validation
if (!isValid(input)) {
  throw new ValidationError('Invalid input', 'inputField');
}

// Not found
const item = await findItem(id);
if (!item) {
  throw new NotFoundError('Item', id);
}

// Business rule
if (account.balance < amount) {
  throw new BusinessRuleError(
    'Insufficient funds',
    'INSUFFICIENT_FUNDS'
  );
}

// Logging
try {
  await operation();
} catch (error) {
  ctx.logger?.error('Failed', formatErrorForLogging(error));
  throw error;
}
```

See [validation-examples.md](./validation-examples.md#error-handling) and [utils/errors.ts](../../src/utils/errors.ts).

## Contributing examples

Found a useful pattern? Add it to the examples:

1. Choose appropriate file:
   - Validation pattern → `validation-examples.md`
   - Test pattern → `test-examples.md`
   - Type-safe ID → `contracts-examples.md`
   - Multi-tenant pattern → `multi-tenancy-examples.md`

2. Add example with:
   - Clear heading (`### Your pattern name`)
   - Code snippet
   - Explanation
   - Best practices (✅ DO / ❌ DON'T)

3. Update this README if adding new category

## Related documentation

- [Getting Started](../getting-started.md) - Setup and first steps
- [Architecture](../architecture.md) - Plugin structure
- [CLI Guide](../cli-guide.md) - CLI patterns
- [REST Guide](../rest-guide.md) - REST patterns
- [Studio Guide](../studio-guide.md) - Widget patterns
- [Folder READMEs](../../src/) - Detailed per-folder docs
