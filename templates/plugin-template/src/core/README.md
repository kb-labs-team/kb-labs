# Core Business Logic

This folder contains the pure business logic of your plugin - domain entities, use cases, and operations.

## Structure

```
core/
├── greeting.ts            # Domain entity (pure logic)
├── create-greeting.ts     # Use case (orchestration)
└── index.ts              # Barrel export
```

## Philosophy

**Core is the heart of your plugin.** It contains:
- **Domain entities** - Pure data structures and business rules
- **Use cases** - Application logic that orchestrates entities
- **Pure functions** - No side effects, easy to test

**Core should NOT:**
- Import from CLI, REST, or Studio (dependency inversion)
- Access filesystem, network, or external systems directly
- Depend on runtime infrastructure

## Adding Business Logic

### 1. Define Domain Entity

Create a pure data structure with business rules:

```typescript
// user.ts
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  createdAt: Date;
}

export function createUser(
  email: string,
  name: string,
  role: 'admin' | 'user' = 'user'
): User {
  // Validation (business rules)
  if (!isValidEmail(email)) {
    throw new Error('Invalid email format');
  }
  if (name.trim().length === 0) {
    throw new Error('Name cannot be empty');
  }

  return {
    id: generateId(),
    email: email.toLowerCase(),
    name: name.trim(),
    role,
    createdAt: new Date()
  };
}

export function canUserPerformAction(user: User, action: string): boolean {
  // Business logic
  if (user.role === 'admin') return true;
  return ['read', 'comment'].includes(action);
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}
```

### 2. Define Use Case

Create orchestration logic that uses entities:

```typescript
// create-user.ts
import { createUser, type User } from './user.js';

export interface CreateUserInput {
  email: string;
  name: string;
  role?: 'admin' | 'user';
}

export interface CreateUserResult {
  user: User;
  message: string;
}

export function createUserUseCase(input: CreateUserInput): CreateUserResult {
  // 1. Validate input
  if (!input.email || !input.name) {
    throw new Error('Email and name are required');
  }

  // 2. Create entity (business logic)
  const user = createUser(input.email, input.name, input.role);

  // 3. Return result
  return {
    user,
    message: `User ${user.name} created successfully`
  };
}
```

### 3. Export from Barrel

Add to `index.ts`:

```typescript
export * from './user.js';
export * from './create-user.js';
```

### 4. Use from Surfaces

CLI, REST, and Studio import from `core/`:

```typescript
// In CLI command
import { createUserUseCase } from '../../core/index.js';

export const run = defineCommand({
  async handler(ctx, argv, flags) {
    const result = createUserUseCase({
      email: flags.email,
      name: flags.name
    });

    ctx.ui?.write(`${result.message}\n`);
    return { ok: true, result: result.user };
  }
});

// In REST handler
import { createUserUseCase } from '../../core/index.js';

export const handleCreateUser = definePluginHandler({
  async handle(input, ctx) {
    const result = createUserUseCase(input);
    return result.user;
  }
});
```

## Best Practices

### ✅ DO

- **Keep functions pure** - no side effects when possible
- **Validate business rules** - throw errors for invalid states
- **Use TypeScript types** - strong typing for safety
- **Write unit tests** - core logic is easiest to test
- **Document complex logic** - JSDoc for non-obvious code

### ❌ DON'T

- Don't import from CLI/REST/Studio (dependency inversion!)
- Don't access filesystem, network, databases
- Don't use `console.log` or global state
- Don't mix presentation logic with business logic
- Don't create complex inheritance hierarchies

## Patterns

### Pure Function Pattern

```typescript
// Pure - deterministic, no side effects
export function calculateDiscount(
  price: number,
  percentage: number
): number {
  if (price < 0 || percentage < 0 || percentage > 100) {
    throw new Error('Invalid input');
  }
  return price * (1 - percentage / 100);
}

// Test is trivial:
expect(calculateDiscount(100, 20)).toBe(80);
```

