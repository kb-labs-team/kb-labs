# V3 Migration Quick Reference

**Шпаргалка для быстрой миграции команд с V2 на V3**

## Было → Стало

### Imports
```typescript
// ❌ V2
import { defineCommand } from '@kb-labs/sdk';
import { getCommandId } from '@kb-labs/plugin-contracts';
import { myFlags } from './flags';

// ✅ V3
import { defineCommand, type PluginContextV3, type CommandResult } from '@kb-labs/sdk';
```

### Types
```typescript
// ❌ V2 - external file
import { MyFlags } from './flags';

// ✅ V3 - inline
interface MyFlags { name?: string; }
interface MyInput { argv: string[]; flags: MyFlags; }
interface MyResult { data: string; }
```

### Command Structure
```typescript
// ❌ V2
export const run = defineCommand<MyFlags, MyResult>({
  name: getCommandId('plugin:cmd'),
  flags: myFlags,
  async handler(ctx, argv, flags) {
    return { ok: true, result };
  }
});

// ✅ V3
export default defineCommand<unknown, MyInput, MyResult>({
  id: 'plugin:cmd',
  description: 'Does work',
  handler: {
    async execute(ctx: PluginContextV3<unknown>, input: MyInput): Promise<CommandResult<MyResult>> {
      return { exitCode: 0, result };
    }
  }
});
```

### Platform Services
```typescript
// ❌ V2
ctx.logger?.info('test');
ctx.llm?.complete('test');

// ✅ V3
ctx.platform.logger.info('test');
ctx.platform.llm.complete('test');
```

### Return Value
```typescript
// ❌ V2
return { ok: true, result: { data: '...' } };
return { ok: false, error: 'failed' };

// ✅ V3
return { exitCode: 0, result: { data: '...' } };
return { exitCode: 1 };  // or throw error
```

### Manifest
```typescript
// ❌ V2
{
  id: 'plugin:cmd',
  handler: './cli/commands/run.js#runCommand'
}

// ✅ V3
{
  id: 'plugin:cmd',
  handler: './cli/commands/cmd.js#default',
  handlerPath: './cli/commands/cmd.js',
  flags: defineCommandFlags({ /* ... */ }),
  examples: generateExamples('cmd', 'plugin', [ /* ... */ ]),
  permissions: permissions.presets.pluginWorkspaceRead('plugin')
}
```

## 5 Шагов Миграции

### 1. Создай новый файл команды
```typescript
// src/cli/commands/my-command.ts

import { defineCommand, type PluginContextV3, type CommandResult } from '@kb-labs/sdk';

interface MyFlags {
  name?: string;
  verbose?: boolean;
}

interface MyInput {
  argv: string[];
  flags: MyFlags;
}

interface MyResult {
  message: string;
}

export default defineCommand<unknown, MyInput, MyResult>({
  id: 'my-plugin:my-command',
  description: 'Short description',

  handler: {
    async execute(
      ctx: PluginContextV3<unknown>,
      input: MyInput
    ): Promise<CommandResult<MyResult>> {

      // Твоя логика здесь
      const result = {
        message: `Hello ${input.flags.name || 'World'}`
      };

      // UI output
      ctx.ui.success('Done', {
        summary: { 'Message': result.message }
      });

      return { exitCode: 0, result };
    }
  }
});
```

### 2. Добавь в manifest.v3.ts
```typescript
cli: {
  commands: [
    {
      id: 'my-plugin:my-command',
      group: 'my-plugin',
      describe: 'Short description',
      longDescription: 'Longer description with details.',

      flags: defineCommandFlags({
        name: {
          type: 'string',
          description: 'Name to use',
          default: 'World',
          alias: 'n',
        },
        verbose: {
          type: 'boolean',
          description: 'Verbose output',
          default: false,
          alias: 'v',
        },
      }),

      examples: generateExamples('my-command', 'my-plugin', [
        { description: 'Basic usage', flags: {} },
        { description: 'With custom name', flags: { name: 'Developer' } },
      ]),

      handler: './cli/commands/my-command.js#default',
      handlerPath: './cli/commands/my-command.js',

      permissions: permissions.presets.pluginWorkspaceRead('my-plugin'),
    }
  ]
}
```

