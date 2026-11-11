# ТЗ: Impact Analysis Plugin

Status: dropped 2026-10-21 (owner decision)

## Цель

Плагин `@kb-labs/impact` анализирует изменения в workspace и показывает что затронуто: зависимые пакеты, документация, индексы. Встраивается в `dev-done` workflow как предупреждающий (не блокирующий) step.

## Команды

```bash
# Полный анализ (что изменилось → что затронуто)
pnpm kb impact check --json

# Только package impact
pnpm kb impact packages --json

# Только doc impact
pnpm kb impact docs --json
```

## Архитектура

Стандартная структура плагина:

```
plugins/kb-labs-impact/
├── packages/
│   ├── impact-cli/          # CLI команды
│   ├── impact-core/         # Бизнес-логика
│   └── impact-contracts/    # Типы и интерфейсы
```

Зависимость: только `@kb-labs/sdk`.

## Package Impact

### Вход
- Список changed суб-репо (из `git diff` submodule pointers или `workspace-status.mjs`)
- Dependency graph (из pnpm workspace или devkit)

### Логика
1. Определить какие **пакеты** изменились (changed файлы внутри суб-репо)
2. Построить **reverse dependency graph** — кто зависит от изменённых пакетов
3. Определить **уровни impact**:
   - `direct` — пакет сам изменился
   - `dependent` — зависит от изменённого пакета (нужна пересборка)
   - `transitive` — зависит транзитивно (может потребовать пересборку)

### Выход
```json
{
  "packages": {
    "direct": [
      { "name": "@kb-labs/sdk", "repo": "platform/kb-labs-sdk", "changedFiles": 3 }
    ],
    "dependent": [
      { "name": "@kb-labs/agents/core", "repo": "plugins/kb-labs-agents", "reason": "depends on @kb-labs/sdk" }
    ],
    "transitive": [
      { "name": "@kb-labs/agents/cli", "repo": "plugins/kb-labs-agents", "reason": "depends on @kb-labs/agents/core" }
    ]
  },
  "recommendations": [
    "Rebuild @kb-labs/agents/core (depends on changed @kb-labs/sdk)",
    "Run tests in plugins/kb-labs-agents"
  ]
}
```

## Doc Impact

### Логика
1. Маппинг: пакет → связанная документация:
   - `@kb-labs/sdk` → `CLAUDE.md` (секция SDK), `CONTRIBUTING.md`, `CLI-REFERENCE.md`
   - `@kb-labs/*-cli` → `CLI-REFERENCE.md` (автогенерируемый, напомнить regenerate)
   - Любой новый пакет → обновить документацию о структуре workspace по необходимости
   - `@kb-labs/mind-*` → Mind RAG reindex
   - Workflow файлы → `DEVELOPMENT-PROCESS.md`
2. Проверить дату последнего изменения документа vs дату изменения кода
3. Сгенерировать рекомендации

### Маппинг хранится в конфиге
```json
// .kb/impact-rules.json
{
  "docRules": [
    {
      "match": "@kb-labs/sdk",
      "docs": ["CLAUDE.md", "CONTRIBUTING.md"],
      "action": "review"
    },
    {
      "match": "*-cli",
      "docs": ["CLI-REFERENCE.md"],
      "action": "regenerate",
      "command": "pnpm kb docs generate-cli-reference"
    },
    {
      "match": "@kb-labs/mind-*",
      "action": "reindex",
      "command": "pnpm kb mind index --scope default"
    },
    {
      "match": "__new_package__",
      "action": "regenerate",
      "command": "review workspace documentation"
    }
  ]
}
```

### Выход
```json
{
  "docs": {
    "stale": [
      { "file": "CLI-REFERENCE.md", "reason": "@kb-labs/agents/cli changed", "action": "regenerate", "command": "pnpm kb docs generate-cli-reference" }
    ],
    "review": [
      { "file": "CLAUDE.md", "reason": "@kb-labs/sdk changed", "action": "review sections mentioning SDK" }
    ],
    "reindex": [
      { "reason": "@kb-labs/mind-engine changed", "command": "pnpm kb mind index --scope default" }
    ]
  }
}
```

## Интеграция в dev-done

```yaml
# .kb/workflows/dev-done.yml — добавить между QA и sync:

- name: Impact Analysis
  id: impact
  uses: builtin:shell
  with:
    command: pnpm kb impact check --json
  continueOnError: true   # не блокирует, только предупреждает
```

Вывод impact показывается в summary step.

## Поведение

- **Не блокирует** `pnpm done` — только предупреждает
- **JSON output** для агентов (`--json`)
- **Human-readable** по умолчанию (цветной вывод с рекомендациями)
- **Идемпотентный** — можно запускать сколько угодно раз

## Пример human-readable output

```
📊 Impact Analysis

📦 Package Impact
  Direct (2):
    @kb-labs/sdk (platform/kb-labs-sdk) — 3 files changed
    @kb-labs/mind-engine (plugins/kb-labs-mind) — 1 file changed

  Dependent (3):
    @kb-labs/agents/core ← depends on @kb-labs/sdk
    @kb-labs/agents/cli ← depends on @kb-labs/agents/core
    @kb-labs/commit/core ← depends on @kb-labs/sdk

  ⚠️  Recommendations:
    • Rebuild @kb-labs/agents/core, @kb-labs/commit/core
    • Run tests in plugins/kb-labs-agents, plugins/kb-labs-commit-plugin

📄 Doc Impact
  Stale (1):
    CLI-REFERENCE.md — @kb-labs/agents/cli changed
    → Run: pnpm kb docs generate-cli-reference

  Review (1):
    CLAUDE.md — @kb-labs/sdk changed
    → Review sections mentioning SDK

  Reindex (1):
    Mind RAG — @kb-labs/mind-engine changed
    → Run: pnpm kb mind index --scope default
```

## Критерии готовности

1. `pnpm kb impact check` работает и показывает package + doc impact
2. `--json` выдаёт структурированный JSON
3. Плагин зависит только от `@kb-labs/sdk`
4. Step добавлен в `dev-done` workflow
5. Конфиг `impact-rules.json` позволяет добавлять новые правила без кода
