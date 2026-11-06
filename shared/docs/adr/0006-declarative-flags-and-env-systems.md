# ADR-0006: Declarative Flags and Environment Variables Systems

**Date:** 2025-12-19
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2025-12-19
**Tags:** dx, type-safety, plugin-system, v3, developer-experience

## Context

V3 plugin commands had to manually extract and parse CLI flags and environment variables, leading to significant developer friction:

### Problems

1. **Excessive Boilerplate**: 5+ lines per command to extract env vars
2. **No Type Safety**: Manual casting and parsing without compile-time checks
3. **Inconsistent Patterns**: Different commands used different extraction approaches
4. **Error-Prone**: Easy to forget validation or default values
5. **Poor Maintainability**: Repetitive code across all commands

### Example of Manual Approach

```typescript
// ❌ OLD: Manual extraction and parsing (5+ lines)
const env: CommitEnv = {
  KB_COMMIT_LLM_ENABLED: ctx.runtime.env('KB_COMMIT_LLM_ENABLED'),
  KB_COMMIT_LLM_TEMPERATURE: ctx.runtime.env('KB_COMMIT_LLM_TEMPERATURE'),
  KB_COMMIT_LLM_MAX_TOKENS: ctx.runtime.env('KB_COMMIT_LLM_MAX_TOKENS'),
  KB_COMMIT_STORAGE_DIR: ctx.runtime.env('KB_COMMIT_STORAGE_DIR'),
  KB_COMMIT_AUTO_STAGE: ctx.runtime.env('KB_COMMIT_AUTO_STAGE'),
};

// Manual parsing in config resolver (20+ lines)
if (env.KB_COMMIT_LLM_TEMPERATURE !== undefined) {
  const temp = parseFloat(env.KB_COMMIT_LLM_TEMPERATURE);
  if (!isNaN(temp) && temp >= 0 && temp <= 1) {
    config.llm.temperature = temp;
  }
}
// ... repeat for every env var
```

### Impact

- **Developer Velocity**: Slowed down plugin development
- **Code Quality**: Inconsistent validation across commands
- **Type Safety**: Runtime errors from incorrect parsing
- **Maintenance**: Hard to refactor when changing env var types

### Constraints

- Must integrate with existing V3 plugin system
- Must maintain backward compatibility
- Cannot introduce heavy dependencies (Zod, class-validator, etc.)
- Must support type inference for excellent IDE experience

## Decision

Implement two declarative systems for type-safe flag and env variable handling:

### 1. `defineFlags()` — CLI Flags System

Declarative CLI flag definitions with automatic type inference.

**Location**: `@kb-labs/shared-cli-ui/src/utils/flags.ts`

```typescript
export const commitFlags = defineFlags({
  scope: {
    type: 'string',
    description: 'Limit to package or path',
    examples: ['@kb-labs/core', 'packages/**'],
  },
  'dry-run': {
    type: 'boolean',
    description: 'Preview without applying',
    default: false,
  },
});

export type CommitFlags = typeof commitFlags.type;
// → { scope?: string; 'dry-run': boolean }
```

### 2. `defineEnv()` — Environment Variables System

Declarative environment variable definitions with automatic type inference.

**Location**: `@kb-labs/shared-cli-ui/src/utils/env.ts`

```typescript
export const commitEnv = defineEnv({
  KB_COMMIT_LLM_TEMPERATURE: {
    type: 'number',
    default: 0.3,
    description: 'LLM temperature (0-1)',
    validate: (v) => {
      if (v < 0 || v > 1) throw new Error('Must be 0-1');
    },
  },
});

export type CommitEnv = typeof commitEnv.type;
// → { KB_COMMIT_LLM_TEMPERATURE: number }

// Usage (1 line instead of 5+)
const env = commitEnv.parse(ctx.runtime);
```

### Key Features

**Type System**:
- Supports `string`, `boolean`, `number` primitive types
- Automatic type inference via TypeScript mapped types
- Optional vs required based on `default` presence
- Custom validation functions for strings and numbers

**Runtime Parsing**:
- Automatic type coercion and validation
- Helpful error messages on parse failures
- Default value application
- Validation function execution

