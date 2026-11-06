# UI Migration Plan: kb-labs-agents Studio Components
## Table of Contents
- [Task](#task)
- [Current State Analysis](#current-state-analysis)
  - [Проблемы AgentsPage.tsx](#проблемы-agentspagetsx)
  - [Проблемы ConversationView.tsx](#проблемы-conversationviewtsx)
  - [Проблемы conversation-view.css](#проблемы-conversation-viewcss)
- [Reference: commit-plugin Patterns](#reference-commit-plugin-patterns)
- [Migration Phases](#migration-phases)
  - [Phase 1 — AgentsPage.tsx: Layout и notifications _(приоритет: высокий)_](#phase-1-—-agentspagetsx-layout-и-notifications-приоритет-высокий)
  - [Phase 2 — ConversationView.tsx: UIKit-кнопки _(приоритет: высокий)_](#phase-2-—-conversationviewtsx-uikit-кнопки-приоритет-высокий)
  - [Phase 3 — conversation-view.css: токены темы _(приоритет: средний)_](#phase-3-—-conversation-viewcss-токены-темы-приоритет-средний)
  - [Phase 4 (опционально) — Новый компонент AgentControlBar](#phase-4-опционально-—-новый-компонент-agentcontrolbar)
- [Порядок выполнения](#порядок-выполнения)
- [Risks](#risks)
- [Verification](#verification)
## Task

**A → B:** Переписать Studio-компоненты агента (`plugins/kb-labs-agents/packages/agent-cli/src/studio/`) с самодельного CSS+raw-HTML подхода на единый UIKit (`@kb-labs/sdk/studio`) по образцу `kb-labs-commit-plugin`.

**Файлы под изменение:**
- `plugins/kb-labs-agents/packages/agent-cli/src/studio/pages/AgentsPage.tsx` (400 строк)
- `plugins/kb-labs-agents/packages/agent-cli/src/studio/components/ConversationView.tsx` (638 строк)
- `plugins/kb-labs-agents/packages/agent-cli/src/studio/components/conversation-view.css` (579 строк)
- `plugins/kb-labs-agents/packages/agent-cli/src/studio/pages/agents-page.css` (48 строк)
- `plugins/kb-labs-agents/packages/agent-cli/src/studio/components/SessionSelector.tsx` (95 строк) — **без изменений**, уже корректно использует UIKit

---

## Current State Analysis

### Проблемы AgentsPage.tsx

1. **Нет структурного layout-контейнера.** Вместо `UIPage + UIPageHeader` — `<div style={{ padding: 16 }}>` + `UICard` с inline-стилями (строки 256–280). Это ломает вертикальный ритм страницы и отступы относительно других плагинов в Studio.

2. **Inline-стили смешаны с токенами.** Строка 299: `borderTop: \`1px solid ${token.colorBorderSecondary}\`` — токен вставлен напрямую в inline style. Строки 271–284 содержат захардкоженные `padding: 0`, `overflow: 'hidden'` через `styles.body` вместо CSS-класса.

3. **Самодельная панель ввода.** `<div className="agent-input-box">` со своими border-radius/box-shadow (строки ~297–394). В commit-plugin аналогичная панель решается через `UICard size="small"` + `UIFlex`.

4. **`UIMessage.error()` вместо `useNotification()`** — строки 99, 162, 181, 183. `UIMessage` — глобальный синглтон, не знает о теме. commit-plugin использует `useNotification()`.

### Проблемы ConversationView.tsx

5. **Raw `<button all:unset>` повсюду** — обходят UIKit, ломают focus-rings и темную тему:
   - `FileChangesBlock` строки 183–194: `<button className="cv-changes-btn cv-changes-btn--approve">✓</button>`
   - `FileChangeRow` строки 272, 233, 252: `<button className="cv-change-main">` + row-actions
   - `CopyPath` строки 486–489: raw `<button className="cv-copy-path">`
   - `ToolRow` строки 556–559: raw `<button className="cv-tool-header">`

6. **`UIEmptyState` не используется** — вместо него `<div className="cv-empty">` (строки 27–32).

7. **Loading state** (строки 19–23): `<UISpin size="small"> + <span style={{marginLeft:8,color:'#999',fontSize:13}}>` — inline стили, непоследовательно со стандартом.

### Проблемы conversation-view.css

8. **Захардкоженные hex-цвета как фоллбэки в 90% правил** — не реагируют на смену темы:
   - `var(--bg-tertiary, #F3F4F6)`, `var(--border-primary, #E5E7EB)` — не Ant Design переменные
   - `var(--success, #16A34A)`, `var(--error, #DC2626)`, `var(--link, #2563EB)` — тоже не Ant
   - `.cv-tool-output--terminal` строки 222–226: захардкожен `background: #1a1a1a; color: #d4d4d4`

---

## Reference: commit-plugin Patterns

Из `plugins/kb-labs-commit-plugin/packages/commit-cli/src/studio/`:

| Паттерн | Commit-plugin | Нужно в Agent |
|---|---|---|
| Page layout | `UIPage > UIPageHeader` (CommitOverview.tsx:49–66) | То же для AgentsPage |
| Spacing | `token.marginSM` из `theme.useToken()` | Заменить inline padding |
| Notifications | `const notify = useNotification()` (CommitPlanTab.tsx:51) | Заменить `UIMessage.*` |
| Empty state | `UIEmptyState` с `description` prop (CommitPlanTab.tsx:178) | Заменить `<div className="cv-empty">` |
| Кнопки | `UIButton`, `UIPopconfirm` — нет ни одного raw `<button>` | Везде в ConversationView |
| Статус-метки | `UIBadge`, `UITag` | Для `cv-changes-op` меток new/mod/del |
| Flex layout | `UIFlex justify="between" align="center"` | В FileChangesBlock header |

---

## Migration Phases

### Phase 1 — AgentsPage.tsx: Layout и notifications _(приоритет: высокий)_

Это главная причина "кривого" вида — страница не вписана в стандартный layout Studio.

**1.1** — `plugins/kb-labs-agents/packages/agent-cli/src/studio/pages/AgentsPage.tsx` строки 255–285: заменить `<div style={{ padding: 16 }}>` + `UICard` на обёртку `<UIPage><UIPageHeader title="Agent" actions={<SessionSelector .../>}>`. Добавить импорт `UIPage, UIPageHeader, UIFlex, useNotification` из `@kb-labs/sdk/studio`. Убрать все inline-стили из `UICard` (`style`, `styles.body`).

**1.2** — `AgentsPage.tsx` строки 99, 162, 181, 183: заменить `UIMessage.error(...)` / `UIMessage.info(...)` на `const notify = useNotification()` + `notify.error(...)` / `notify.info(...)` — по образцу `CommitPlanTab.tsx:51`.

**1.3** — `AgentsPage.tsx` строки ~297–394 (input area): заменить `<div className="agent-input-box">` на `UICard size="small"` с `UIFlex direction="column"` внутри для textarea + controls.

**1.4** — `plugins/kb-labs-agents/packages/agent-cli/src/studio/pages/agents-page.css`: оставить только override для border-radius `UIInputTextArea`, остальное удалить (панель теперь через UIKit).

---

### Phase 2 — ConversationView.tsx: UIKit-кнопки _(приоритет: высокий)_

Raw кнопки — главная причина визуальной несогласованности. Они не получают :hover/:focus стилей из темы.

**2.1** — `plugins/kb-labs-agents/packages/agent-cli/src/studio/components/ConversationView.tsx` строки 183–194 (`FileChangesBlock`): заменить raw `<button className="cv-changes-btn cv-changes-btn--approve">✓</button>` на `<UIButton size="small" type="text" icon={<UIIcon name="CheckOutlined"/>} onClick={handleApprove} loading={approve.isLoading}/>`. Rollback: `<UIButton size="small" danger type="text" icon={<UIIcon name="CloseOutlined"/>} loading={rollback.isLoading}/>`.

**2.2** — `ConversationView.tsx` строки ~233, 252 (`FileChangeRow` row-actions): per-file кнопки approve/rollback — `<UIButton size="small" type="text" icon={...}/>`. Удалить CSS-класс `cv-change-row-actions` (строки 531–538 в CSS).

**2.3** — `ConversationView.tsx` строка 272 (`FileChangeRow` main row): `<button className="cv-change-main">` → `<UIButton type="text" block style={{ textAlign: 'left', height: 'auto', padding: '3px 0' }}>` с `UIFlex align="center" gap="small"` внутри.

**2.4** — `ConversationView.tsx` строки 486–489 (`CopyPath`): raw `<button>` → `<UIButton type="link" size="small" onClick={handleClick}>`.

**2.5** — `ConversationView.tsx` строки 556–559 (`ToolRow` header): raw `<button className="cv-tool-header">` → `<UIButton type="text" onClick={...} disabled={!canExpand} style={{ padding: 0, height: 'auto', lineHeight: 'inherit' }}>`.

**2.6** — `ConversationView.tsx` строки 27–32: `<div className="cv-empty">` → `<UIEmptyState description="Ask anything to get started" />`.

**2.7** — `ConversationView.tsx` строки 19–23: `<div className="cv-empty"><UISpin size="small"/> <span...>` → `<UISpin size="large" style={{ display: 'block', margin: '48px auto' }}/>`.

---

### Phase 3 — conversation-view.css: токены темы _(приоритет: средний)_

Пока Phase 1–2 устраняют функциональные проблемы, Phase 3 исправляет темную тему и согласованность цветов.

**3.1** — В `plugins/kb-labs-agents/packages/agent-cli/src/studio/components/conversation-view.css` заменить все кастомные переменные на Ant Design:

```css
/* БЫЛО → СТАЛО */
var(--text-primary, #111827)    → var(--ant-color-text)
var(--text-secondary, #6B7280)  → var(--ant-color-text-secondary)
var(--text-tertiary, #9CA3AF)   → var(--ant-color-text-tertiary)
var(--bg-secondary, #fff)       → var(--ant-color-bg-container)
var(--bg-tertiary, #F3F4F6)     → var(--ant-color-fill-quaternary)
var(--border-primary, #E5E7EB)  → var(--ant-color-border-secondary)
var(--success, #16A34A)         → var(--ant-color-success)
var(--error, #DC2626)           → var(--ant-color-error)
var(--link, #2563EB)            → var(--ant-color-primary)
```

**3.2** — `.cv-tool-output--terminal` строки 222–226: убрать `background: #1a1a1a; color: #d4d4d4`. Использовать `var(--ant-color-bg-spotlight)` для background и `var(--ant-color-text-base)` для текста.

**3.3** — После Phase 2 удалить мёртвые CSS-классы из `conversation-view.css`:
   - Строки 425–467: `.cv-changes-btn`, `.cv-changes-btn--approve`, `.cv-changes-btn--rollback`, `.cv-changes-btn--sm`
   - Строки 531–538: `.cv-change-row-actions`
   - Строки 131–146: `.cv-tool-header`, `.cv-tool-header--clickable`
   - Строки 234–247: `.cv-copy-path`

---

### Phase 4 (опционально) — Новый компонент AgentControlBar

**4.1** — Создать `plugins/kb-labs-agents/packages/agent-cli/src/studio/components/AgentControlBar.tsx`: вынести из `AgentsPage.tsx` строки 300–393 (tier/responseMode/escalation селекторы + Stop/Send кнопки). Уменьшит `AgentsPage.tsx` примерно на 100 строк и упростит его читаемость.

**4.2** — Экспортировать `AgentControlBar` через `AgentsPage.tsx` imports; проп-интерфейс: `{ tier, setTier, responseMode, setResponseMode, enableEscalation, setEnableEscalation, isRunning, onStart, onStop }`.

---

## Порядок выполнения

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 (опц.)
```

Каждая фаза — отдельный PR, изменения независимы. Phase 1 даёт наибольший видимый эффект сразу.

---

## Risks

| Риск | Митигация |
|---|---|
| `UIPageHeader` не имеет `actions` prop | Проверить тип `UIPageHeader` в `platform/kb-labs-sdk`; если нет — использовать `UIFlex` в `title` prop как в CommitOverview.tsx:51–65 |
| `--ant-color-fill-quaternary` отсутствует в текущей версии Ant Design | `grep -r "fill-quaternary" platform/kb-labs-sdk/` перед заменой; фоллбэк — `--ant-color-bg-layout` |
| Удаление CSS-классов сломает что-то ещё | `grep -r "cv-changes-btn\|cv-copy-path\|cv-tool-header" plugins/` перед удалением |
| `UIButton type="text" block` меняет поведение клика FileChangeRow | Проверить вручную expand/collapse diff при клике |

---

## Verification

```bash
# Собрать agent-cli после изменений
pnpm --filter @kb-labs/agents/cli build

# Запустить тесты
pnpm --filter @kb-labs/agents/cli test

# TypeScript-проверка (нет сломанных импортов, нет any)
pnpm --filter @kb-labs/agents/cli typecheck

# Убедиться что commit-plugin не сломан
pnpm --filter @kb-labs/commit/cli build

# Проверить отсутствие мёртвых CSS-классов после Phase 3
grep -r "cv-changes-btn\|cv-copy-path\|cv-tool-header--clickable" plugins/kb-labs-agents/packages/agent-cli/src/
```

---

**План готов к согласованию. Фазы 1–3 обязательны и дают полный визуальный рефакторинг. Фаза 4 опциональна, улучшает maintainability. Рекомендую начать с Phase 1 — она даёт наибольший видимый эффект и независима от остальных.**
