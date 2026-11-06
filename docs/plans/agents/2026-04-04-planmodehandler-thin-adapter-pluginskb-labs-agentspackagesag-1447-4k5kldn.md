The plan is confirmed via auto-answer. Here is the final deliverable presented directly:

---

# Refactor: PlanModeHandler → Thin Adapter
## Table of Contents
- [Task](#task)
- [Current state](#current-state)
- [Steps](#steps)
  - [Phase 1 — Выделить `SharedTokenBudget` и устранить дубликат](#phase-1-—-выделить-sharedtokenbudget-и-устранить-дубликат)
  - [Phase 2 — Создать `PlanOrchestrator` с ownership сессии и персистенции](#phase-2-—-создать-planorchestrator-с-ownership-сессии-и-персистенции)
  - [Phase 3 — Редуцировать `PlanModeHandler` до thin adapter](#phase-3-—-редуцировать-planmodehandler-до-thin-adapter)
  - [Phase 4 — Обновить экспорты](#phase-4-—-обновить-экспорты)
- [Risks](#risks)
- [Verification](#verification)
- [Approval](#approval)
## Task

**A (сейчас):** `PlanModeHandler` — монолитный класс (608 строк) с тремя зонами ответственности: бизнес-логика (бюджет, делегирование, ownership сессии/персистенции), оркестровка (`planWriterRegistry`, `planTaskMw`, `planRunner`, sub-agents) и адаптер (events, `TaskResult` mapping).

**B (цель):** `PlanModeHandler` — тонкий адаптер (~15–20 строк), который только читает `AgentConfig`/`ToolRegistry`, вызывает `PlanOrchestrator.run(...)` и пробрасывает `TaskResult`. Вся логика — включая **ownership сессии и персистенция артефактов** — переезжает в `PlanOrchestrator`.

---

## Current state

| Что | Строки в `plan-mode-handler.ts` |
|-----|--------------------------------|
| `SharedTokenBudget` — inline private-класс (owner бюджета) | 32–55 |
| `SessionManager` — создание + `sessionId` + путь к `plan.json` | 66–67, 72 |
| `PlanDocumentService` — путь к markdown-артефакту | 284 |
| Инициализация complexity, `planProfile`, бюджетов | 64–96 |
| `planTaskMw.setSpawnFn` — спаун sub-agents + `sharedBudget.consume` | 127–185 |
| Создание `planWriterRegistry` и `planRunner` | 187–247 |
| Запуск + сбор `reportedPlanText` + emit events | 249–361 |
| `loadPlan`, `buildFallbackPlan`, `createSubRunner` | 393–520 |
| `shouldEnablePlanDelegation`, `buildPlanAllowedTools` (**дубликат!**) | 580–607 |

`plan-profile.ts` уже чистый: `createPlanRuntimeProfile` (строки 92–135) и `shouldEnablePlanDelegation` (строки 191–202) — последняя продублирована в конце `plan-mode-handler.ts`.

---

## Steps

### Phase 1 — Выделить `SharedTokenBudget` и устранить дубликат

`SharedTokenBudget` (строки 32–55) — самостоятельный компонент без зависимостей от ModeHandler, но захоронен как private inline-класс. Его нужно вынести первым, до создания `PlanOrchestrator`.

**1.1.** Создать `plugins/kb-labs-agents/packages/agent-core/src/modes/plan-token-budget.ts` — перенести `SharedTokenBudget` и экспортировать. В `plan-mode-handler.ts` заменить inline-определение на `import { SharedTokenBudget } from './plan-token-budget.js'`.

**1.2.** Удалить `shouldEnablePlanDelegation` и `buildPlanAllowedTools` (строки 580–607 `plan-mode-handler.ts`) — они дублируют `plan-profile.ts:191–202`. Вызовы на строках 70–71 заменить на `import { shouldEnablePlanDelegation } from './plan-profile.js'`.

---

### Phase 2 — Создать `PlanOrchestrator` с ownership сессии и персистенции

`PlanOrchestrator` становится единственным владельцем `SessionManager`, `PlanDocumentService` и `SharedTokenBudget`. После этого handler не знает ни о сессии, ни об артефактах.

**2.1.** Создать `plugins/kb-labs-agents/packages/agent-core/src/modes/plan-orchestrator.ts`:

```ts
export class PlanOrchestrator {
  async run(task: string, config: AgentConfig, toolRegistry: ToolRegistry): Promise<TaskResult>
}
```

**2.2.** Переместить из `plan-mode-handler.ts` в `PlanOrchestrator.run()`:
- Строки 66–67: `new SessionManager(config.workingDir)` + вычисление `sessionId`.
- Строки 72–73: `sessionManager.getSessionPlanPath(sessionId)` + `loadPlan(...)` (метод 393–400).
- Строки 74–96: `createPlanRuntimeProfile`, расчёт итераций и бюджетов.
- Строки 127–185: `planTaskMw.setSpawnFn` со `sharedBudget.consume` для sub-agents.
- Строки 187–247: `planWriterRegistry`, `childOnEvent`, `planRunner`.
- Строки 249–287: выполнение, `new PlanDocumentService(config.workingDir)` (строка 284), `artifactPaths`.
- Строки 252–361: валидация и маппинг `TaskResult` (включая `filesCreated: [planPath, documentPath]`).
- Методы: `buildFallbackPlan` (522–579), `createSubRunner` (515–520).

**2.3.** Emit events (`config.onEvent`) оставить в `PlanOrchestrator` — они часть оркестрационной логики, не адаптера.

---

### Phase 3 — Редуцировать `PlanModeHandler` до thin adapter

**3.1.** Переписать `plugins/kb-labs-agents/packages/agent-core/src/modes/plan-mode-handler.ts`:

```ts
export class PlanModeHandler implements ModeHandler {
  private readonly orchestrator = new PlanOrchestrator();

  async execute(task: string, config: AgentConfig, toolRegistry: ToolRegistry): Promise<TaskResult> {
    return this.orchestrator.run(task, config, toolRegistry);
  }
}
```

Файл сократится с 608 строк до ~15–20 строк. Импорты — только `ModeHandler`, `AgentConfig`, `ToolRegistry`, `TaskResult`, `PlanOrchestrator`.

---

### Phase 4 — Обновить экспорты

**4.1.** Добавить `export { PlanOrchestrator }` в `plugins/kb-labs-agents/packages/agent-core/src/modes/index.ts`. `PlanModeHandler` остаётся публичным — его внешний контракт не меняется.

**4.2.** Убедиться, что `plan-token-budget.ts` и `plan-orchestrator.ts` подхватываются `tsconfig` пакета.

---

## Risks

| Риск | Вероятность | Митигация |
|------|------------|-----------|
| `sharedBudget.consume()` вызывается из нескольких замыканий — порядок критичен | Средняя | `sharedBudget` — локальная переменная `run()`, не поле класса |
| `reportedPlanText` (строки 206–224) пишется в замыкании `childOnEvent` | Низкая | Объявить `let reportedPlanText = ''` внутри `run()` перед `childOnEvent` |
| Дубликат `shouldEnablePlanDelegation` — при удалении проверить все вызовы | Низкая | `grep -n shouldEnablePlanDelegation plan-mode-handler.ts` перед удалением |
| `sessionId` генерируется с `Date.now()` (строка 67) — логика должна переехать без изменений | Низкая | Перенести строки 66–67 как есть |

---

## Verification

```bash
# Сборка пакета после рефакторинга
pnpm --filter @kb-labs/agents/core build

# Запуск тестов пакета
pnpm --filter @kb-labs/agents/core test

# Проверка типов без сборки
pnpm --filter @kb-labs/agents/core exec tsc --noEmit

# Убедиться, что дубликат shouldEnablePlanDelegation удалён из handler
grep -n "shouldEnablePlanDelegation" plugins/kb-labs-agents/packages/agent-core/src/modes/plan-mode-handler.ts

# Убедиться, что plan-mode-handler.ts стал тонким адаптером (< 30 строк)
wc -l plugins/kb-labs-agents/packages/agent-core/src/modes/plan-mode-handler.ts
```

---

## Approval

План готов к ревью и исполнению. Жду подтверждения.
