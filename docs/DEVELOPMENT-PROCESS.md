# KB Labs — Development Process

> От хаоса к прогнозируемому TTM.

---

## Принципы

1. **Суб-репо = свободная зона.** Коммить, экспериментируй — внутри своего репо на main.
2. **Workspace branch = изоляция задачи.** Feature-ветка в workspace фиксирует набор submodule pointers для конкретной задачи.
3. **PR = точка стабильности.** Мерж PR в main = проверенный снимок всей платформы.
4. **Автоматический enforcement.** Гейты срабатывают сами — не нужно помнить.
5. **Два режима разработки.** Ручной и агентный — одинаковый процесс на входе и выходе.

---

## Workspace Structure

```
kb-labs-workspace/          ← мета-репо, git submodules
├── platform/               ← ядро (core, cli, workflow, rest-api, studio, sdk, shared)
├── plugins/                ← расширения (agents, mind, devlink, commit, ai-review, ...)
├── infra/                  ← инфраструктура (plugin-system, adapters, gateway, devkit)
├── templates/              ← шаблоны для новых плагинов
├── installer/              ← Go лаунчер (kb-create)
├── sites/                  ← веб сайты
├── public/                 ← публичный репо (docs/roadmap, НЕ код)
└── docs/plans/             ← планы задач
```

Каждая папка внутри категории — **отдельный git-репозиторий** (submodule).
Workspace-root трекает **конкретные коммиты** каждого суб-репо.

**Ключевая модель:**
```
workspace main:              sdk@a1  agents@b2  core@c3   ← стабильный снимок
workspace feature/retry:     sdk@a1  agents@b5  core@c3   ← agents ушёл вперёд
workspace feature/auth:      sdk@a4  agents@b2  core@c6   ← sdk и core другие
```

Feature branch в workspace — это просто **разный набор указателей** на коммиты суб-репо. Суб-репо всегда на main.

---

## Полный цикл разработки

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   START                DEVELOP                 DONE              │
│   ─────                ───────                 ────              │
│                                                                  │
│   pnpm start           свободная работа        pnpm done         │
│   "описание"           в суб-репо              (авто)            │
│       │                     │                     │              │
│       ▼                     ▼                     ▼              │
│   ┌──────────┐         ┌──────────┐         ┌───────────┐       │
│   │ status   │         │ commit   │         │ QA check  │       │
│   │ branch   │         │ build    │         │ sync ptrs │       │
│   │ PR draft │         │ test     │         │ push      │       │
│   │ context  │         │          │         │ PR ready  │       │
│   └──────────┘         └──────────┘         │ summary   │       │
│                                             └───────────┘       │
│                                                                  │
│   Переключение между задачами:                                   │
│   git checkout feature/другая-задача                             │
│   git submodule update --recursive                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: START — Начало задачи

```bash
# Code change (default)
pnpm start "добавить retry в vector search"

# Documentation
pnpm start "обновить CONTRIBUTING" --type=docs

# Infrastructure
pnpm start "настроить CI для qa-plugin" --type=infra

# Release
pnpm start "релиз sdk v1.1.0" --type=release
```

**Что происходит автоматически (workflow `dev-start`):**

| Шаг | Действие | Зачем |
|-----|----------|-------|
| 1 | `pnpm status` | Показать состояние: dirty repos, unpushed коммиты |
| 2 | Проверка незакоммиченного | Предупредить если есть незавершённая работа |
| 3 | Создать feature branch | `code/add-retry-vector-search` в workspace |
| 4 | Создать draft PR на GitHub | По шаблону с правильным type |
| 5 | Записать контекст | `.kb/tmp/current-task.json` |

**Для сложных задач (3+ фазы):** дополнительно создать план:
```bash
cp docs/plans/plan-template.md docs/plans/2026-03-17-add-retry.md
```

**Результат:** Есть ветка, есть PR, контекст зафиксирован — можно работать.

---

## Phase 2: DEVELOP — Разработка

### Режим 1: Ручная разработка (ты сам)

