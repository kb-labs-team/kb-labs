# Plugin Development Guide

> **Note**
> New plugins must declare commands via ManifestV2. Use `kb plugins scaffold` to generate a ready-to-build template with `src/kb/manifest.ts` and update the manifest metadata instead of authoring legacy `cli.manifest.ts` files.

## Quick Start

Create a KB Labs CLI plugin in 5 steps:

### 1. Setup Package

```json
{
  "name": "@your-scope/your-plugin-cli",
  "version": "1.0.0",
  "type": "module",
  "keywords": ["kb-cli-plugin"],
  "exports": {
    "./kb/commands": "./dist/kb/commands.js"
  },
  "kb": {
    "plugin": true
  }
}
```

### 2. Create Manifest

Create `src/kb/commands.ts`:

```typescript
import type { CommandManifest } from '@kb-labs/cli-commands';

export const commands: CommandManifest[] = [
  {
    manifestVersion: '1.0',
    id: 'your-plugin:command',
    group: 'your-plugin',
    namespace: 'your-plugin',
    package: '@your-scope/your-plugin-cli',
    describe: 'Description of your command',
    flags: [
      {
        name: 'verbose',
        type: 'boolean',
        alias: 'v',
        description: 'Verbose output',
      },
    ],
    examples: [
      'kb your-plugin command --verbose',
    ],
    loader: async () => import('./commands/command.js'),
  },
];
```

### 3. Implement Command

Create `src/commands/command.ts`:

```typescript
import type { CommandModule } from '@kb-labs/cli-commands';

export const run: CommandModule['run'] = async (ctx, argv, flags) => {
  ctx.presenter.info('Hello from your plugin!');
  return 0;
};
```

### 4. Build & Export

```typescript
// tsup.config.ts
export default {
  entry: ['src/kb/commands.ts'],
  format: ['esm'],
  dts: true,
};
```

### 5. Publish

```bash
pnpm publish
```

## Discovery Methods

Plugins are discovered via:

1. **Keywords** (recommended): Add `"keywords": ["kb-cli-plugin"]` to package.json
2. **Explicit flag**: Add `"kb": { "plugin": true }` to package.json
3. **Manifest path**: Set `"kb": { "commandsManifest": "dist/kb/commands.js" }`

## Manifest Locations

Preferred (in order):
1. `exports["./kb/commands"]` in package.json
2. `kb.commandsManifest` in package.json
3. ~~`kb/manifest.*`~~ (deprecated, will show warnings)

## Local Development

```bash
# Link your plugin
kb plugins link ./packages/your-plugin

# List plugins
kb plugins ls

# Enable/disable
kb plugins enable @your-scope/your-plugin-cli
kb plugins disable @your-scope/your-plugin-cli
```

## Advanced Features

### Engine Requirements

```typescript
{
  engine: {
    node: ">=18",
    kbCli: "^1.5.0",
    module: "esm"
  }
}
```

### Permissions

```typescript
{
  permissions: ["fs.read", "git.read", "net.fetch"]
}
```

### Requires (Peer Dependencies)

```typescript
{
  requires: ["@kb-labs/some-core@^1.0.0"]
}
```

## Schema Validation

All manifests are validated with Zod schema:
- `manifestVersion: '1.0'` required
- `id` must be `namespace:command` format
- Flags validated with type checking
- Semver ranges validated in `requires`

## Best Practices

1. Use `namespace:command` format for IDs
2. Export via `exports["./kb/commands"]` 
3. Add keywords for discoverability
4. Declare engine requirements
5. Use whitespace aliases (automatic): `kb namespace command`

## Troubleshooting

- **Plugin not discovered**: Check keywords or add to `kb-labs.config.json` `plugins.allow`
- **Manifest errors**: Run `kb plugins doctor` for diagnostics
- **Debug**: Use `--verbose` flag for detailed logs

