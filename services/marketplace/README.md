# @kb-labs/marketplace

Marketplace manages plugin and adapter packages for an installed KB Labs platform. The host owns its HTTP service; do not start a standalone marketplace daemon.

## Project plugins

Run from the project root. Schema v3 of `.kb/marketplace.lock` records each plugin's exact version, tarball integrity, source kind, and enabled state. It contains no machine-specific path or install timestamp; runtime resolution uses the machine's shared extension store. Install does not update project `package.json`, the package-manager lockfile, or `node_modules`. Run `kb marketplace sync` to regenerate the lock in schema v3.

```bash
kb marketplace install @kb-labs/commit@1.2.3
kb marketplace plugins list
kb marketplace plugins disable @kb-labs/commit
kb marketplace plugins enable @kb-labs/commit
kb marketplace uninstall @kb-labs/commit
```

For a local plugin, build it and pass an explicit relative link path:

```bash
pnpm build
kb marketplace plugins add --link .kb/plugins/my-plugin
```

## Machine adapters

Adapters and their options are configured at platform scope:

```bash
kb marketplace install @kb-labs/adapters-fs@2.107.0 --scope platform
kb adapter bind storage @kb-labs/adapters-fs
kb config set --scope platform platform.adapterOptions.storage '{"baseDir":"cache"}'
kb adapter unbind storage
```

The bind command verifies that the platform marketplace lock records the package as an adapter before writing `platform.adapters.<slot>` in platform config. Projects inherit the platform binding and cannot override it.

From the monorepo root, `kb marketplace sync --scope platform` records built workspace plugins under `plugins` and adapters under the machine-only `adapters` section of `.kb/marketplace.lock`.