**Shared Infrastructure**:
- Both systems reuse same type parsers (`parseBoolean`, `parseString`, `parseNumber`)
- Consistent API surface
- No dependency duplication

### Architecture

```
┌─────────────────────────────────────────────────────┐
│              defineFlags / defineEnv                │
│  Declarative schema with automatic type inference  │
└─────────────────────────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        │                               │
        ▼                               ▼
┌───────────────┐               ┌──────────────┐
│ parseFlagsFrom│               │parseEnvFrom  │
│     Input     │               │   Runtime    │
└───────────────┘               └──────────────┘
        │                               │
        └───────────┬───────────────────┘
                    ▼
        ┌───────────────────────┐
        │  Shared Type Parsers  │
        │  - parseBoolean       │
        │  - parseString        │
        │  - parseNumber        │
        └───────────────────────┘
```

### Type Inference

```typescript
// Flags with defaults are non-optional
type InferFlagType<T extends FlagSpec> =
  T extends StringFlagSpec
    ? T extends { default: string } ? string : string | undefined
    : T extends BooleanFlagSpec
    ? T extends { default: boolean } ? boolean : boolean | undefined
    : T extends NumberFlagSpec
    ? T extends { default: number } ? number : number | undefined
    : never;

export type InferFlagsType<T extends FlagsSchema> = {
  [K in keyof T]: InferFlagType<T[K]>;
};
```

**Result**: Flags with defaults become `string`, without defaults become `string | undefined`.

### Avoiding Circular Dependencies

Problem: `shared-cli-ui` cannot depend on `@kb-labs/plugin-contracts`.

Solution: Minimal `RuntimeLike` interface:

```typescript
/**
 * Avoids dependency on @kb-labs/plugin-contracts
 */
export interface RuntimeLike {
  env(key: string): string | undefined;
}
```

## Consequences

### Positive

✅ **5+ lines → 1 line**: Massive reduction in boilerplate
✅ **Type safety**: Automatic type inference, compile-time checks
✅ **Validation**: Built-in type validation + custom validators
✅ **Defaults**: Declarative defaults with proper type narrowing
✅ **Consistency**: Same pattern across all commands
✅ **Self-documenting**: Schema serves as documentation
✅ **DX**: Excellent IDE autocomplete and type hints
✅ **Backward compatible**: V3 bootstrap auto-merges `input.flags`

### Negative

⚠️ **Migration effort**: Existing commands need updating
⚠️ **Learning curve**: Developers need to learn new pattern
⚠️ **Schema duplication**: Flags in contracts + manifest (acceptable tradeoff)

### Neutral

🔹 **New dependency**: Commands depend on `@kb-labs/sdk` for `defineEnv()`
🔹 **Type complexity**: Uses advanced TypeScript (mapped types, conditional types)
🔹 **Runtime overhead**: Minimal (parsing happens once per command)

### Before/After Comparison

```typescript
// ❌ BEFORE: Manual, error-prone, no type safety (25+ lines)
const env: CommitEnv = {
  KB_COMMIT_LLM_ENABLED: ctx.runtime.env('KB_COMMIT_LLM_ENABLED'),
  KB_COMMIT_LLM_TEMPERATURE: ctx.runtime.env('KB_COMMIT_LLM_TEMPERATURE'),
  KB_COMMIT_LLM_MAX_TOKENS: ctx.runtime.env('KB_COMMIT_LLM_MAX_TOKENS'),
  KB_COMMIT_STORAGE_DIR: ctx.runtime.env('KB_COMMIT_STORAGE_DIR'),
  KB_COMMIT_AUTO_STAGE: ctx.runtime.env('KB_COMMIT_AUTO_STAGE'),
};

// Manual parsing
if (env.KB_COMMIT_LLM_TEMPERATURE !== undefined) {
  const temp = parseFloat(env.KB_COMMIT_LLM_TEMPERATURE);
  if (!isNaN(temp) && temp >= 0 && temp <= 1) {
    config.llm.temperature = temp;
  }
}
```

```typescript
// ✅ AFTER: Declarative, type-safe, DRY (1 line)
const env = commitEnv.parse(ctx.runtime);
// env.KB_COMMIT_LLM_TEMPERATURE → number (fully typed, validated)

// Clean config resolution
const config: CommitPluginConfig = {
  llm: {
    temperature: env.KB_COMMIT_LLM_TEMPERATURE ?? fileConfig.llm?.temperature ?? 0.3,
  },
};
```

