---
name: workflow
description: Workflow engine investigation, debugging, and development — logs, gate decisions, runs CLI
globs:
  - "plugins/workflow/**"
---

# Workflow Investigation & Development

## Быстрое расследование инцидента

### 1. Найти упавшие раны
```bash
kb workflow runs-list --status=failed --limit=20
```

### 2. Посмотреть дерево шагов
```bash
kb workflow runs-view <runId>
```
Показывает: jobs → steps с иконками ✓/✗/⠿, длительность, gate decisions, ошибки.

### 3. Получить логи упавшего шага (ключевая команда)
```bash
kb workflow runs-view <runId> --log-failed
```
Фильтрует только error/warn + сообщения с `[gate]`/`[approval]` — минимум шума.

### 4. Стримить в реальном времени
```bash
kb workflow runs-watch <runId>
```
SSE-поток событий, выходит при `run.finished`/`run.failed`.

### 5. Перезапустить ран
```bash
kb workflow runs-rerun <runId>
```

### 6. JSON для агентов
```bash
kb workflow runs-view <runId> --json=status,jobs
kb workflow runs-view <runId> --json=all
```

---

## Структура логов (что искать при расследовании)

### Lifecycle событий

| Событие | Уровень | Поле | Значение |
|---|---|---|---|
| Job из очереди | `info` | `msg` | `"Job picked from queue"` |
| Job стартовал | `info` | `msg` | `"Job started"` |
| Step пропущен | `info` | `msg` | `"[step] Skipped: condition evaluated to false"` |
| Handler resolved | `debug` | `msg` | `"[runner] Resolved handler"` |
| Step timeout | `error` | `msg` | `"[runner] Step timed out"` |
| Step failed | `error` | `msg` | `"Step failed"` |

### Gate события (`builtin:gate`)

| Событие | Уровень | Что смотреть |
|---|---|---|
| Gate evaluated | `info` | `expression`, `resolvedDecision`, `availableRoutes`, `selectedRoute`, `action` |
| Gate → fail | `error` | `decision`, `failReason`, `inputs` |
| Gate → restart | `warn` | `decision`, `restartFrom`, `iteration`, `maxIterations`, `stepsToReset` |
| Gate → continue | `info` | `decision`, `selectedRoute` |
| No matching route | `warn` | `decision`, `availableRoutes`, `defaultAction` |
| Step reset | `debug` | `stepId`, `stepName`, `stepIndex` |
| Re-enqueued | `info` | `runId`, `jobId`, `iteration` |

### Approval события (`builtin:approval`)

| Событие | Уровень | Что смотреть |
|---|---|---|
| Approval started | `warn` | `"Approval has no timeout configured"` (если нет timeout) |
| Heartbeat каждые ~20с | `info` | `waitedMs`, `approvalId` |
| Approved/Rejected | `info`/`warn` | итог |

### Step failure: ключевые поля

```
resolvedInputs  — что реально пришло в шаг в момент падения
durationMs      — сколько работал
errorCode       — код ошибки (напр. TIMEOUT)
attempt         — попытка (при retry)
stepName        — имя шага (не только id)
stepIndex       — номер шага в job
```

---

## Архитектура workflow

```
Daemon (:7778)
  └── worker.ts        — job execution, gate/approval builtins, stepLogger
  └── server.ts        — HTTP API (/api/v1/runs, /api/v1/jobs, /metrics, SSE)

Engine
  └── engine.ts        — job state machine, markJobFailed, markJobCompleted
  └── run-coordinator  — concurrency, locks

Runtime
  └── sandbox-runner.ts — handler resolution (plugin/command/builtin), timeout, resolver log

Entry (CLI commands)
  └── http-client.ts   — WorkflowDaemonClient (listRuns, getRun, getRunLogs, SSE)
  └── commands/runs-*  — runs-list, runs-view, runs-watch, runs-rerun
  └── commands/        — start, stop, status, logs, trigger, etc.
```

### API response shape

```typescript
// GET /api/v1/runs        → { ok: true, data: { runs: [...] } }
// GET /api/v1/runs/:id    → { ok: true, data: { run: {...} } }
// GET /api/v1/runs/:id/logs → { ok: true, data: { logs: [...] } }
// GET /api/v1/jobs        → { ok: true, data: { jobs: [...] } }
// GET /metrics            → { runs: {...}, jobs: {...} }
```

WorkflowDaemonClient.unwrapData() снимает `{ ok, data }` обёртку автоматически.

---

## Разработка новых команд

```typescript
import { defineCommand, type CLIInput, type PluginContextV3 } from '@kb-labs/sdk';

interface MyFlags {
  json?: boolean;
  status?: string;
}

export default defineCommand<unknown, CLIInput<MyFlags>, { exitCode: number }>({
  id: 'workflow:my-command',
  handler: {
    async execute(ctx: PluginContextV3, input: CLIInput<MyFlags>) {
      const { flags, argv = [] } = input;
      // flags.json → boolean | undefined
    }
  }
});
```

**Критично:** использовать `CLIInput<FlagsInterface>` из `@kb-labs/sdk`, не `typeof flagsDef` и не ручные cast'ы.

После добавления команды — зарегистрировать в `plugins/workflow/entry/src/manifest.ts`.

---

## Сборка после изменений

```bash
kb-devkit run build --packages=@kb-labs/workflow-entry,@kb-labs/workflow-daemon
```