### Entity with Methods

```typescript
export interface Product {
  id: string;
  name: string;
  price: number;
  discount: number;
}

export function createProduct(name: string, price: number): Product {
  return {
    id: generateId(),
    name,
    price,
    discount: 0
  };
}

export function applyDiscount(product: Product, percentage: number): Product {
  return {
    ...product,
    discount: percentage
  };
}

export function getFinalPrice(product: Product): number {
  return calculateDiscount(product.price, product.discount);
}

// Immutable updates - return new objects
```

### Use Case Pattern

```typescript
// Input type
export interface ProcessOrderInput {
  productIds: string[];
  userId: string;
  couponCode?: string;
}

// Output type
export interface ProcessOrderResult {
  orderId: string;
  total: number;
  savings: number;
}

// Use case function
export function processOrderUseCase(
  input: ProcessOrderInput
): ProcessOrderResult {
  // 1. Load data (in real app, passed as dependencies)
  const products = getProducts(input.productIds);
  const user = getUser(input.userId);

  // 2. Business logic
  let total = products.reduce((sum, p) => sum + getFinalPrice(p), 0);
  let savings = 0;

  if (input.couponCode) {
    const discount = validateCoupon(input.couponCode, user);
    savings = total * discount;
    total -= savings;
  }

  // 3. Create order
  const order = createOrder({
    userId: user.id,
    products,
    total
  });

  // 4. Return result
  return {
    orderId: order.id,
    total,
    savings
  };
}
```

### Error Handling

```typescript
// Custom error types
export class ValidationError extends Error {
  constructor(message: string, public field: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class BusinessRuleError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'BusinessRuleError';
  }
}

// Use in functions
export function transferFunds(
  from: Account,
  to: Account,
  amount: number
): Transfer {
  if (amount <= 0) {
    throw new ValidationError('Amount must be positive', 'amount');
  }

  if (from.balance < amount) {
    throw new BusinessRuleError(
      'Insufficient funds',
      'INSUFFICIENT_FUNDS'
    );
  }

  // Execute transfer...
  return createTransfer(from, to, amount);
}
```

## Testing Core Logic

Core is the easiest to test - pure functions, no mocks needed:

```typescript
import { describe, it, expect } from 'vitest';
import { createGreeting, createGreetingUseCase } from './create-greeting.js';

describe('createGreeting', () => {
  it('should create greeting with name', () => {
    const result = createGreeting('Alice');

    expect(result.message).toBe('Hello, Alice!');
    expect(result.target).toBe('Alice');
  });

  it('should use default target', () => {
    const result = createGreeting();

    expect(result.message).toBe('Hello, World!');
    expect(result.target).toBe('World');
  });
});

describe('createGreetingUseCase', () => {
  it('should delegate to createGreeting', () => {
    const result = createGreetingUseCase({ name: 'Bob' });

    expect(result.message).toBe('Hello, Bob!');
    expect(result.target).toBe('Bob');
  });
});
```

## When to Split Core

As your plugin grows, organize `core/` by domain:

```
core/
├── users/
│   ├── user.ts           # User entity
│   ├── create-user.ts    # Use case
│   └── index.ts
├── products/
│   ├── product.ts
│   ├── pricing.ts
│   └── index.ts
└── orders/
    ├── order.ts
    ├── process-order.ts
    └── index.ts
```

Or by layer (if complexity demands):

```
core/
├── domain/              # Pure entities
│   ├── user.ts
│   └── product.ts
├── application/         # Use cases
│   ├── create-user.ts
│   └── process-order.ts
└── ports/              # Interface definitions
    └── repository.ts
```

## Examples

See existing files:
- [greeting.ts](./greeting.ts) - Simple domain entity
- [create-greeting.ts](./create-greeting.ts) - Simple use case

## Related Documentation

- [Architecture Guide](../../../docs/architecture.md) - Overall architecture
- [Testing Strategy](../../../docs/architecture.md#testing-strategy)
