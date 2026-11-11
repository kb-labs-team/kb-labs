# @product-name/package-name

Baseline library package inside KB Labs Product Template.

## Vision & Purpose

**@product-name/package-name** is a minimal example library shipped with `kb-labs-product-template`.  
It shows how a typical package is structured (source, tests, types) and is intended to be **renamed or removed** when creating a real product.

### Core Goals

- Demonstrate the standard KB Labs package layout (src/types/tests/build tooling)
- Provide a simple, testable function (`hello`) as a starting point
- Act as a safe playground for verifying DevKit configs (tsup, Vitest, ESLint)

## Package Status

- **Version**: 0.1.0  
- **Stage**: Template / Example  
- **Status**: Not for Production ⚠️

## Architecture

### Structure

```
packages/package-name/
├── src/
│   ├── index.ts        # Public entrypoint
│   └── types/          # Shared types and re-exports
│       ├── types.ts
│       └── index.ts
├── index.test.ts       # Vitest example
└── tsup.config.ts      # Build configuration
```

The default implementation is intentionally tiny:

```ts
export const hello = (name = 'KB Labs') => `Hello, ${name}!`;
```

## Dependencies

### Runtime

None by default — this is a pure TypeScript example.

### Development

- `@kb-labs/devkit`: shared TS/ESLint/Vitest/TSUP presets
- `tsup`, `vitest`, `tsx`, `typescript`

## Scripts

From the `kb-labs-product-template` root:

```bash
pnpm --filter @product-name/package-name build
pnpm --filter @product-name/package-name test
pnpm --filter @product-name/package-name lint
```

## How to Adapt for a Real Package

When using the product template for your own project:

1. Rename the package in `package.json` (e.g. `@kb-labs/my-product-core`).
2. Replace the `hello` function with your actual public API.
3. Update tests in `index.test.ts` to cover real behaviour.
4. Adjust `types/` to expose the correct public types.

This package is meant as a scaffold only; don’t ship it as-is to production.


