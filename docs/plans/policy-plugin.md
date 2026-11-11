# ТЗ: Policy Plugin

Status: dropped 2026-10-21 (owner decision)

## Описание

`Enforces workspace-level development policies per category. Detects which category a repo belongs to, resolves applicable rules, and validates compliance. Blocks pipeline on violations.`

## Пакет

```
plugins/kb-labs-policy-plugin/
├── packages/
│   ├── policy-cli/           # CLI commands (handlers)
│   ├── policy-core/          # Category resolver, policy runner, checks
│   └── policy-contracts/     # Types, config schema, policy interfaces
```

Зависимость: только `@kb-labs/sdk`. ESLint preset: `plugin.js`.

## Конфиг

Policies настраиваются в `.kb/kb.config.json` в секции `policies`. Плагин читает через SDK (`platform.config`).

```json
{
  "policies": {
    "categories": {
      "platform": {
        "paths": ["platform/*"],
        "rules": ["boundary-check"]
      },
      "infra": {
        "paths": ["infra/*"],
        "rules": ["boundary-check"]
      },
      "plugins": {
        "paths": ["plugins/*"],
        "rules": ["sdk-only-deps", "boundary-check"]
      },
      "sdk": {
        "paths": ["platform/kb-labs-sdk"],
        "rules": ["boundary-check", "no-breaking-without-major", "no-rollback", "api-compat-check"]
      },
      "templates-plugin": {
        "paths": ["templates/kb-labs-plugin-template"],
        "rules": ["sdk-only-deps"]
      },
      "templates-product": {
        "paths": ["templates/kb-labs-product-template"],
        "rules": ["boundary-check"]
      }
    },
    "rules": {
      "sdk-only-deps": {
        "description": "Package can only depend on @kb-labs/sdk + own internal packages",
        "severity": "error"
      },
      "boundary-check": {
        "description": "Dependencies must stay within allowed category boundaries",
        "severity": "error",
        "config": {
          "allowed": {
            "platform": ["platform", "infra"],
            "infra": ["infra", "platform"],
            "plugins": ["sdk-only"],
            "templates-plugin": ["sdk-only"],
            "templates-product": ["platform", "infra"]
          }
        }
      },
      "no-breaking-without-major": {
        "description": "Cannot remove or rename exported symbols without major version bump",
        "severity": "error"
      },
      "no-rollback": {
        "description": "Cannot decrease version once published to npm",
        "severity": "error"
      },
      "api-compat-check": {
        "description": "Exported API must be backward compatible within same major version",
        "severity": "error"
      }
    }
  }
}
```

## CLI команды

### `pnpm kb policy detect`

Определяет категорию для переданных путей или changed repos.

```bash
# Auto-detect from git diff
pnpm kb policy detect --json

# Для конкретного пути
pnpm kb policy detect --path="plugins/kb-labs-mind" --json
```

**Output:**
```json
{
  "repos": [
    {
      "path": "plugins/kb-labs-mind",
      "category": "plugins",
      "rules": ["sdk-only-deps", "boundary-check"]
    }
  ]
}
```

### `pnpm kb policy check`

Прогоняет все policies для changed repos. Блокирует при нарушениях.

```bash
# Проверить текущие изменения
pnpm kb policy check --json

# Проверить конкретный репо
pnpm kb policy check --path="platform/kb-labs-sdk" --json

# Human-readable
pnpm kb policy check
```

**Output (JSON):**
```json
{
  "passed": false,
  "repos": [
    {
      "path": "plugins/kb-labs-mind",
      "category": "plugins",
      "violations": [
        {
          "rule": "sdk-only-deps",
          "severity": "error",
          "message": "@kb-labs/mind/cli imports @kb-labs/plugin-contracts directly",
          "package": "@kb-labs/mind/cli",
          "detail": "Plugins must depend only on @kb-labs/sdk. Move needed types to SDK or use SDK re-exports.",
          "file": "packages/mind-cli/package.json"
        }
      ],
      "passed": []
    }
  ],
  "summary": {
    "total": 3,
    "passed": 2,
    "failed": 1,
    "violations": 1
  }
}
```

**Output (human-readable):**
```
📋 Policy Check

plugins/kb-labs-mind (category: plugins)
  ❌ sdk-only-deps
     @kb-labs/mind/cli imports @kb-labs/plugin-contracts directly
     → Plugins must depend only on @kb-labs/sdk

  ✅ boundary-check

platform/kb-labs-sdk (category: sdk)
  ✅ boundary-check
  ✅ no-breaking-without-major
  ✅ no-rollback
  ✅ api-compat-check

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ 1 violation(s) found — pipeline blocked
```

### `pnpm kb policy rules`

Показывает все правила и какие категории им подчиняются.

```bash
pnpm kb policy rules --json
pnpm kb policy rules
```

**Output:**
```
📋 Policy Rules

  sdk-only-deps
    Packages can only depend on @kb-labs/sdk + own internal packages
    Applied to: plugins, templates-plugin

  boundary-check
    Dependencies must stay within allowed category boundaries
    Applied to: platform, infra, plugins, templates-product

  no-breaking-without-major
    Cannot remove/rename exported symbols without major version bump
    Applied to: sdk

  no-rollback
    Cannot decrease version once published to npm
    Applied to: sdk

  api-compat-check
    Exported API must be backward compatible within same major version
    Applied to: sdk
```