```bash
# 1. Поиск кода
pnpm kb mind search --text "где реализован X?" --agent

# 2. Правки в суб-репо
cd plugins/kb-labs-mind
# ... код ...

# 3. Сборка
pnpm --filter @kb-labs/<package> run build

# 4. После CLI плагина

# 5. Коммит (через commit plugin или вручную)
pnpm kb commit commit --scope="@kb-labs/<package>"
# или
git add . && git commit -m "feat(scope): описание"
git push origin main
```

### Режим 2: Агентная разработка (AI делает)

```bash
pnpm kb workflow:run --workflow-id=dev-cycle \
  --input='{"task":"Add retry logic to vector search","scope":"@kb-labs/mind-engine"}'
```

**Что делает `dev-cycle` workflow:**
```
Plan (agent)
  → Approve Plan (human)
    → Implement (agent)
      → Review Gate (auto, rework loop x3)
        → QA Gate (auto)
          → Approve Result (human)
            → Commit (auto)
```

Агент работает внутри суб-репо. Коммитит в суб-репо на main. Ничего не знает о workspace.

### Кросс-репо изменения

Если задача затрагивает несколько суб-репо — просто работай в каждом по очереди (или агент работает). Коммити в каждый на main. `pnpm done` соберёт все изменения в один workspace коммит.

### Переключение между задачами

```bash
# Сохранить текущую работу
pnpm done                                    # или просто git add + commit в workspace

# Переключиться на другую задачу
git checkout feature/другая-задача
git submodule update --recursive             # суб-репо встают на нужные коммиты

# Вернуться
git checkout feature/retry
git submodule update --recursive
```

---

## Phase 3: DONE — Завершение

**Команда:**
```bash
pnpm done
```

**Что происходит автоматически:**

| Шаг | Действие | Блокирует? |
|-----|----------|-----------|
| 1 | Найти все changed суб-репо | — |
| 2 | Показать diff (какие коммиты в каких репо) | — |
| 3 | `pnpm kb qa regressions` | **Да** — если регрессии, стоп |
| 4 | Sync submodule pointers | — |
| 5 | Commit + push workspace branch | — |
| 6 | PR: draft → ready for review | — |
| 7 | Показать summary + PR link | — |

**Если QA блокирует:**
```
❌ QA regressions detected — sync aborted.

Fix regressions:
  pnpm kb qa run            # увидеть детали
  # ... исправить ...
  pnpm done                 # попробовать снова
```

**Мерж PR:**
```bash
# После pnpm done — PR готов, можно мержить
# На GitHub: Merge pull request → main

# Или через CLI:
gh pr merge --squash
```

**Мерж PR в main = проверенный снимок всей платформы.** Любой `git clone --recursive` получит рабочее состояние.

---

## Два режима — один процесс

```
                    ┌──── Ручной ────┐     ┌──── Агентный ─────┐
                    │                │     │                   │
START:              │ pnpm start     │     │ pnpm start        │
                    │ "задача"       │     │ "задача"          │
                    │ → branch + PR  │     │ → branch + PR     │
                    │                │     │                   │
DEVELOP:            │ ты кодишь      │     │ workflow:run      │
                    │ ты коммитишь   │     │ dev-cycle         │
                    │ в суб-репо     │     │ (plan→implement→  │
                    │                │     │  review→commit)   │
                    │                │     │                   │
                    └───────┬────────┘     └────────┬──────────┘
                            │                       │
                            ▼                       ▼
DONE (общий):       ┌──────────────────────────────────────────┐
                    │  pnpm done                               │
                    │  1. find changed sub-repos               │
                    │  2. QA regressions (блокирует)           │
                    │  3. sync submodule pointers              │
                    │  4. push workspace branch                │
                    │  5. PR: draft → ready                    │
                    │  6. summary + PR link                    │
                    └──────────────────────────────────────────┘
                            │
                            ▼
MERGE:              ┌──────────────────────────────────────────┐
                    │  gh pr merge (manual or auto)            │
                    │  → main = стабильный снимок              │
                    └──────────────────────────────────────────┘
```

