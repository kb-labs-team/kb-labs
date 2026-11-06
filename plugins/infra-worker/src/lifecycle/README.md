# Lifecycle Hooks

This folder contains plugin lifecycle handlers that run during installation, uninstallation, and upgrade.

## Structure

```
lifecycle/
├── setup.ts          # Plugin installation (IMPLEMENTED)
├── destroy.ts        # Plugin uninstallation (TODO)
├── upgrade.ts        # Version upgrade (TODO)
├── enable.ts         # Plugin activation (TODO)
├── disable.ts        # Plugin deactivation (TODO)
└── index.ts          # Barrel export
```

## Current Implementation

Only `setup.ts` is currently implemented. Other hooks are planned for future.

## Setup Hook

Runs when user installs/initializes the plugin: `kb marketplace install template`

```typescript
// lifecycle/setup.ts
export async function run(
  input: SetupInput = {},
  ctx: SetupContext = {}
): Promise<SetupResult> {
  const logger = ctx.logger;
  const fs = ctx.runtime?.fs;

  // 1. Create plugin workspace
  await fs?.mkdir('.kb/template', { recursive: true });

  // 2. Write initial config
  await fs?.writeFile('.kb/template/config.json', JSON.stringify({
    greeting: 'Welcome!',
    enabled: true
  }, null, 2));

  // 3. Update global config
  await ctx.runtime?.config?.ensureSection('plugins.template', {
    enabled: true,
    configPath: '.kb/template/config.json'
  });

  // 4. Return result
  return {
    message: 'Template plugin installed successfully',
    suggestions: {
      scripts: {
        'template:hello': 'kb template hello'
      }
    }
  };
}
```

### Setup Best Practices

**✅ DO:**
- Create `.kb/<plugin-name>/` folder for plugin files
- Use declarative `SetupBuilder` when possible
- Be idempotent - re-running should be safe
- Provide helpful success message
- Suggest next steps (scripts, commands)

**❌ DON'T:**
- Don't modify files outside `.kb/<plugin-name>/`
- Don't fail on re-run (check if already setup)
- Don't require manual user input
- Don't make irreversible changes

## Future Lifecycle Hooks

### Destroy Hook (TODO)

Runs when user uninstalls the plugin: `kb plugins uninstall template`

```typescript
// lifecycle/destroy.ts
export async function run(
  input: DestroyInput = {},
  ctx: LifecycleContext
): Promise<DestroyResult> {
  // 1. Clean up plugin files
  await ctx.fs.rm('.kb/template', { recursive: true });

  // 2. Remove config section
  await ctx.config?.removeSection('plugins.template');

  // 3. Log cleanup
  ctx.logger.info('Plugin uninstalled, all data removed');

  return {
    message: 'Template plugin uninstalled successfully',
    filesRemoved: ['.kb/template/']
  };
}
```

### Upgrade Hook (TODO)

Runs when plugin version changes: `kb plugins upgrade template`

```typescript
// lifecycle/upgrade.ts
export async function run(
  input: UpgradeInput,
  ctx: LifecycleContext
): Promise<UpgradeResult> {
  const { fromVersion, toVersion } = input;

  ctx.logger.info('Upgrading', { from: fromVersion, to: toVersion });

  // Migration logic based on version
  if (fromVersion < '1.0.0') {
    await migrateConfigV0ToV1(ctx);
  }

  if (fromVersion < '2.0.0') {
    await migrateDataV1ToV2(ctx);
  }

  return {
    message: `Upgraded from ${fromVersion} to ${toVersion}`,
    migrationsRun: ['config-v1', 'data-v2']
  };
}
```

### Enable/Disable Hooks (TODO)

Toggle plugin active state without uninstalling.

```typescript
// lifecycle/enable.ts
export async function run(
  input: EnableInput,
  ctx: LifecycleContext
): Promise<EnableResult> {
  await ctx.config?.set('plugins.template.enabled', true);

  ctx.logger.info('Plugin enabled');

  return {
    message: 'Template plugin enabled'
  };
}

// lifecycle/disable.ts
export async function run(
  input: DisableInput,
  ctx: LifecycleContext
): Promise<DisableResult> {
  await ctx.config?.set('plugins.template.enabled', false);

  ctx.logger.info('Plugin disabled');

  return {
    message: 'Template plugin disabled (data preserved)'
  };
}
```

## Context API

Lifecycle hooks receive rich context:

```typescript
interface LifecycleContext {
  // Logging
  logger: {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };

  // Runtime utilities
  runtime: {
    // Filesystem operations
    fs: {
      mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
      writeFile(path: string, data: string | Buffer): Promise<void>;
      readFile(path: string): Promise<string>;
      rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
    };

    // Config management
    config: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<void>;
      ensureSection(pointer: string, value: unknown): Promise<void>;
      removeSection(pointer: string): Promise<void>;
    };
  };

  // Execution mode
  dryRun?: boolean;
}
```

## Declarative Setup Builder

For complex setups, use `SetupBuilder`:

```typescript
import { SetupBuilder } from '@kb-labs/setup-operations';

export async function run(input, ctx) {
  const builder = new SetupBuilder();

  // Declare files
  builder.ensureFile('.kb/template/config.json', configContent, {
    metadata: { description: 'Plugin configuration' }
  });

  // Declare config sections
  builder.ensureConfigSection('plugins.template', {
    enabled: true,
    version: '1.0.0'
  });

  // Suggest scripts
  builder.suggestScript('template:hello', {
    command: 'kb template hello',
    description: 'Run hello command'
  });

  // Build returns operations that can be:
  // - Previewed before execution
  // - Rolled back on error
  // - Logged for auditing
  const result = builder.build();

  return {
    message: 'Setup complete',
    operations: result.operations
  };
}
```

## Testing Lifecycle Hooks

Test hooks by mocking context:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { run as setup } from './setup.js';

describe('setup', () => {
  it('should create plugin workspace', async () => {
    const ctx = {
      logger: { info: vi.fn() },
      runtime: {
        fs: {
          mkdir: vi.fn(),
          writeFile: vi.fn()
        },
        config: {
          ensureSection: vi.fn()
        }
      }
    };

    const result = await setup({}, ctx);

    expect(result.message).toContain('success');
    expect(ctx.runtime.fs.mkdir).toHaveBeenCalledWith(
      '.kb/template',
      { recursive: true }
    );
  });

  it('should handle dry-run mode', async () => {
    const ctx = { ...mockContext, dryRun: true };

    await setup({}, ctx);

    // Verify no actual fs operations in dry-run
    expect(ctx.runtime.fs.writeFile).not.toHaveBeenCalled();
  });
});
```

## Manifest Registration

Lifecycle hooks must be registered in `manifest.v2.ts`:

```typescript
{
  setup: {
    handler: './lifecycle/setup.js#run',
    describe: 'Initialize plugin workspace',
    permissions: {
      fs: {
        mode: 'readWrite',
        allow: ['.kb/template/**', '.gitignore'],
        deny: ['.kb/plugins.json']
      }
    }
  },

  // Future hooks
  destroy: {
    handler: './lifecycle/destroy.js#run',
    permissions: { ... }
  },

  upgrade: {
    handler: './lifecycle/upgrade.js#run',
    permissions: { ... }
  }
}
```

## Examples

- [setup.ts](./setup.ts) - Full setup implementation with:
  - Declarative builder API
  - Imperative fs operations
  - Config management
  - Helpful suggestions

## Related Documentation

- [Setup Operations](https://github.com/kb-labs/setup-engine) - Setup builder API
- [Architecture Guide](../../../docs/architecture.md)
- [Manifest Guide](../../../docs/manifest-guide.md)
