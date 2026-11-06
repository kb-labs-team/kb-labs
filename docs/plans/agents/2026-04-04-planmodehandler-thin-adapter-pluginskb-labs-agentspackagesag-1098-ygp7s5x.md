# Рефакторинг PlanModeHandler → thin adapter
## Table of Contents
- [Task](#task)
- [Current State (что сейчас не так)](#current-state-что-сейчас-не-так)
- [Steps / Phases](#steps-phases)
  - [Phase 1 — Перенести `buildPlanPrompt` в `PromptProjector` внутри `plan-profile.ts`](#phase-1-—-перенести-buildplanprompt-в-promptprojector-внутри-plan-profilets)
  - [Phase 2 — Вынести `SharedTokenBudget` из handler](#phase-2-—-вынести-sharedtokenbudget-из-handler)
  - [Phase 3 — Перенести логику spawnFn и TaskMiddleware в `plan-profile.ts`](#phase-3-—-перенести-логику-spawnfn-и-taskmiddleware-в-plan-profilets)
  - [Phase 4 — Заменить `childOnEvent` + `reportedPlanText` на `ResultMapper`](#phase-4-—-заменить-childonevent-reportedplantext-на-resultmapper)
  - [Phase 5 — Финальное упрощение handler: только thin adapter](#phase-5-—-финальное-упрощение-handler-только-thin-adapter)
- [Risks](#risks)
- [Verification](#verification)
- [Approval](#approval)
## Task

**A → B:** `PlanModeHandler` сейчас — это "fat handler" на ~608 строк, который владеет всей бизнес-логикой: бюджетированием токенов (`SharedTokenBudget`), построением промпта (`buildPlanPrompt`), созданием sub-runner'ов (`createSubRunner`), спавном делегирующих агентов (TaskMiddleware + spawnFn), захватом `reportedPlanText`, валидацией и emit-ом событий.

**Цель:** превратить его в thin adapter — он должен только собрать `RuntimeProfile` через `createPlanRuntimeProfile` и передать управление SDK, убрав дублирование логики, которая уже живёт (или должна жить) в `plan-profile.ts`.

---

## Current State (что сейчас не так)

`plan-mode-handler.ts` (строки 1–608) содержит несколько слоёв, которые должны принадлежать профилю или SDK:

| Что живёт в handler | Где должно быть |
|---|---|
| `SharedTokenBudget` (строки 32–55) | `plan-profile.ts` или отдельный модуль |
| `buildPlanPrompt` (строки 402–512) | `plan-profile.ts` → `PromptProjector` |
| `createSubRunner` + `planTaskMw` + spawnFn (строки 127–185) | `plan-profile.ts` → делегирующий `RunStrategy` |
| `reportedPlanText` capture через `childOnEvent` (строки 206–224) | `PlanResultMapper` |
| emit-цепочки `status:change` / `progress:update` (строки 99–119, 267–349) | SDK lifecycle |
| `loadPlan` + `buildFallbackPlan` (строки 393–400, 522–…) | `plan-profile.ts` → `ArtifactWriter` / `ResultMapper` |
| Validation check (`runtimeCompletion`, строки 252–260) | SDK / `PlanOutputValidator` |

`plan-profile.ts` уже содержит `PromptProjector`, `RunEvaluator`, `ResultMapper`, `OutputValidator`, `ArtifactWriter` — то есть **профиль уже готов принять логику**. Проблема только в том, что handler её не отдаёт.

---

## Steps / Phases

### Phase 1 — Перенести `buildPlanPrompt` в `PromptProjector` внутри `plan-profile.ts`

Сейчас в `plan-profile.ts:159–189` уже есть `createPlanPromptProjector`, который возвращает только минималистичный `# Active Profile` блок. Handler же строит полный ~90-строчный промпт сам (`buildPlanPrompt`, строки 402–512).

**Действие:** Расширить `createPlanPromptProjector` в `plan-profile.ts:159` — добавить в `project()` секции BUDGET, SCOPED PLANNING / DELEGATION, Output requirements, QUALITY CRITERIA. Параметры (`maxIterations`, `remainingTokens`, `totalTokens`, `existingMarkdown`) передавать через новые опции в `createPlanRuntimeProfile`, которая уже принимает `task`, `complexity`, `existingPlan` (строки 92–98 `plan-profile.ts`).

После этого в `plan-mode-handler.ts` строки 89–96 (`buildPlanPrompt`) заменяются на `runner.execute(task)` без дополнительного форматирования.

### Phase 2 — Вынести `SharedTokenBudget` из handler

`SharedTokenBudget` (строки 32–55) — маленький класс для отслеживания потребления токенов. Он тесно связан с делегированием sub-агентов и не является ответственностью адаптера.

**Действие:** Переместить класс `SharedTokenBudget` в новый файл `src/modes/plan-budget.ts` (или в `plan-profile.ts`). Из `plan-mode-handler.ts` убрать определение класса (строки 32–55), заменить на `import { SharedTokenBudget } from './plan-budget.js'`. Экземпляр бюджета создавать внутри `createPlanRuntimeProfile` и передавать в spawnFn (следующий шаг).

### Phase 3 — Перенести логику spawnFn и TaskMiddleware в `plan-profile.ts`

Самый большой блок "лишнего" — инициализация `planTaskMw` + `setSpawnFn` (строки 127–185), где вручную создаётся sub-registry, sub-runner, потребляется бюджет. Это стратегия выполнения, а не адаптер.

**Действие:** В `createPlanRuntimeProfile` (`plan-profile.ts:92`) добавить опцию `delegationContext: { toolRegistry, config, sharedBudget }`. Внутри функции строить `TaskMiddleware` и `setSpawnFn` так же, как сейчас в handler (строки 127–185), и включать результирующий `planTaskMw` в `RuntimeProfile` (через `completionPolicy` или отдельное поле SDK). Из handler убрать строки 127–185 целиком.

### Phase 4 — Заменить `childOnEvent` + `reportedPlanText` на `ResultMapper`

Строки 206–224: handler вручную перехватывает `tool:end` (`report`) и `llm:end`, чтобы вытащить текст плана. Это дублирует то, что частично уже делает `createPlanResultMapper` (`plan-profile.ts:99`).

**Действие:** Расширить `createPlanResultMapper` (`plan-profile.ts:99`) — добавить маппинг `reportedPlanText` из метаданных runner-результата (в т.ч. fallback из `llm:end`). Написать юнит-тест: дать маппер результату без `plan` в метаданных, убедиться, что возвращается корректный `TaskPlan`. После этого удалить `childOnEvent` из `plan-mode-handler.ts:207–224` и передавать `config.onEvent` напрямую.

### Phase 5 — Финальное упрощение handler: только thin adapter

После фаз 1–4 `execute()` в `plan-mode-handler.ts` должен сводиться примерно к:

```typescript
async execute(task, config, toolRegistry): Promise<TaskResult> {
  const profile = createPlanRuntimeProfile({ task, config, toolRegistry });
  return new AgentSDK()
    .registerRuntimeProfile(profile)
    .register(createCoreToolPack(toolRegistry))
    .createRunner(config)
    .execute(task);
}
```

Убрать emit-цепочки (строки 99–119, 267–349 — их берёт на себя SDK), `buildFallbackPlan` (строки 522+, перенести в `ResultMapper`), `loadPlan` (строки 393–400, перенести в `createPlanRuntimeProfile`). Целевой объём handler: **~50–80 строк** вместо 608.

---

## Risks

| Риск | Вероятность | Митигация |
|---|---|---|
| Сломать потребление `sharedBudget` при делегировании — sub-агенты перерасходуют токены | Средняя | После переноса spawnFn покрыть интеграционным тестом: 2 sub-агента с маленьким `maxTokens`, убедиться, что `allocate()` возвращает 0 при исчерпанном бюджете |
| `buildPlanPrompt` содержит edge-cases (`existingMarkdown`, разные `complexity`) — потерять их при переносе в `PromptProjector` | Низкая | Перенести тесты промпта из handler-части в `plan-profile.spec.ts` до удаления `buildPlanPrompt` |
| `childOnEvent` перехватывал `llm:end` как fallback — если `ResultMapper` не покроет этот случай, потеряем текст плана | Средняя | Юнит-тест `createPlanResultMapper` с mock без `plan` в метаданных; ожидаемый результат — `plan.markdown` содержит текст из summary |

---

## Verification

После каждой фазы убеждаемся, что сборка не ломается:

```
pnpm --filter @kb-labs/agents/core build
```

После всех фаз — полный набор тестов пакета:

```
pnpm --filter @kb-labs/agents/core test
```

Смоук-тест plan mode end-to-end (ожидаемый результат — в stdout появляется markdown план с `## Task` и `## Verification`):

```
pnpm --filter @kb-labs/agents/cli run dev -- --mode plan --task "list all exports in src/modes/"
```

Контроль размера handler (ожидаем ≤ 100 строк):

```
wc -l plugins/kb-labs-agents/packages/agent-core/src/modes/plan-mode-handler.ts
```

---

## Approval

План готов к проверке и согласованию.
