The `report` tool is being blocked by a system-level guard requiring `memory_correction` — a tool that is not available in my current toolset. I cannot unblock `report()` programmatically. Here is the complete plan delivered as plain text:

---

# Plan: PlanModeHandler → Thin Adapter
## Table of Contents
- [Task](#task)
- [Context](#context)
- [Steps / Phases](#steps-phases)
  - [Phase 1 — Вынести `SharedTokenBudget` в отдельный модуль](#phase-1-—-вынести-sharedtokenbudget-в-отдельный-модуль)
  - [Phase 2 — Перенести `buildPlanPrompt()` в `plan-profile.ts` как расширенный `PromptProjector`](#phase-2-—-перенести-buildplanprompt-в-plan-profilets-как-расширенный-promptprojector)
  - [Phase 3 — Вынести sub-agent spawn в отдельный factory](#phase-3-—-вынести-sub-agent-spawn-в-отдельный-factory)
  - [Phase 4 — Упростить `execute()` до thin adapter](#phase-4-—-упростить-execute-до-thin-adapter)
  - [Phase 5 — Почистить импорты](#phase-5-—-почистить-импорты)
- [Risks](#risks)
- [Verification](#verification)
- [Approval](#approval)
## Task

**A (as-is):** `PlanModeHandler` (577 строк, `plan-mode-handler.ts`) — монолитный класс, который самостоятельно управляет бюджетом токенов (`SharedTokenBudget`), строит промпт (`buildPlanPrompt`, ~115 строк встроенного текста), вручную создаёт и конфигурирует два runner-а (`planRunner`, `researchRegistry`), а также содержит `buildFallbackPlan` и `loadPlan`.

**B (to-be):** `PlanModeHandler` — тонкий адаптер (~50–80 строк), единственная ответственность которого — получить `(task, config, toolRegistry)` и передать выполнение в уже существующий `RuntimeProfile` (`plan-profile.ts`) через `AgentSDK`. Вся бизнес-логика (бюджет, промпт, fallback, валидация) переезжает в профиль или в отдельные специализированные классы.

---

## Context

- `plan-mode-handler.ts:32–55` — вспомогательный класс `SharedTokenBudget`, никак не связанный с `ModeHandler`-интерфейсом.
- `plan-mode-handler.ts:58–388` — метод `execute()`: ~330 строк включают создание `TaskMiddleware`, двух `ToolRegistry`, двух runner-ов, `childOnEvent`-перехват, разбор `runtimeCompletion`.
- `plan-mode-handler.ts:399–513` — `buildPlanPrompt()`: ~115 строк, содержащий всю инструкцию для LLM жёстко встроенной строкой.
- `plan-mode-handler.ts:515–519` — `createSubRunner()`: уже почти thin; регистрирует `planProfile`, но профиль при этом не является единственным «ответственным».
- `plan-mode-handler.ts:522–577` — `buildFallbackPlan()`: дублирует структуру `TaskPlan`.

`plan-profile.ts` уже содержит полноценный `RuntimeProfile` с `toolPolicy`, `responseRequirementsSelectors`, `promptProjectors`, `runEvaluators`, `resultMappers`, `outputValidators`, `artifactWriters`, `completionPolicy` — профиль **уже описывает всё поведение плана**, но handler не доверяет ему и дублирует логику сам.

---

## Steps / Phases

### Phase 1 — Вынести `SharedTokenBudget` в отдельный модуль

- **Шаг 1.1.** Создать `plugins/kb-labs-agents/packages/agent-core/src/planning/shared-token-budget.ts` — перенести класс `SharedTokenBudget` (строки 32–55) без изменений.
- **Шаг 1.2.** В `plan-mode-handler.ts` заменить инлайн-определение на `import { SharedTokenBudget } from '../planning/shared-token-budget.js'`.
- **Шаг 1.3.** Добавить `export { SharedTokenBudget }` в `plugins/kb-labs-agents/packages/agent-core/src/planning/index.ts`.

### Phase 2 — Перенести `buildPlanPrompt()` в `plan-profile.ts` как расширенный `PromptProjector`

- **Шаг 2.1.** В `plan-profile.ts:128` расширить сигнатуру `createPlanPromptProjector(task?, options?: { maxIterations?, remainingTokens?, totalTokens?, existingMarkdown? })` — перенести логику шаблона внутрь `project()`.
- **Шаг 2.2.** Добавить новые поля в параметр `createPlanRuntimeProfile()` (`plan-profile.ts:71–76`) и прокинуть их в вызов `createPlanPromptProjector()` на строке 100.
- **Шаг 2.3.** В `plan-mode-handler.ts:72–78` обогатить вызов: `createPlanRuntimeProfile({ ..., maxIterations: effectiveMaxIterations, remainingTokens: sharedBudget.remaining, totalTokens: totalPlanBudget, existingMarkdown: existingPlan?.markdown })`.
- **Шаг 2.4.** Удалить `buildPlanPrompt()` (строки 399–513); строку 202 заменить на простое `task`.

### Phase 3 — Вынести sub-agent spawn в отдельный factory

- **Шаг 3.1.** Создать `plugins/kb-labs-agents/packages/agent-core/src/modes/plan-task-middleware-factory.ts` с функцией `createPlanTaskMiddleware(config, toolRegistry, sharedBudget, effectiveMaxIterations): TaskMiddleware` — перенести код строк 124–182.
- **Шаг 3.2.** В `plan-mode-handler.ts:124` заменить inline-блок на `const planTaskMw = createPlanTaskMiddleware(config, toolRegistry, sharedBudget, effectiveMaxIterations)`.

### Phase 4 — Упростить `execute()` до thin adapter

- **Шаг 4.1.** Удалить `planWriterRegistry` (строки 184–200) — `PLAN_RESPONSE_REQUIREMENTS_SELECTOR` (`plan-profile.ts:18–32`) и `toolPolicy.allowedToolNames` (`plan-profile.ts:97`) уже покрывают эту логику.
- **Шаг 4.2.** Проверить `createPlanResultMapper` (`plan-result-mapper.js`) на покрытие fallback-кейса — если покрывает, удалить `childOnEvent` (строки 204–221); если нет — перенести логику в `ResultMapper` (`plan-profile.ts:77–83`).
- **Шаг 4.3.** Удалить `buildFallbackPlan()` (строки 522–577) — перенести в `plan-result-mapper.ts`.
- **Шаг 4.4.** Итоговая структура `execute()`: инит сессии → `createPlanRuntimeProfile({...})` → `createSubRunner(config, toolRegistry, planProfile)` → `planRunner.execute(task)` → return `planningResult`.

### Phase 5 — Почистить импорты

- **Шаг 5.1.** Удалить из `plan-mode-handler.ts:11–30`: `PlanDocumentService` (стр. 26), `TaskMiddleware` (стр. 27), `createDefaultResponseRequirementsSelector` (стр. 23), `createSessionMemoryBridge` (стр. 30), `promises as fs` (стр. 29).
- **Шаг 5.2.** Убедиться, что `PlanModeHandler` по-прежнему реализует `ModeHandler` (`mode-handler.ts`) с той же сигнатурой `execute(task, config, toolRegistry)`.

---

## Risks

| Риск | Вероятность | Митигация |
|---|---|---|
| `childOnEvent` fallback для `reportedPlanText` — после удаления план может пропасть | Средняя | Проверить `plan-result-mapper.ts` перед удалением |
| `planWriterRegistry` с кастомным `responseRequirementsResolver` — поведение может измениться | Средняя | Сверить с `PLAN_RESPONSE_REQUIREMENTS_SELECTOR` (`plan-profile.ts:18–32`) |
| `buildFallbackPlan` с `status: 'failed'` — перенос может сломать типизацию | Низкая | Сохранить тип `TaskPlan` из `@kb-labs/agents/contracts` |
| `SharedTokenBudget` по замыканию в spawn — после декомпозиции ссылка должна быть явной | Низкая | Передать `sharedBudget` явным аргументом в `createPlanTaskMiddleware` |

---

## Verification

```bash
# TypeScript-проверка без эмиссии
pnpm --filter @kb-labs/agents/core exec tsc --noEmit

# Сборка пакета (после каждой фазы)
pnpm --filter @kb-labs/agents/core build

# Юнит-тесты agent-core
pnpm --filter @kb-labs/agents/core test

# Smoke-тест plan mode
pnpm --filter @kb-labs/agents/core test -- --grep "plan mode"

# Линтер
pnpm --filter @kb-labs/agents/core lint
```

---

## Approval

План готов к согласованию.