---

## Реализация

Весь процесс реализован через KB Labs Workflow Engine. Определения: `.kb/workflows/dev-start.yml`, `.kb/workflows/dev-done.yml`.

### Команды

```bash
# Начать задачу (code по умолчанию)
pnpm start "добавить retry в vector search"

# Начать задачу определённого типа
pnpm start "обновить README" --type=docs
pnpm start "настроить CI" --type=infra
pnpm start "выпустить релиз" --type=release

# Завершить задачу
pnpm done

# Обзор состояния
pnpm status

# Прямой вызов через workflow engine
pnpm kb workflow:run --workflow-id=dev-start --input='{"task":"описание","type":"code"}'
pnpm kb workflow:run --workflow-id=dev-done
```

### dev-start — пошагово

| Шаг | Что делает | Workflow step |
|-----|-----------|---------------|
| 1 | Проверяет workspace status | `builtin:shell` → `workspace-status.mjs --json` |
| 2 | Предупреждает о незакоммиченном | `builtin:shell` → проверка dirty |
| 3 | Создаёт feature branch | `builtin:shell` → `git checkout -b {type}/{slug}` |
| 4 | Создаёт draft PR на GitHub | `builtin:shell` → `gh pr create --draft` |
| 5 | Сохраняет контекст задачи | `builtin:shell` → `.kb/tmp/current-task.json` |

**Branch naming:** `{type}/{task-slug}` — например `code/add-retry-vector-search`, `docs/update-readme`.

**Контекст задачи** (`.kb/tmp/current-task.json`):
```json
{
  "task": "добавить retry в vector search",
  "type": "code",
  "branch": "code/add-retry-vector-search",
  "prUrl": "https://github.com/.../pull/2",
  "startedAt": "2026-03-17T12:00:00Z"
}
```

### dev-done — пошагово

| Шаг | Что делает | Блокирует? | Зависит от типа? |
|-----|-----------|-----------|-----------------|
| 1 | Загружает контекст задачи | — | — |
| 2 | Находит changed суб-репо | — | — |
| 3 | QA regressions | **Да** | **Да** (см. таблицу ниже) |
| 4 | QA gate | **Да** | — |
| 5 | Sync submodule pointers + commit | — | — |
| 6 | Push workspace branch | — | — |
| 7 | PR: draft → ready | — | — |
| 8 | Summary + PR link | — | — |

### Type-aware Quality Gates

| Type | QA при `pnpm done` | AI Review | Branch prefix |
|------|-------------------|-----------|---------------|
| `code` | Полный (`pnpm kb qa regressions`) | Да (в dev-cycle) | `code/` |
| `docs` | Пропускается | Нет | `docs/` |
| `infra` | Только build | Нет | `infra/` |
| `release` | Полный | Нет | `release/` |

### Связанные workflows

| Workflow | Назначение | Файл |
|----------|-----------|------|
| `dev-start` | Начало задачи | `.kb/workflows/dev-start.yml` |
| `dev-done` | Завершение задачи | `.kb/workflows/dev-done.yml` |
| `dev-cycle` | Агентная разработка (plan→implement→review→commit) | `.kb/workflows/dev-cycle.yml` |
| `baseline-check` | Полная проверка качества (build, types, lint, tests) | `.kb/workflows/baseline-check.yml` |
| `qa-check` | Быстрая QA проверка | `.kb/workflows/qa-check.yml` |

---

## Quality Gates

### Автоматические (enforcement)

| Гейт | Когда | Что проверяет |
|-------|-------|---------------|
| `pnpm done` | Завершение задачи | QA regressions |
| PR merge | Мерж в main | CI checks (build, types, lint) |
| pre-push hook | `git push` в workspace | QA regressions (страховка) |

### В агентном режиме (дополнительно)

| Гейт | Когда | Что проверяет |
|-------|-------|---------------|
| Review Gate | После implement | AI Review + auto-rework (до 3 итераций) |
| QA Gate | После review | Build + type check |
| Human Approval | Перед commit | Финальная проверка человеком |

