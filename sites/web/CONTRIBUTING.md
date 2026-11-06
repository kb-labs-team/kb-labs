# Contributing

## Prerequisites

- Node.js >= 20
- pnpm >= 9

## Local development

```bash
pnpm install
pnpm dev:all
```

The root package starts `@kb-labs/web-site` and `@kb-labs/docs-site` together.
For one app, run its workspace script directly, such as
`pnpm --filter @kb-labs/docs-site dev`.

## Quality gates

Run before opening a PR:

```bash
pnpm lint:all
pnpm typecheck:all
pnpm build:all
```

For just the docs app, run:

```bash
pnpm --filter @kb-labs/docs-site lint
pnpm --filter @kb-labs/docs-site typecheck
pnpm --filter @kb-labs/docs-site build
```

## Scope

- `apps/web`: corporate and marketing pages
- `apps/docs`: public documentation
- `apps/app`: SaaS shell

## Localization

- EN is default route.
- RU is mirrored under `/ru`.