### 3. Build & Test
```bash
pnpm --filter @kb-labs/my-plugin-core run build
pnpm kb my-plugin:my-command --help
pnpm kb my-plugin:my-command
pnpm kb my-plugin:my-command --name "Dev"
```

### 4. Удали старые файлы
```bash
# После проверки всех команд
rm src/manifest.v2.ts
rm src/cli/commands/flags.ts  # если есть
rm src/cli/commands/old-*.ts  # V2 версии
```

### 5. Обнови package.json
```json
{
  "dependencies": {
    "@kb-labs/sdk": "workspace:*"
    // Удали:
    // "@kb-labs/plugin-contracts": "workspace:*",
    // "@kb-labs/my-plugin-contracts": "workspace:*"
  }
}
```

## Типовые Паттерны

### Простая команда
```typescript
export default defineCommand<unknown, MyInput, MyResult>({
  id: 'plugin:simple',
  description: 'Simple command',
  handler: {
    async execute(ctx, input) {
      return { exitCode: 0, result: { data: input.flags.value } };
    }
  }
});
```

### С LLM
```typescript
handler: {
  async execute(ctx, input) {
    if (!ctx.platform.llm) {
      ctx.ui.error('LLM not configured');
      return { exitCode: 1 };
    }

    const response = await ctx.platform.llm.complete(input.flags.prompt);
    return { exitCode: 0, result: { response } };
  }
}
```

### С трейсингом
```typescript
handler: {
  async execute(ctx, input) {
    ctx.trace.addEvent('cmd.start', input.flags);

    const result = await doWork();

    ctx.trace.addEvent('cmd.complete', { result });
    return { exitCode: 0, result };
  }
}
```

### С UI прогрессом
```typescript
import { useLoader } from '@kb-labs/sdk';

handler: {
  async execute(ctx, input) {
    const loader = useLoader('Processing...');
    loader.start();

    await doWork();

    loader.succeed('Done!');
    return { exitCode: 0 };
  }
}
```

## Чеклист Команды

- [ ] Import только `@kb-labs/sdk`
- [ ] Types inline (MyFlags, MyInput, MyResult)
- [ ] `export default defineCommand<unknown, MyInput, MyResult>(...)`
- [ ] `id` как строка (не `getCommandId()`)
- [ ] `description` есть
- [ ] `handler: { async execute(ctx, input) { ... } }`
- [ ] `ctx.platform.*` вместо `ctx.*`
- [ ] Return `{ exitCode: 0, result }`
- [ ] Manifest entry с `#default`

## Частые Ошибки

### ❌ Старый формат handler
```typescript
async handler(ctx, argv, flags) { /* ... */ }
```

### ✅ Новый формат handler
```typescript
handler: {
  async execute(ctx, input) { /* ... */ }
}
```

---

### ❌ Импорт контрактов
```typescript
import { getCommandId } from '@kb-labs/plugin-contracts';
```

### ✅ Без контрактов
```typescript
// Просто строка
id: 'my-plugin:my-command'
```

---

### ❌ Внешние флаги
```typescript
import { myFlags } from './flags';
```

### ✅ Inline флаги
```typescript
interface MyFlags { name?: string; }
```

---

### ❌ Старый return
```typescript
return { ok: true, result };
```

### ✅ Новый return
```typescript
return { exitCode: 0, result };
```

## Полезные Ссылки

- [Полный план миграции](./V3-MIGRATION-PLAN.md)
- [Английский гайд](../docs/V3-MIGRATION-GUIDE.EN.md)
- [Русский гайд](../docs/V3-MIGRATION-GUIDE.md)
- [V3 архитектура](../docs/V3-ADAPTER-ARCHITECTURE.md)
- [Пример: hello.ts](./src/cli/commands/hello.ts)

---

**Вопросы?** Смотри `kb-labs-plugin-template` или создай issue.