### Ручные (по необходимости)

| Команда | Когда использовать |
|---------|-------------------|
| `pnpm qa` | Промежуточная проверка во время разработки |
| `pnpm kb review:run` | Проверить конкретный репо |
| `npx kb-devkit-health` | Экстренная диагностика если платформа сломана |

### Правило: "Don't Make It Worse"

- ✅ Существующие ошибки — ok (baseline)
- ✅ Исправление ошибок — отлично (обнови baseline)
- ❌ Новые ошибки — блокировка

---

## Conventional Commits

Все коммиты (и в суб-репо, и в workspace) следуют формату:

```
<type>(<scope>): <description>

Типы:
  feat     — новая функциональность
  fix      — исправление бага
  refactor — рефакторинг без изменения поведения
  chore    — обслуживание (deps, configs, CI)
  docs     — документация
  test     — тесты
  perf     — оптимизация производительности
```

**Почему это важно:**
- Автоматический changelog из коммитов
- Автоматический semver bump (feat → minor, fix → patch)
- Понятная история изменений

---

## Versioning & Release (Level 2)

> Будет реализовано после стабилизации Level 1.

```bash
# Когда будет готово:
pnpm release <repo>       # bump version, changelog, tag, push
pnpm release:all          # release всех changed пакетов
```

**Flow:**
```
conventional commits
  → changelog generation
    → semver bump (feat=minor, fix=patch, BREAKING=major)
      → git tag
        → npm publish (для SDK и публичных пакетов)
          → GitHub release
```

---

## Ежедневный ритм

```bash
# Утро — где я?
pnpm status

# Начало задачи
pnpm start "описание"
# → создана ветка, создан draft PR

# Работа в суб-репо (весь день)
cd plugins/kb-labs-mind
# ... код, коммиты, тесты ...

# Или запуск агента
pnpm kb workflow:run --workflow-id=dev-cycle --input='{...}'

# Завершение
pnpm done
# → QA ✅ → sync → push → PR ready

# Мерж (когда уверен)
gh pr merge --squash

# Переключение на другую задачу
git checkout feature/другая-задача
git submodule update --recursive
```

---

## Edge Cases

### Срочный хотфикс
```bash
pnpm start "hotfix: critical search bug"
# → branch + draft PR

cd plugins/kb-labs-mind
git commit -m "fix: critical search bug"
git push

pnpm done
gh pr merge --squash
```

### Работа в нескольких суб-репо одновременно
```bash
# Коммить в каждый на main
cd platform/kb-labs-sdk && git commit ... && git push
cd plugins/kb-labs-agents && git commit ... && git push

# done подхватит все changed суб-репо
pnpm done
```

### Откат
```bash
# Откатить PR (revert merge commit)
git revert -m 1 <merge-commit>
git submodule update --recursive
pnpm done
```

### Переключение между задачами
```bash
# Текущая задача не готова — просто переключись
git checkout feature/другая-задача
git submodule update --recursive

# Суб-репо встанут на те коммиты, которые были зафиксированы
# в этой workspace-ветке
```

### Платформа сломана, QA не проходит
```bash
# Не обходить гейты. Чинить платформу.
# DevKit — fallback для диагностики:
npx kb-devkit-health --json
npx kb-devkit-ci
```

---

## Метрики (для будущего tracking)

| Метрика | Как измерять | Цель |
|---------|-------------|------|
| PR lead time | Время от `start` до merge | Baseline → тренд |
| QA block rate | % отклонённых `pnpm done` | <20% |
| Regression catch rate | Баги пойманные до merge | Рост со временем |
| Agent success rate | % dev-cycle без rework | >70% |

---

## Что НЕ входит в процесс

- **Как писать код** — это решает разработчик/агент
- **Какие инструменты использовать** — Mind RAG, grep, whatever works
- **Branch strategy суб-репо** — они всегда на main, branching только в workspace
- **Code review от людей** — заменено AI Review (автоматически)

Процесс контролирует **вход** (start → branch + PR) и **выход** (done → QA + merge). Середина — свободная.