## Alternatives Considered

### 1. Zod Schemas

```typescript
const commitEnvSchema = z.object({
  KB_COMMIT_LLM_TEMPERATURE: z.number().min(0).max(1).default(0.3),
});
```

**Rejected**:
- Too heavy (adds 14KB Zod dependency to shared-cli-ui)
- Overkill for simple primitive types
- More complex API surface

### 2. Class-based Validators

```typescript
class CommitEnv {
  @IsBoolean() KB_COMMIT_LLM_ENABLED = true;
  @IsNumber() @Min(0) @Max(1) KB_COMMIT_LLM_TEMPERATURE = 0.3;
}
```

**Rejected**:
- Requires decorators (experimental TypeScript feature)
- More boilerplate than declarative approach
- Runtime reflection overhead

### 3. Manual Helper Functions

```typescript
function useEnv<T>(schema: EnvSchema<T>): T {
  // ...
}
```

**Rejected**:
- Similar complexity to our solution
- Less declarative
- Doesn't enable schema reuse for documentation

## Implementation

### Changes Made

1. **`@kb-labs/shared-cli-ui`**:
   - Added `src/utils/flags.ts` — `defineFlags()` system
   - Added `src/utils/env.ts` — `defineEnv()` system
   - Exported parsers for reuse

2. **`@kb-labs/sdk`**:
   - Re-exported `defineFlags`, `defineEnv`, and related types
   - Added to public API for plugin developers

3. **`@kb-labs/commit/contracts`**:
   - Added `src/flags.ts` — flag definitions
   - Added `src/env.ts` — env definitions
   - Removed old `CommitEnv` interface
   - Updated `resolveCommitConfig()` to use typed values

4. **`@kb-labs/commit/cli`**:
   - Migrated `run.ts` to use `commitEnv.parse()`
   - Migrated `generate.ts` to use `commitEnv.parse()`
   - Reduced boilerplate from 5+ lines to 1 line per command

### Migration Path

For existing plugins:

1. Create flag definitions in contracts:
   ```typescript
   export const myFlags = defineFlags({
     scope: { type: 'string', description: '...' },
   });
   ```

2. Create env definitions in contracts:
   ```typescript
   export const myEnv = defineEnv({
     MY_VAR: { type: 'boolean', default: true },
   });
   ```

3. Update commands:
   ```typescript
   const env = myEnv.parse(ctx.runtime); // 1 line
   ```

### Testing

Verified with commit plugin:

```bash
KB_COMMIT_LLM_TEMPERATURE=0.5 KB_COMMIT_LLM_MAX_TOKENS=3000 \
  pnpm kb commit plan create --scope="kb-labs-commit-plugin"
```

Results:
- ✅ Env vars parsed correctly
- ✅ Type validation passed
- ✅ Command executed without errors
- ✅ No runtime performance impact

## Future Improvements

1. **Auto-generate manifest**: Extract flag definitions for plugin manifest
2. **CLI help generation**: Auto-generate `--help` text from flag descriptions
3. **Env var docs**: Auto-generate documentation from env schema
4. **Deprecation warnings**: Built-in support for deprecated flags/env vars
5. **Schema validation**: Validate manifest against flag schema at build time

## References

- TypeScript: [Mapped Types](https://www.typescriptlang.org/docs/handbook/2/mapped-types.html)
- TypeScript: [Conditional Types](https://www.typescriptlang.org/docs/handbook/2/conditional-types.html)
- V3 Plugin System: [docs/V3-IMPLEMENTATION-SPEC.md](../V3-IMPLEMENTATION-SPEC.md)
- Bootstrap Auto-Merge: `kb-labs-plugin/packages/plugin-runtime/src/v3/bootstrap.ts`

---

**Last Updated:** 2025-12-19
**Implementation**: Complete
**Packages Modified**:
- `@kb-labs/shared-cli-ui` — Added `defineFlags()` and `defineEnv()`
- `@kb-labs/sdk` — Re-exported utilities
- `@kb-labs/commit/contracts` — Added definitions
- `@kb-labs/commit/cli` — Migrated commands
