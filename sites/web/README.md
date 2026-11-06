# kb-labs-web

Monorepo for KB Labs web surfaces:

- `apps/web` -> `kblabs.dev`
- `apps/docs` -> `docs.kblabs.dev`
- `apps/app` -> `app.kblabs.dev`

## Stack

- Next.js (App Router)
- MDX content (web/docs/blog)
- pnpm workspaces + Turbo
- EN default + RU mirror under `/ru`
- UI dependencies linked from `kb-labs-studio`

## Getting started

```bash
pnpm install
pnpm dev:all
```

The root package groups the app commands for local convenience. DevKit schedules
each app package independently, so use these names when working from `sites/web`.

## Common commands

```bash
pnpm build:all
pnpm lint:all
pnpm typecheck:all
```

To work on one app, filter its workspace package directly, for example:

```bash
pnpm --filter @kb-labs/docs-site dev
pnpm --filter @kb-labs/docs-site build
```

## UI dependencies

This repo consumes UI packages via local links:

- `@kb-labs/studio-ui-core`
- `@kb-labs/studio-ui-kit`

They are linked from `../kb-labs-studio/packages/*`.
