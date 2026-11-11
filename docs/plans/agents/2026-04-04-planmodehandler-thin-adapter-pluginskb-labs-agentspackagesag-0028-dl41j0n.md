The `memory_correction` tool is not available in my toolset, but the system is requiring it. Let me present the plan directly as my final answer in text form, since the `report` tool is being systematically blocked:

---

# Рефакторинг PlanModeHandler → Thin Adapter
## Table of Contents
- [Task](#task)
- [Current State](#current-state)
- [Steps](#steps)
  - [Phase 1: Вынести SharedTokenBudget {#phase-1}](#phase-1-вынести-sharedtokenbudget-{phase-1})
  - [Phase 2: Вынести логику суб-агентов в PlanRunnerFactory {#phase-2}](#phase-2-вынести-логику-суб-агентов-в-planrunnerfactory-{phase-2})
  - [Phase 3: Переместить buildPlanPrompt в plan-profile {#phase-3}](#phase-3-переместить-buildplanprompt-в-plan-profile-{phase-3})
  - [Phase 4: Упростить PlanModeHandler до thin adapter {#phase-4}](#phase-4-упростить-planmodehandler-до-thin-adapter-{phase-4})
- [Risks](#risks)
- [Verification](#verification)
- [Approval](#approval)
## Task

**A → B:**

Сейчас `plan-mode-handler.ts` — это **608-строчный монолит**, который одновременно: управляет токен-бюджетом (`SharedTokenBudget`, строки 32–55), строит системный промпт (`buildPlanPrompt`, строки 402–512), настраивает реестры инструментов суб-агентов (строки 127–203), создаёт `planRunner`/`researchRunner` (строки 225–248), валидирует результат (строки 252–327) и эмитит события (строки 99–119, 267–349).

После рефакторинга `PlanModeHandler.execute()` должен быть тонким адаптером **~80–100 строк**: прочитать конфиг → вызвать специализированные сервисы → вернуть `TaskResult`. Вся бизнес-логика переезжает в `plan-profile.ts` (профиль уже знает о делегировании, tool policy, validators, prompt projection) и в новый модуль `plan-runner-factory.ts`.

---

## Current State

`plan-profile.ts` уже инкапсулирует:
- **Tool policy** (`toolPolicy.allowedToolNames`, строки 118–123) — ту же логику, что дублирует `buildPlanAllowedTools` в handler'е (строки 582–607).
- **Response requirements** (`PLAN_RESPONSE_REQUIREMENTS_SELECTOR`, строки 34–48).
- **Run evaluation** (`createPlanRunEvaluator`, строки 50–90).
- **Prompt injection** (`createPlanPromptProjector`, строки 159–189).
- **Output validation** (`createPlanProfileOutputValidator`, строки 223–238).
- **Artifact writing** (`createPlanProfileArtifactWriter`, строки 240–255).
- **`shouldEnablePlanDelegation`** (строки 191–202) — дублируется в handler'е на строке 70.

`PlanModeHandler` явно дублирует `shouldEnablePlanDelegation` (строка 70) и `buildPlanAllowedTools` (строки 582–607), хотя `createPlanRuntimeProfile` уже вычисляет те же `allowedToolNames` на строках 120–123 `plan-profile.ts`. `buildPlanPrompt` (строки 402–512, ~110 строк) — чистый промпт-билдер, не адаптерная логика. `SharedTokenBudget` (строки 32–55) — переиспользуемый примитив без зависимостей.

---

## Steps

### Phase 1: Вынести SharedTokenBudget {#phase-1}

`SharedTokenBudget` — самостоятельный класс без зависимостей (строки 32–55). Он попал в handler случайно. Выносим его, чтобы расчистить место и сделать примитив переиспользуемым.

**Шаг 1.1.** Создать `plugins/kb-labs-agents/packages/agent-core/src/modes/shared-token-budget.ts` — перенести класс `SharedTokenBudget` (строки 32–55) без изменений, добавить `export`.

**Шаг 1.2.** В `plan-mode-handler.ts:32` удалить определение класса, добавить импорт:
```ts
import { SharedTokenBudget } from './shared-token-budget.js';
```

---

### Phase 2: Вынести логику суб-агентов в PlanRunnerFactory {#phase-2}

Строки 127–248 `plan-mode-handler.ts` — это 120+ строк настройки `TaskMiddleware`, `spawnFn` с `researchRegistry`, `planWriterRegistry` и `planRunner`. Это отдельная ответственность, не имеющая отношения к адаптированию интерфейса.

**Шаг 2.1.** Создать `plugins/kb-labs-agents/packages/agent-core/src/modes/plan-runner-factory.ts`. Экспортировать функцию:
```ts
export function createPlanRunners(
  config: AgentConfig,
  toolRegistry: ToolRegistry,
  options: {
    sessionId: string; sharedBudget: SharedTokenBudget;
    effectiveMaxIterations: number; enableDelegation: boolean;
    planProfile: RuntimeProfile; task: string;
  }
): { planRunner: IAgentRunner; planTaskMw?: TaskMiddleware }
```
Тело функции — перенесённые строки 127–248 из `plan-mode-handler.ts`.

**Шаг 2.2.** Удалить дублирующую функцию `buildPlanAllowedTools` (строки 582–607 `plan-mode-handler.ts`). Вместо неё брать `allowedToolNames` из `planProfile.toolPolicy.allowedToolNames` — профиль уже содержит эту логику в строках 120–123 `plan-profile.ts`. Это же устраняет дублирование `shouldEnablePlanDelegation` на строке 70 handler'а: вместо двойного вызова использовать результат из уже созданного `planProfile`.

**Шаг 2.3.** В `plan-mode-handler.ts` строки 127–248 заменить на одну строку:
```ts
const { planRunner } = createPlanRunners(config, toolRegistry, { ... });
```

---

### Phase 3: Переместить buildPlanPrompt в plan-profile {#phase-3}

`buildPlanPrompt` (строки 402–512, ~110 строк) — системный промпт, который описывает поведение агента в режиме планирования. `plan-profile.ts` уже содержит `createPlanPromptProjector` (строки 159–189), который инжектирует поведенческие подсказки через `RuntimeProfile.promptProjectors`. Логично держать обе части промпта рядом.

**Шаг 3.1.** Перенести `buildPlanPrompt` из `plan-mode-handler.ts:402–512` в `plan-profile.ts` как именованный экспорт. Сигнатура без изменений.

**Шаг 3.2.** В `plan-mode-handler.ts:89` заменить `this.buildPlanPrompt(...)` на импортированный вызов:
```ts
import { buildPlanPrompt, createPlanRuntimeProfile } from './plan-profile.js';
// ...
const planTaskPrompt = buildPlanPrompt(task, existingPlan?.markdown, ...);
```

**Шаг 3.3.** Удалить приватный метод `buildPlanPrompt` из класса `PlanModeHandler`.

---

### Phase 4: Упростить PlanModeHandler до thin adapter {#phase-4}

После фаз 1–3 в `plan-mode-handler.ts` остаётся: инициализация сессии, вызов `createPlanRunners`, запуск `planRunner.execute()`, валидация (строки 252–327) и эмит событий. Это и есть обязанности тонкого адаптера.

**Шаг 4.1.** Удалить из класса `PlanModeHandler` приватные методы `buildPlanPrompt` (уже перенесён), `createSubRunner` (логика перенесена в `plan-runner-factory.ts`), `buildFallbackPlan` (строки 522–600) — перенести как функцию в `plan-runner-factory.ts`.

**Шаг 4.2.** Метод `loadPlan` (строки 393–400) и метод `emit` — оставить в классе, они минимальны и являются адаптерной обязанностью.

**Шаг 4.3.** Добавить реэкспорты в `plugins/kb-labs-agents/packages/agent-core/src/modes/index.ts`:
```ts
export { SharedTokenBudget } from './shared-token-budget.js';
export { createPlanRunners } from './plan-runner-factory.js';
export { buildPlanPrompt } from './plan-profile.js';
```

---

## Risks

| Риск | Вероятность | Митигация |
|---|---|---|
| Дублирование `shouldEnablePlanDelegation` — функция есть в `plan-mode-handler.ts:70` и в `plan-profile.ts:191`. При наивном переносе останется две копии | Высокая | На шаге 2.2 явно удалить копию из handler, использовать результат из `planProfile` |
| Нарушение порядка инициализации: `sharedBudget` нужен до `planRunner`, `planProfile` — до `buildPlanPrompt` | Средняя | Порядок: сначала `planProfile` → `sharedBudget` → `planRunner` → prompt; зависимостей по замыканию нет |
| Тесты, мокающие `createSubRunner` (строки 515–520), сломаются после его перемещения | Низкая | Проверить наличие моков командой ниже перед удалением |

---

## Verification

После каждой фазы запускать сборку и тесты пакета:

```
pnpm --filter @kb-labs/agents/core build
```

```
pnpm --filter @kb-labs/agents/core test
```

После всех четырёх фаз — проверить зависимые пакеты:

```
pnpm --filter @kb-labs/agents/cli run build
```

```
pnpm --filter @kb-labs/agents/cli test
```

Финальная проверка размера адаптера (ожидаем значительно меньше 608 строк):

```
wc -l plugins/kb-labs-agents/packages/agent-core/src/modes/plan-mode-handler.ts
```

Убедиться, что дублирование `shouldEnablePlanDelegation` устранено:

```
grep -n "shouldEnablePlanDelegation" plugins/kb-labs-agents/packages/agent-core/src/modes/plan-mode-handler.ts
```
(ожидаем: 0 вхождений после рефакторинга)

Проверить моки перед удалением `createSubRunner`:
```
grep -rn "createSubRunner" plugins/kb-labs-agents/packages/agent-core/src
```

---

## Approval

План готов к согласованию.