## Реализация policy checks

### sdk-only-deps

**Что проверяет:** `package.json` dependencies каждого пакета в репо. Все `@kb-labs/*` зависимости должны быть либо `@kb-labs/sdk`, либо внутренними пакетами того же репо.

**Алгоритм:**
1. Прочитать все `package.json` в `<repo>/packages/*/` и `<repo>/apps/*/`
2. Для каждого `@kb-labs/*` dependency проверить:
   - `@kb-labs/sdk` → ok
   - Пакет из того же репо (например `@kb-labs/mind/core` в `kb-labs-mind`) → ok
   - Всё остальное → violation
3. Проверять и `dependencies`, и `devDependencies` (devDependencies можно ослабить — only `@kb-labs/shared-testing` допустим, решить)

### boundary-check

**Что проверяет:** `package.json` dependencies каждого пакета. Все `@kb-labs/*` зависимости должны принадлежать разрешённым категориям.

**Алгоритм:**
1. Построить map: `@kb-labs/package-name → category` (из workspace scan)
2. Для каждого пакета проверить все `@kb-labs/*` deps
3. Каждый dep должен принадлежать разрешённой категории (из `config.allowed`)
4. Собственные пакеты репо всегда разрешены

### no-breaking-without-major

**Что проверяет:** exported symbols из `.d.ts` не удалены/переименованы без major bump.

**Алгоритм:**
1. Получить published версию: `npm show @kb-labs/sdk version`
2. Получить published `.d.ts`: `npm pack @kb-labs/sdk@<published> --dry-run` или из `node_modules`
3. Сравнить exported symbols (functions, classes, types, interfaces)
4. Если есть REMOVED или CHANGED:
   - Текущая версия major > published major → ok (major bump)
   - Иначе → violation

**Как извлечь exported symbols:**
- Простой подход: regex parse `.d.ts` на `export { ... }`, `export function`, `export class`, `export type`, `export interface`
- Продвинутый: TypeScript Compiler API (`ts.createProgram` → `checker.getExportsOfModule`)

Для MVP — простой regex подход. Потом можно улучшить.

### no-rollback

**Что проверяет:** текущая версия в `package.json` >= опубликованная на npm.

**Алгоритм:**
1. `npm show @kb-labs/<package> version` → published version (или "0.0.0" если не опубликован)
2. Прочитать `package.json` → current version
3. `semver.gte(current, published)` → ok
4. Иначе → violation

**Зависимость:** `semver` пакет (уже есть в workspace).

### api-compat-check

**Что проверяет:** backward compatibility API. По сути комбинация `no-breaking-without-major`, но с детальным diff.

**Output включает:**
- ADDED exports (ok — расширение API)
- REMOVED exports (breaking — блокирует)
- CHANGED signatures (breaking — блокирует)

## Интеграция в workflows

### dev-done.yml

Добавить step между QA и sync:

```yaml
- name: Policy Check
  id: policy
  uses: builtin:shell
  with:
    command: pnpm kb policy check --json

- name: Policy Gate
  id: policy-gate
  uses: builtin:gate
  with:
    decision: "steps.policy.outputs.passed"
    routes:
      "true": continue
      "false": fail
```

### dev-start.yml

Добавить step после create-branch:

```yaml
- name: Detect Policies
  id: policies
  uses: builtin:shell
  with:
    command: |
      pnpm kb policy detect --json
      # Output включает category и rules — сохраняется в контекст задачи
```

## Edge Cases

1. **Несколько категорий в одной задаче** — например changed repos из `platform/` и `plugins/`. Каждый репо проверяется по своим правилам. Общий результат: `passed = all passed`.

2. **Новый репо без категории** — если путь не матчит ни одну категорию, применить default правила (только `boundary-check`). Вывести warning: "repo X has no category, using defaults".

3. **npm недоступен** — `no-rollback` и `api-compat-check` требуют `npm show`. Если offline — skip с warning, не блокировать.

4. **Пакет не опубликован** — `no-rollback` → skip (нечего сравнивать). `api-compat-check` → skip.

5. **devDependencies** — `sdk-only-deps` проверяет только `dependencies`. `devDependencies` могут содержать тестовые утилиты (`@kb-labs/shared-testing`).

## Критерии готовности

1. `pnpm kb policy detect --json` — определяет категорию для всех repos
2. `pnpm kb policy check --json` — прогоняет все rules, возвращает `passed: true/false`
3. `pnpm kb policy check` — human-readable output с детальным описанием violations
4. `pnpm kb policy rules` — показывает все правила
5. Все 5 policy checks реализованы и работают
6. Exit code 1 при violations (для pipeline integration)
7. Плагин зависит только от `@kb-labs/sdk`
8. ESLint preset: `plugin.js`
9. Step добавлен в `dev-done.yml` и `dev-start.yml`
10. Конфиг читается из `.kb/kb.config.json` секция `policies`
